"""Cross-test student performance, retake resolution, and CSV export.

The other gradebook reporting tests all live inside one batch. These are about
what happens across batches, across tests, and across a student's retakes.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest

from app.backend.gradebook_service import GradebookService
from app.backend.grading.aggregate import build_student_performance, standards_from_rows
from app.backend.grading.lineage import lineage_id_for_title
from app.backend.grading.scoring import score_sheet
from app.backend.models import RubricRowModel, UpsertStudentRequest
from app.backend.service import BankWorkspaceError, BankWorkspaceService
from app.backend.tests.grading_test_utils import fill_cells, png_bytes, rasterize_layout_page


# Both tagged PHY-KIN-01, difficulty 2 and 3 -- so a student who gets one right
# and the other wrong scores 50% on the standard either way, but a different
# difficulty-weighted mastery depending on which one they got.
EASY_MC = "q_mc_0001"
HARD_MC = "q_mc_0008"


def _hand_off(bank_service, gradebook_service, question_ids, title, version="A"):
    detail = bank_service.create_test_draft(title, version)
    for question_id in question_ids:
        detail = bank_service.add_question_to_test(detail.test.id, question_id)
    return gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )


def _mc_sheet_image(snapshot, correct_question_ids, dpi=300):
    """A filled-in sheet: the named questions answered correctly, the rest
    answered with a deliberately wrong choice."""

    image = rasterize_layout_page(snapshot.layout, 0, dpi)
    rows_by_question = {row.question_id: row for row in snapshot.layout.pages[0].rows}

    for item in snapshot.answer_key.items:
        row = rows_by_question[item.question_id]
        correct_index = item.correct_choice_indices[0]
        if item.question_id in correct_question_ids:
            index = correct_index
        else:
            index = next(i for i in range(item.choice_count) if i != correct_index)
        fill_cells(image, snapshot.layout, [row.cells[index]], dpi)
    return image


def _scan(gradebook_service, snapshot, correct_question_ids, student_id, description=None):
    batch = gradebook_service.create_scan_batch(snapshot.id, description)
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("sheet.png", png_bytes(_mc_sheet_image(snapshot, correct_question_ids)))]
    )
    gradebook_service.resolve_sheet_identity(batch.id, updated.sheets[0].id, student_id=student_id)
    return batch


@pytest.fixture
def open_gradebook(bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path):
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    return bank_service, gradebook_service


def _read_csv(text: str) -> tuple[list[str], list[list[str]]]:
    rows = list(csv.reader(io.StringIO(text)))
    return rows[0], rows[1:]


# -- The frozen key carries difficulty ---------------------------------------


def test_answer_key_freezes_question_difficulty(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Unit 1")

    difficulty_by_question = {
        item.question_id: item.difficulty for item in snapshot.answer_key.items
    }
    assert difficulty_by_question == {EASY_MC: 2, HARD_MC: 3}


def test_mastery_never_guesses_upward_when_the_key_predates_difficulty(open_gradebook) -> None:
    """A gradebook written before difficulty was frozen still reports mastery.
    Items with no recorded level sit at the bottom of the scale, never higher:
    guessing upward would claim a rung nobody has evidence for."""

    bank_service, gradebook_service = open_gradebook
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Unit 1")

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("sheet.png", png_bytes(_mc_sheet_image(snapshot, {EASY_MC})))]
    )

    # Score the in-memory key with difficulty stripped: the point is the key,
    # not what is on disk.
    for item in snapshot.answer_key.items:
        item.difficulty = None
    rows = score_sheet(updated.sheets[0], snapshot.answer_key).rows
    by_standard = {entry.standard_id: entry for entry in standards_from_rows(rows)}
    mastery = by_standard["PHY-KIN-01"].mastery
    # Both items fall back to level 1, one right and one wrong -> 50% of a
    # single rung, which the ladder reports as progress into level 1.
    assert [entry.level for entry in mastery.levels] == [1]
    assert mastery.level_exact == pytest.approx(0.5)


# -- Lineage linking ----------------------------------------------------------


def test_snapshots_of_the_same_title_share_a_lineage(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    first = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Mechanics", "A")
    second = _hand_off(bank_service, gradebook_service, [EASY_MC], "unit 1 mechanics ", "B")

    assert first.lineage_id == second.lineage_id == lineage_id_for_title("Unit 1 Mechanics")


def test_a_differently_titled_retake_can_be_linked_by_hand(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    original = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Mechanics")
    retake = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Retake")
    assert retake.lineage_id != original.lineage_id

    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    _scan(gradebook_service, original, set(), ada.id)
    _scan(gradebook_service, retake, {EASY_MC}, ada.id)

    before = gradebook_service.get_one_student_performance(ada.id)
    assert before.tests_taken == 2  # two separate tests, one of them never passed

    summary = gradebook_service.relink_snapshot_lineage(
        retake.id, lineage_of_snapshot_id=original.id, lineage_id=None
    )
    assert summary.lineage_id == original.lineage_id

    after = gradebook_service.get_one_student_performance(ada.id, "highest")
    assert after.tests_taken == 1
    lineage = after.lineages[0]
    assert [attempt.attempt_number for attempt in lineage.attempts] == [1, 2]
    assert lineage.resolved.percent_correct == 100.0

    # Clearing the link puts it back under its own title.
    reverted = gradebook_service.relink_snapshot_lineage(
        retake.id, lineage_of_snapshot_id=None, lineage_id=None
    )
    assert reverted.lineage_id == lineage_id_for_title("Unit 1 Retake")
    assert gradebook_service.get_one_student_performance(ada.id).tests_taken == 2


def test_relinking_leaves_the_printed_record_untouched(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    original = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Mechanics")
    retake = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Unit 1 Retake")

    gradebook_service.relink_snapshot_lineage(
        retake.id, lineage_of_snapshot_id=original.id, lineage_id=None
    )

    reloaded = gradebook_service.get_snapshot(retake.id)
    assert reloaded.title == "Unit 1 Retake"
    assert reloaded.answer_key == retake.answer_key
    assert reloaded.layout == retake.layout
    assert reloaded.printed_at == retake.printed_at


# -- Retake resolution --------------------------------------------------------


@pytest.fixture
def retake_gradebook(open_gradebook):
    """Ada sits the same two-question test twice: 0% first, then 100%."""

    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace", section="Period 2")
    )
    first = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Unit 1", "A")
    second = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Unit 1", "B")
    _scan(gradebook_service, first, set(), ada.id, "first sitting")
    _scan(gradebook_service, second, {EASY_MC, HARD_MC}, ada.id, "retake")
    return gradebook_service, ada


@pytest.mark.parametrize(
    ("resolution", "expected_percent", "expected_sources"),
    [
        ("most_recent", 100.0, [2]),
        ("highest", 100.0, [2]),
        ("average", 50.0, [1, 2]),
    ],
)
def test_retake_resolution_picks_the_score_that_counts(
    retake_gradebook, resolution, expected_percent, expected_sources
) -> None:
    gradebook_service, ada = retake_gradebook
    performance = gradebook_service.get_one_student_performance(ada.id, resolution)

    assert performance.attempt_count == 2
    assert performance.tests_taken == 1
    resolved = performance.lineages[0].resolved
    assert resolved.attempt_count == 2
    assert resolved.percent_correct == pytest.approx(expected_percent)
    assert resolved.source_attempt_numbers == expected_sources
    # The student's overall number follows the resolved score, not the sum of
    # every paper they ever touched.
    assert performance.percent_correct == pytest.approx(expected_percent)


def test_most_recent_can_be_lower_than_highest(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    first = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Unit 1", "A")
    second = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Unit 1", "B")
    _scan(gradebook_service, first, {EASY_MC, HARD_MC}, ada.id)
    _scan(gradebook_service, second, {EASY_MC}, ada.id)

    assert (
        gradebook_service.get_one_student_performance(ada.id, "most_recent").percent_correct == 50.0
    )
    assert gradebook_service.get_one_student_performance(ada.id, "highest").percent_correct == 100.0
    assert gradebook_service.get_one_student_performance(ada.id, "average").percent_correct == 75.0


# -- Cross-test aggregation ---------------------------------------------------


def test_aggregation_spans_every_test_a_student_has_taken(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    grace = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Grace", last_name="Hopper")
    )

    kinematics = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Kinematics")
    waves = _hand_off(bank_service, gradebook_service, ["q_mc_0002"], "Waves")

    _scan(gradebook_service, kinematics, {EASY_MC}, ada.id)
    _scan(gradebook_service, waves, {"q_mc_0002"}, ada.id)
    _scan(gradebook_service, kinematics, set(), grace.id)

    performance = gradebook_service.get_student_performance()
    by_student = {item.student.id: item for item in performance.items}

    ada_record = by_student[ada.id]
    assert ada_record.tests_taken == 2
    assert [lineage.test_title for lineage in ada_record.lineages] == ["Kinematics", "Waves"]
    # 1 of 2 on kinematics plus 1 of 1 on waves.
    assert ada_record.points_earned == 2.0
    assert ada_record.points_possible == 3.0
    assert ada_record.percent_correct == pytest.approx(200.0 / 3.0)

    ada_standards = {entry.standard_id: entry for entry in ada_record.by_standard}
    assert set(ada_standards) == {"PHY-KIN-01", "PHY-ELE-00"}
    assert ada_standards["PHY-KIN-01"].items_attempted == 2
    assert ada_standards["PHY-KIN-01"].percent_earned == 50.0

    # Grace took only one of the two tests; the other is simply absent.
    assert by_student[grace.id].tests_taken == 1
    assert by_student[grace.id].percent_correct == 0.0


def test_students_with_no_scans_are_still_reported(open_gradebook) -> None:
    _, gradebook_service = open_gradebook
    absent = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Alan", last_name="Turing")
    )

    record = gradebook_service.get_one_student_performance(absent.id)
    assert record.tests_taken == 0
    assert record.attempt_count == 0
    assert record.percent_correct == 0.0
    assert record.by_standard == []


def test_sheets_that_belong_to_nobody_are_counted_not_dropped(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1")
    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("sheet.png", png_bytes(_mc_sheet_image(snapshot, {EASY_MC})))]
    )
    gradebook_service.resolve_sheet_identity(
        batch.id, updated.sheets[0].id, free_text_name="A. Lovelace"
    )

    performance = gradebook_service.get_student_performance()
    assert performance.unlinked_sheet_count == 1


# -- Difficulty-weighted mastery ----------------------------------------------


def test_two_students_with_the_same_score_can_sit_at_different_levels(open_gradebook) -> None:
    """The point of reporting a level as well as a percentage: getting the level
    2 question right and the level 3 one wrong is a different piece of evidence
    from the reverse, even though both are 50%."""

    bank_service, gradebook_service = open_gradebook
    easy_only = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    hard_only = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Grace", last_name="Hopper")
    )
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Kinematics")

    _scan(gradebook_service, snapshot, {EASY_MC}, easy_only.id)
    _scan(gradebook_service, snapshot, {HARD_MC}, hard_only.id)

    by_student = {
        item.student.id: {entry.standard_id: entry for entry in item.by_standard}
        for item in gradebook_service.get_student_performance().items
    }

    easy = by_student[easy_only.id]["PHY-KIN-01"]
    hard = by_student[hard_only.id]["PHY-KIN-01"]

    assert easy.percent_earned == hard.percent_earned == 50.0
    # Ada cleared level 2 and showed nothing at level 3.
    assert easy.mastery.level_exact == pytest.approx(2.0)
    # Grace never cleared level 2, so the ladder stops there regardless of what
    # she did above it -- and says the evidence was inconsistent.
    assert hard.mastery.level_exact == pytest.approx(0.0)
    assert hard.mastery.inconsistent_evidence is True
    assert easy.average_difficulty == pytest.approx(2.5)


def test_difficulty_weighted_reads_the_same_evidence_differently(open_gradebook) -> None:
    """Switching a test to Difficulty Weighted credits the hard answer instead
    of stopping at the unmastered rung below it."""

    bank_service, gradebook_service = open_gradebook
    hard_only = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Grace", last_name="Hopper")
    )
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Kinematics")
    _scan(gradebook_service, snapshot, {HARD_MC}, hard_only.id)

    gradebook_service.set_lineage_mastery_settings(
        snapshot.lineage_id, calculation="difficulty_weighted", reporting="exact"
    )

    entry = next(
        e
        for item in gradebook_service.get_student_performance().items
        if item.student.id == hard_only.id
        for e in item.by_standard
        if e.standard_id == "PHY-KIN-01"
    )
    # One point each: (2*0 + 3*1) / 2 = 1.5
    assert entry.mastery.calculation == "difficulty_weighted"
    assert entry.mastery.level_exact == pytest.approx(1.5)


def test_a_test_override_leaves_other_tests_on_the_default(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    kinematics = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Kinematics")
    waves = _hand_off(bank_service, gradebook_service, ["q_mc_0002"], "Waves")
    _scan(gradebook_service, kinematics, {EASY_MC}, ada.id)
    _scan(gradebook_service, waves, {"q_mc_0002"}, ada.id)

    gradebook_service.set_lineage_mastery_settings(
        kinematics.lineage_id, calculation="difficulty_weighted", reporting=None
    )

    record = gradebook_service.get_one_student_performance(ada.id)
    modes = {
        lineage.test_title: {entry.mastery.calculation for entry in lineage.resolved.by_standard}
        for lineage in record.lineages
    }
    assert modes["Kinematics"] == {"difficulty_weighted"}
    assert modes["Waves"] == {"level_ladder"}

    # Clearing the override puts it back on the default.
    gradebook_service.set_lineage_mastery_settings(
        kinematics.lineage_id, calculation=None, reporting=None
    )
    record = gradebook_service.get_one_student_performance(ada.id)
    cleared = next(l for l in record.lineages if l.test_title == "Kinematics")
    assert {entry.mastery.calculation for entry in cleared.resolved.by_standard} == {
        "level_ladder"
    }


def test_changing_the_default_leaves_an_explicit_override_alone(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC], "Kinematics")
    gradebook_service.set_lineage_mastery_settings(
        snapshot.lineage_id, calculation="rubric_levels", reporting=None
    )
    gradebook_service.set_default_mastery_settings(
        calculation="difficulty_weighted", reporting="exact"
    )

    config = gradebook_service.get_mastery_config()
    assert config.default.calculation == "difficulty_weighted"
    assert config.by_lineage[snapshot.lineage_id].calculation == "rubric_levels"


# -- CSV export ---------------------------------------------------------------


def test_total_csv_has_one_column_pair_per_test(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None,
        UpsertStudentRequest(
            first_name="Ada", last_name="Lovelace", external_id="S-1", section="Period 2"
        ),
    )
    gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Alan", last_name="Turing", section="Period 2")
    )

    kinematics = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Kinematics")
    waves = _hand_off(bank_service, gradebook_service, ["q_mc_0002"], "Waves")
    _scan(gradebook_service, kinematics, {EASY_MC}, ada.id)
    _scan(gradebook_service, waves, {"q_mc_0002"}, ada.id)

    csv_text, filename = gradebook_service.export_scores_csv("total", "most_recent")
    assert filename == "scores-total-most-recent.csv"

    headers, rows = _read_csv(csv_text)
    assert headers == [
        "Last name",
        "First name",
        "External ID",
        "Section",
        "Group",
        "Kinematics points",
        "Kinematics %",
        "Waves points",
        "Waves %",
        "Overall points",
        "Overall points possible",
        "Overall %",
    ]

    by_last_name = {row[0]: row for row in rows}
    assert by_last_name["Lovelace"][:5] == ["Lovelace", "Ada", "S-1", "Period 2", ""]
    assert by_last_name["Lovelace"][5:9] == ["1", "50", "1", "100"]
    assert by_last_name["Lovelace"][9:] == ["2", "3", "66.67"]
    # Alan sat neither test: present on the roster, blank in every score column.
    assert by_last_name["Turing"][5:] == ["", "", "", "", "", "", ""]


def test_by_standard_and_mastery_csvs_label_columns_with_standard_codes(open_gradebook) -> None:
    """The demo bank's codes happen to equal its ids, so the mapping is passed
    in deliberately here -- otherwise this would pass without applying it."""

    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Kinematics")
    _scan(gradebook_service, snapshot, {HARD_MC}, ada.id)

    codes = {"PHY-KIN-01": "HS-PS2-1"}

    percent_headers, percent_rows = _read_csv(
        gradebook_service.export_scores_csv("by_standard", "most_recent", standard_codes=codes)[0]
    )
    mastery_headers, mastery_rows = _read_csv(
        gradebook_service.export_scores_csv("mastery", "most_recent", standard_codes=codes)[0]
    )

    assert percent_headers[5:] == ["HS-PS2-1 %", "Standards assessed"]
    assert mastery_headers[5:] == ["HS-PS2-1 mastery (of 3)", "Standards assessed"]
    assert percent_rows[0][5:] == ["50", "1"]
    # The level 2 question was wrong, so the ladder never leaves the ground --
    # a level, not the 50% beside it.
    assert mastery_rows[0][5:] == ["0", "1"]


def test_a_standard_with_no_code_keeps_its_id_as_the_column_header(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC], "Kinematics")
    _scan(gradebook_service, snapshot, {EASY_MC}, ada.id)

    headers, _ = _read_csv(
        gradebook_service.export_scores_csv(
            "by_standard", "most_recent", standard_codes={"PHY-KIN-01": ""}
        )[0]
    )
    assert headers[5] == "PHY-KIN-01 %"


def test_csv_export_falls_back_to_standard_ids_with_no_bank_open(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC], "Kinematics")
    _scan(gradebook_service, snapshot, {EASY_MC}, ada.id)
    bank_service.close_bank()

    headers, _ = _read_csv(gradebook_service.export_scores_csv("by_standard", "most_recent")[0])
    assert headers[5] == "PHY-KIN-01 %"


def test_csv_export_can_be_limited_to_one_section(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace", section="Period 2")
    )
    gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Alan", last_name="Turing", section="Period 4")
    )
    _hand_off(bank_service, gradebook_service, [EASY_MC], "Kinematics")

    _, rows = _read_csv(gradebook_service.export_scores_csv("total", "most_recent", "period 2")[0])
    assert [row[0] for row in rows] == ["Lovelace"]


def test_total_csv_reflects_the_chosen_retake_resolution(retake_gradebook) -> None:
    gradebook_service, _ = retake_gradebook

    _, most_recent_rows = _read_csv(gradebook_service.export_scores_csv("total", "most_recent")[0])
    _, average_rows = _read_csv(gradebook_service.export_scores_csv("total", "average")[0])

    assert most_recent_rows[0][6] == "100"
    assert average_rows[0][6] == "50"


def test_two_tests_sharing_a_title_get_distinguishable_columns(open_gradebook) -> None:
    """Same title, deliberately unlinked: a single "Unit 1" column would silently
    overwrite one test's score with the other's."""

    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    first = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1", "A")
    second = _hand_off(bank_service, gradebook_service, [HARD_MC], "Unit 1", "B")
    gradebook_service.relink_snapshot_lineage(
        second.id, lineage_of_snapshot_id=None, lineage_id="deliberately-separate"
    )

    _scan(gradebook_service, first, {EASY_MC}, ada.id)
    _scan(gradebook_service, second, set(), ada.id)

    headers, rows = _read_csv(gradebook_service.export_scores_csv("total", "most_recent")[0])
    test_headers = [header for header in headers if header.startswith("Unit 1")]
    assert len(test_headers) == 4
    assert len(set(test_headers)) == 4
    assert rows[0][-1] == "50"  # one right out of two items across two tests


# -- HTTP surface -------------------------------------------------------------


def test_performance_and_export_endpoints(gradebook_client, demo_bok: Path, tmp_path: Path) -> None:
    from app.backend import main

    assert gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200
    created = gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "gb.nxgb")},
    )
    assert created.status_code == 200

    student = gradebook_client.post(
        "/api/gradebook/students", json={"first_name": "Ada", "last_name": "Lovelace"}
    ).json()

    snapshot = _hand_off(main.service, main.gradebook_service, [EASY_MC, HARD_MC], "Kinematics")
    _scan(main.gradebook_service, snapshot, {EASY_MC}, student["id"])

    performance = gradebook_client.get("/api/gradebook/students/performance")
    assert performance.status_code == 200
    assert performance.json()["retake_resolution"] == "most_recent"
    assert performance.json()["items"][0]["tests_taken"] == 1

    one = gradebook_client.get(
        f"/api/gradebook/students/{student['id']}/performance?resolution=highest"
    )
    assert one.status_code == 200
    assert one.json()["student"]["last_name"] == "Lovelace"

    export = gradebook_client.get("/api/gradebook/export/scores.csv?method=mastery")
    assert export.status_code == 200
    assert export.headers["content-type"].startswith("text/csv")
    # The filename names the calculation: the same students score differently
    # under a different one, and two such files are otherwise identical.
    assert "scores-mastery-most-recent-level-ladder.csv" in export.headers["content-disposition"]
    assert "Last name" in export.text

    settings = gradebook_client.put(
        "/api/gradebook/mastery-settings", json={"calculation": "difficulty_weighted"}
    )
    assert settings.status_code == 200
    assert settings.json()["default"]["calculation"] == "difficulty_weighted"
    assert settings.json()["default"]["reporting"] == "half_steps"  # untouched

    export = gradebook_client.get("/api/gradebook/export/scores.csv?method=mastery")
    assert "difficulty-weighted" in export.headers["content-disposition"]

    assert (
        gradebook_client.get("/api/gradebook/export/scores.csv?method=nonsense").status_code == 400
    )
    assert (
        gradebook_client.get("/api/gradebook/students/performance?resolution=nonsense").status_code
        == 400
    )


def test_relink_endpoint_rejects_an_unknown_snapshot(gradebook_client, tmp_path: Path) -> None:
    assert (
        gradebook_client.post(
            "/api/gradebook/create",
            json={"title": "Period 2", "destination_path": str(tmp_path / "gb.nxgb")},
        ).status_code
        == 200
    )
    response = gradebook_client.put(
        "/api/gradebook/administered-tests/nope/lineage", json={"lineage_id": "x"}
    )
    assert response.status_code == 404


def test_build_student_performance_is_pure(open_gradebook) -> None:
    """The aggregation reads snapshots, batches, and the roster and touches
    nothing else -- which is what lets it be recomputed on every request."""

    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC], "Kinematics")
    _scan(gradebook_service, snapshot, {EASY_MC}, ada.id)

    result = build_student_performance(
        students=[ada],
        snapshots=[snapshot],
        batches=gradebook_service.list_scan_batches().items,
        resolution="highest",
    )
    assert result.retake_resolution == "highest"
    assert result.items[0].percent_correct == 100.0


# -- Combined report follows the lineage link ---------------------------------


def test_combined_report_by_lineage_includes_a_linked_retake(open_gradebook) -> None:
    """A retake titled differently belongs in its test's combined report -- that
    is the whole point of linking it."""

    bank_service, gradebook_service = open_gradebook
    original = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Mechanics")
    retake = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Retake")

    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    _scan(gradebook_service, original, set(), ada.id)
    _scan(gradebook_service, retake, {EASY_MC}, ada.id)

    before = gradebook_service.get_combined_lineage_report(test_title="Unit 1 Mechanics")
    assert before.scored_sheet_count == 1

    gradebook_service.relink_snapshot_lineage(
        retake.id, lineage_of_snapshot_id=original.id, lineage_id=None
    )

    after = gradebook_service.get_combined_lineage_report(lineage_id=original.lineage_id)
    assert after.lineage_id == original.lineage_id
    assert after.test_title == "Unit 1 Mechanics"  # named by the earliest printing
    assert after.scored_sheet_count == 2
    by_standard = {entry.standard_id: entry for entry in after.by_standard}
    assert by_standard["PHY-KIN-01"].attempts == 2

    # Looking it up by title resolves through the same lineage, so the linked
    # retake is included there too.
    by_title = gradebook_service.get_combined_lineage_report(test_title="Unit 1 Mechanics")
    assert by_title.scored_sheet_count == 2


def test_combined_report_needs_something_to_look_up(open_gradebook) -> None:
    _, gradebook_service = open_gradebook
    with pytest.raises(BankWorkspaceError):
        gradebook_service.get_combined_lineage_report()


# -- Where an unreadable page is filed ----------------------------------------


def _qr_blacked_out_png(snapshot):
    """A page whose QR the scanner cannot read -- it names no test at all."""

    image = rasterize_layout_page(snapshot.layout, 0, 300)
    qr = snapshot.layout.pages[0].qr_box
    scale = 300 / 72.0
    x0, x1 = int(qr.x_pt * scale), int((qr.x_pt + qr.width_pt) * scale)
    y0 = int((snapshot.layout.page_height_pt - qr.y_pt - qr.height_pt) * scale)
    y1 = int((snapshot.layout.page_height_pt - qr.y_pt) * scale)
    image[y0:y1, x0:x1] = 0
    return png_bytes(image)


def test_an_unreadable_page_is_filed_under_the_test_being_scanned(open_gradebook) -> None:
    """Scanning happens inside one test's page now, so a page the scanner could
    not read belongs to the test the teacher is looking at -- not to whichever
    test happens to have been printed most recently."""

    bank_service, gradebook_service = open_gradebook
    older = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Forces")
    newest = _hand_off(bank_service, gradebook_service, [HARD_MC], "Unit 2 Energy")

    landed = gradebook_service.ingest_scans(
        [("unreadable.png", _qr_blacked_out_png(older))], fallback_snapshot_id=older.id
    )

    assert [batch.snapshot_id for batch in landed] == [older.id]
    assert landed[0].sheets[0].identity_status == "qr_unreadable"
    # The most recently printed test is left alone.
    assert all(batch.snapshot_id != newest.id for batch in landed)


def test_an_unreadable_page_falls_back_to_the_newest_test_with_no_caller_hint(
    open_gradebook,
) -> None:
    bank_service, gradebook_service = open_gradebook
    _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Forces")
    newest = _hand_off(bank_service, gradebook_service, [HARD_MC], "Unit 2 Energy")

    landed = gradebook_service.ingest_scans([("unreadable.png", _qr_blacked_out_png(newest))])
    assert [batch.snapshot_id for batch in landed] == [newest.id]


def test_a_readable_page_ignores_the_fallback_and_goes_to_its_own_test(open_gradebook) -> None:
    """The QR wins whenever it can be read: uploading another test's paper from
    inside this one still files it correctly, which is what lets the drill-down
    scope reviewing without misfiling anything."""

    bank_service, gradebook_service = open_gradebook
    here = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Forces")
    other = _hand_off(bank_service, gradebook_service, [HARD_MC], "Unit 2 Energy")

    landed = gradebook_service.ingest_scans(
        [("other.png", png_bytes(_mc_sheet_image(other, {HARD_MC})))],
        fallback_snapshot_id=here.id,
    )
    assert [batch.snapshot_id for batch in landed] == [other.id]


def test_ingest_rejects_a_fallback_that_names_no_printing(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC], "Unit 1 Forces")

    with pytest.raises(BankWorkspaceError):
        gradebook_service.ingest_scans(
            [("a.png", png_bytes(_mc_sheet_image(snapshot, set())))],
            fallback_snapshot_id="not-a-real-snapshot",
        )


# -- Rubric Levels, end to end ------------------------------------------------


def _free_response_with_component_difficulties(bank_service, question_id: str) -> None:
    """Give a written question the per-component difficulties the spec's example uses."""

    question = bank_service.get_question(question_id)
    question.rubric = [
        RubricRowModel(criterion="Identify relevant information", points=3, difficulty=1),
        RubricRowModel(criterion="Select and set up a relationship", points=4, difficulty=2),
        RubricRowModel(criterion="Complete the procedure", points=4, difficulty=3),
        RubricRowModel(criterion="Interpret and justify the result", points=4, difficulty=4),
    ]
    question.points = 15
    bank_service.update_question(question_id, question)


