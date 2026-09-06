"""A gradebook and a bank written before mastery levels existed must still open,
score, and export -- unchanged, without a migration step.

Every field added for mastery is optional with a default, so the check that
matters is not "does pydantic accept it" but "does a file that predates the
feature still produce the same numbers it always did". These tests build a
current file, strip every new key back out of it on disk, and put it through the
whole pipeline.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import pytest

from app.backend.gradebook_service import GradebookService
from app.backend.models import UpsertStudentRequest
from app.backend.service import BankWorkspaceService
from app.backend.tests.test_gradebook_performance_export import (
    EASY_MC,
    HARD_MC,
    _hand_off,
    _mc_sheet_image,
)
from app.backend.tests.grading_test_utils import png_bytes

# Everything the mastery work added to a persisted file.
SNAPSHOT_ADDITIONS = ("lineage_id",)
ANSWER_KEY_ADDITIONS = ("difficulty", "rubric_components")
ROW_RESULT_ADDITIONS = ("component_scores",)


def _strip(payload: dict, keys: tuple[str, ...]) -> dict:
    for key in keys:
        payload.pop(key, None)
    return payload


def _age_the_gradebook(nxgb_path: Path, target: Path) -> Path:
    """Rewrite a .nxgb as one written before any of this existed."""

    workspace = target / "unpacked"
    with zipfile.ZipFile(nxgb_path) as archive:
        archive.extractall(workspace)

    # mastery.json is new -- a gradebook from before simply has no such file.
    (workspace / "mastery.json").unlink(missing_ok=True)

    for snapshot_path in workspace.glob("snapshots/*/snapshot.json"):
        snapshot = json.loads(snapshot_path.read_text())
        _strip(snapshot, SNAPSHOT_ADDITIONS)
        for key in [snapshot["answer_key"], *snapshot.get("alternate_answer_keys", [])]:
            for item in key["items"]:
                _strip(item, ANSWER_KEY_ADDITIONS)
        for question in snapshot.get("questions", []):
            for row in question.get("rubric", []):
                row.pop("difficulty", None)
        snapshot_path.write_text(json.dumps(snapshot, indent=2))

    for batch_path in workspace.glob("batches/*.json"):
        batch = json.loads(batch_path.read_text())
        for sheet in batch["sheets"]:
            for row in sheet["row_results"]:
                _strip(row, ROW_RESULT_ADDITIONS)
        batch_path.write_text(json.dumps(batch, indent=2))

    aged = target / "aged.nxgb"
    with zipfile.ZipFile(aged, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry in sorted(workspace.rglob("*")):
            if entry.is_file():
                archive.write(entry, entry.relative_to(workspace))
    return aged


@pytest.fixture
def aged_gradebook(bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path):
    """A saved gradebook with one scanned, identified sheet -- then stripped of
    every field the mastery work introduced."""

    bank_service.open_bank(str(demo_bok))
    service = GradebookService()
    service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    ada = service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace", section="Period 2")
    )
    snapshot = _hand_off(bank_service, service, [EASY_MC, HARD_MC], "Unit 1 Forces")
    batch = service.create_scan_batch(snapshot.id, None)
    updated = service.ingest_scan_batch(
        batch.id, [("sheet.png", png_bytes(_mc_sheet_image(snapshot, {EASY_MC})))]
    )
    service.resolve_sheet_identity(batch.id, updated.sheets[0].id, student_id=ada.id)
    saved = Path(service.save_gradebook())

    aged_dir = tmp_path / "aged"
    aged_dir.mkdir()
    aged_path = _age_the_gradebook(saved, aged_dir)

    reopened = GradebookService()
    reopened.open_gradebook(str(aged_path))
    return bank_service, reopened, ada


def test_an_old_gradebook_still_opens(aged_gradebook) -> None:
    _, service, _ = aged_gradebook
    assert service.get_summary().manifest.title == "Period 2"
    assert len(service.list_students().items) == 1


def test_an_old_snapshot_gets_its_lineage_from_its_title(aged_gradebook) -> None:
    """`lineage_id` is derived from the title rather than assigned, which is what
    lets a file that never stored one group exactly as a new file would."""

    _, service, _ = aged_gradebook
    summaries = service.list_administered_tests().items
    assert len(summaries) == 1
    assert summaries[0].lineage_id  # resolved, not blank

    stored = service.get_snapshot(summaries[0].id)
    assert stored.lineage_id is None  # nothing was written into the old file
    # ... yet the report finds it under the same lineage a new file would use.
    combined = service.get_combined_lineage_report(test_title="Unit 1 Forces")
    assert combined.lineage_id == summaries[0].lineage_id
    assert combined.scored_sheet_count == 1


def test_an_old_gradebook_gets_the_default_mastery_settings(aged_gradebook) -> None:
    """No mastery.json means the defaults, which is also what the gradebook was
    already being reported under."""

    _, service, _ = aged_gradebook
    config = service.get_mastery_config()
    assert config.default.calculation == "level_ladder"
    assert config.default.reporting == "half_steps"
    assert config.by_lineage == {}


def test_an_old_gradebook_still_scores_and_reports(aged_gradebook) -> None:
    _, service, ada = aged_gradebook

    batch = service.list_scan_batches().items[0]
    report = service.get_grade_report(batch.id)
    assert report.scored_sheet_count == 1
    assert report.student_scores[0].student_id == ada.id
    assert report.student_scores[0].percent_correct == pytest.approx(50.0)

    record = service.get_one_student_performance(ada.id)
    assert record.tests_taken == 1
    assert record.percent_correct == pytest.approx(50.0)


def test_an_old_gradebook_still_exports_every_csv_shape(aged_gradebook) -> None:
    _, service, _ = aged_gradebook
    for method in ("total", "by_standard", "mastery"):
        csv_text, filename = service.export_scores_csv(method, "most_recent")
        assert "Lovelace" in csv_text
        assert filename.endswith(".csv")


def test_mastery_on_an_old_gradebook_reads_low_rather_than_wrong(aged_gradebook) -> None:
    """The one number that cannot be recovered from an old file is difficulty,
    so mastery falls to the bottom of the scale rather than inventing a rung.
    The plain score, which needs no difficulty, is unaffected."""

    _, service, ada = aged_gradebook
    entry = next(
        e
        for e in service.get_one_student_performance(ada.id).by_standard
        if e.standard_id == "PHY-KIN-01"
    )
    assert entry.percent_earned == pytest.approx(50.0)
    assert entry.mastery.scale_max == 1


def test_rescanning_into_an_old_gradebook_records_the_new_fields(aged_gradebook) -> None:
    """Old data stays as it is; new work gets the new fields. The two coexist in
    one file rather than the file needing a migration first."""

    bank_service, service, _ = aged_gradebook
    fresh = _hand_off(bank_service, service, [EASY_MC, HARD_MC], "Unit 2 Energy")
    assert fresh.lineage_id is not None
    assert [item.difficulty for item in fresh.answer_key.items] == [2, 3]

    # The listing is newest first, so the last row is the pre-existing printing.
    oldest = service.list_administered_tests().items[-1]
    assert oldest.title == "Unit 1 Forces"
    stored = service.get_snapshot(oldest.id)
    assert stored.lineage_id is None  # untouched on disk
    assert stored.answer_key.items[0].difficulty is None
    # ...and still reported, because the lineage resolves from the title.
    assert oldest.lineage_id


# -- Banks --------------------------------------------------------------------


def test_a_bank_whose_rubrics_have_no_difficulties_is_unchanged(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """`RubricRowModel.difficulty` is optional and read by nothing except Rubric
    Levels, so a bank that never sets it round-trips untouched."""

    bank_service.open_bank(str(demo_bok))
    before = bank_service.get_question("q_fr_0001")
    assert all(row.difficulty is None for row in before.rubric)

    saved = tmp_path / "resaved.bok"
    bank_service.save_bank(str(saved))

    reopened = BankWorkspaceService()
    reopened.open_bank(str(saved))
    after = reopened.get_question("q_fr_0001")
    assert [(r.criterion, r.points) for r in after.rubric] == [
        (r.criterion, r.points) for r in before.rubric
    ]
    assert all(row.difficulty is None for row in after.rubric)


def test_a_bank_json_file_written_before_component_difficulty_existed_loads(
    demo_bok: Path, tmp_path: Path
) -> None:
    """The on-disk shape, not just the in-memory model: a rubric row that is
    literally `{"criterion": ..., "points": ...}` still parses."""

    from app.backend.models import QuestionModel

    question = QuestionModel.model_validate(
        {
            "id": "q_test_0001",
            "type": "free_response",
            "topic": "Forces",
            "difficulty": 3,
            "prompt": "Explain.",
            "rubric": [{"criterion": "Sets up correctly", "points": 4}],
        }
    )
    assert question.rubric[0].difficulty is None