def test_rubric_levels_ladders_the_components_scored_in_review(open_gradebook) -> None:
    bank_service, gradebook_service = open_gradebook
    _free_response_with_component_difficulties(bank_service, "q_fr_0001")

    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = _hand_off(bank_service, gradebook_service, ["q_fr_0001"], "Projectiles")

    # The component difficulties ride along on the frozen key.
    key_item = snapshot.answer_key.items[0]
    assert [c.difficulty for c in key_item.rubric_components] == [1, 2, 3, 4]

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("sheet.png", png_bytes(rasterize_layout_page(snapshot.layout, 0, 300)))]
    )
    sheet_id = updated.sheets[0].id
    gradebook_service.resolve_sheet_identity(batch.id, sheet_id, student_id=ada.id)

    # Full marks on levels 1 and 2, half on level 3, nothing on level 4.
    gradebook_service.override_row_result(
        batch.id, sheet_id, "q_fr_0001", component_scores=[3.0, 4.0, 2.0, 0.0]
    )
    gradebook_service.set_lineage_mastery_settings(
        snapshot.lineage_id, calculation="rubric_levels", reporting="exact"
    )

    record = gradebook_service.get_one_student_performance(ada.id)
    entry = record.by_standard[0]
    assert entry.mastery.calculation == "rubric_levels"
    assert entry.mastery.level_exact == pytest.approx(2.50)
    assert entry.mastery.components_unavailable is False
    # The row total is kept in step with the parts, so every other report agrees.
    assert entry.points_earned == pytest.approx(9.0)

    # The per-level breakdown lives on the test's own entry. The cross-test view
    # drops it on purpose: a ladder only means something inside the assessment
    # that built it.
    per_test = record.lineages[0].resolved.by_standard[0]
    assert [level.level for level in per_test.mastery.levels] == [1, 2, 3, 4]
    assert [level.mastered for level in per_test.mastery.levels] == [True, True, False, False]
    assert record.by_standard[0].mastery.levels == []


def test_rubric_levels_says_when_no_component_carried_a_difficulty(open_gradebook) -> None:
    """Falling back to laddering whole questions is the right behaviour, but the
    report has to admit it rather than quietly reporting a different mode."""

    bank_service, gradebook_service = open_gradebook
    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = _hand_off(bank_service, gradebook_service, [EASY_MC, HARD_MC], "Kinematics")
    _scan(gradebook_service, snapshot, {EASY_MC}, ada.id)
    gradebook_service.set_lineage_mastery_settings(
        snapshot.lineage_id, calculation="rubric_levels", reporting="exact"
    )

    entry = next(
        e
        for e in gradebook_service.get_one_student_performance(ada.id).by_standard
        if e.standard_id == "PHY-KIN-01"
    )
    assert entry.mastery.components_unavailable is True
    assert entry.mastery.level_exact == pytest.approx(2.0)  # laddered as whole questions


def test_a_partly_specified_rubric_is_not_laddered(open_gradebook) -> None:
    """Half a ladder is worse than none: a rubric with difficulties on only some
    parts cannot say which rung the work reached, so it is left to the
    whole-question fallback rather than guessed at."""

    bank_service, gradebook_service = open_gradebook
    question = bank_service.get_question("q_fr_0001")
    question.rubric = [
        RubricRowModel(criterion="Set up", points=5, difficulty=1),
        RubricRowModel(criterion="Finish", points=5, difficulty=None),
    ]
    bank_service.update_question("q_fr_0001", question)

    ada = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = _hand_off(bank_service, gradebook_service, ["q_fr_0001"], "Projectiles")
    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("sheet.png", png_bytes(rasterize_layout_page(snapshot.layout, 0, 300)))]
    )
    gradebook_service.resolve_sheet_identity(batch.id, updated.sheets[0].id, student_id=ada.id)
    gradebook_service.override_row_result(
        batch.id, updated.sheets[0].id, "q_fr_0001", component_scores=[5.0, 0.0]
    )
    gradebook_service.set_lineage_mastery_settings(
        snapshot.lineage_id, calculation="rubric_levels", reporting="exact"
    )

    entry = gradebook_service.get_one_student_performance(ada.id).by_standard[0]
    assert entry.mastery.components_unavailable is True
