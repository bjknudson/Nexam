from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from app.backend.models import (
    AssetInspectionRequest,
    CreateStandardsManuallyRequest,
    ManualStandardRowModel,
    TestSectionItemModel,
)
from app.backend.service import BankWorkspaceError, BankWorkspaceService


def test_open_bank_lists_and_filters_questions(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    summary = bank_service.open_bank(str(demo_bok))

    assert summary.manifest.title == "Demo Bank"
    assert summary.bank.question_ids == [
        "q_fr_0001",
        "q_fr_0002",
        "q_fr_0003",
        "q_fr_0004",
        "q_fr_0005",
        "q_fr_0006",
        "q_fr_0007",
        "q_fr_0008",
        "q_fr_0009",
        "q_fr_0010",
        "q_fr_0011",
        "q_fr_0012",
        "q_mc_0001",
        "q_mc_0002",
        "q_mc_0003",
        "q_mc_0004",
        "q_mc_0005",
        "q_mc_0006",
        "q_mc_0007",
        "q_mc_0008",
        "q_mc_0009",
        "q_mc_0010",
        "q_mc_0011",
        "q_mc_0012",
        "q_mc_0013",
        "q_mc_0014",
        "q_mc_0015",
        "q_mc_0016",
        "q_mc_0017",
        "q_mc_0018",
        "q_mc_0019",
        "q_mc_0020",
        "q_mc_0021",
        "q_mc_0022",
        "q_mc_0023",
        "q_mc_0024",
        "q_mc_0025",
        "q_mc_0026",
        "q_mc_0027",
        "q_mc_0028",
        "q_mc_0029",
        "q_mc_0030",
        "q_mc_0031",
        "q_mc_0032",
        "q_mc_0033",
        "q_mc_0034",
        "q_mc_0035",
        "q_mc_0036",
        "q_mc_0037",
        "q_mc_0038",
        "q_mc_0039",
        "q_mc_0040",
        "q_mc_0041",
        "q_mc_0042",
        "q_mc_0043",
        "q_mc_0044",
        "q_mc_0045",
        "q_mc_0046",
        "q_mc_0047",
        "q_mc_0048",
        "q_num_0001",
        "q_num_0002",
        "q_num_0003",
        "q_num_0004",
        "q_num_0005",
        "q_num_0006",
        "q_num_0007",
        "q_sa_0001",
        "q_sa_0002",
        "q_sa_0003",
        "q_sa_0004",
        "q_sa_0005",
        "q_sa_0006",
        "q_sa_0007",
        "q_sa_0008",
        "q_sa_0009",
        "q_sa_0010",
    ]

    result = bank_service.list_questions(
        search="starts from rest",
        topic="Mechanics",
        question_type="multiple_choice",
    )

    assert [item.id for item in result.items] == ["q_mc_0001"]
    assert result.available_topics == [
        "AP English Literature",
        "AP U.S. History",
        "Algebra 1",
        "Biology",
        "Calculus",
        "Chemistry",
        "Cinematography",
        "Electricity",
        "Government",
        "Mechanics",
        "Medical Careers",
        "Spanish 2",
        "Waves",
    ]
    assert result.available_types == [
        "free_response",
        "multiple_choice",
        "numeric_response",
        "short_answer",
    ]


def test_update_question_from_json_model_refreshes_index_and_save(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
    tmp_path: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    question = bank_service.get_question("q_mc_0001")
    updated = question.model_copy(
        update={
            "id": "q_json_new",
            "topic": "Testability",
            "prompt": "A raw JSON edit can replace an existing question body.",
            "tags": ["json-edit"],
        }
    )

    bank_service.update_question("q_mc_0001", updated)
    summary = bank_service.get_summary()

    assert "q_json_new" in summary.bank.question_ids
    assert "q_mc_0001" not in summary.bank.question_ids
    assert "Testability" in summary.bank.topics

    destination = tmp_path / "saved-bank.bok"
    saved_path = bank_service.save_bank(str(destination))

    assert saved_path == str(destination.resolve())
    with zipfile.ZipFile(destination) as archive:
        names = set(archive.namelist())
        assert "questions/q_json_new.json" in names
        assert "questions/q_mc_0001.json" not in names
        saved_question = json.loads(archive.read("questions/q_json_new.json"))

    assert saved_question["prompt"] == "A raw JSON edit can replace an existing question body."
    assert saved_question["tags"] == ["json-edit"]


def test_create_question_from_json_assigns_unique_id(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_mc_0001").model_dump()

    created = bank_service.create_question_from_json(source)
    summary = bank_service.get_summary()

    assert created.id == "q_mc_0049"
    assert created.prompt == source["prompt"]
    assert "q_mc_0001" in summary.bank.question_ids
    assert "q_mc_0023" in summary.bank.question_ids


def test_create_question_from_json_adds_missing_id(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source.pop("id")

    created = bank_service.create_question_from_json(source)

    assert created.id == "q_sa_0011"
    assert created.type == "short_answer"


def test_stage_question_import_accepts_json_array_without_writing_questions(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source.pop("id")
    source["prompt"] = "Imported short answer JSON is staged before promotion."

    stage = bank_service.stage_question_import(
        filename="questions.json",
        content=json.dumps([source]).encode("utf-8"),
    )
    summary = bank_service.get_summary()

    assert stage.source_filename == "questions.json"
    assert stage.source_path.startswith(f"imports/{stage.id}/")
    assert len(stage.rows) == 1
    assert stage.rows[0].status == "valid"
    assert stage.rows[0].selected is True
    assert stage.rows[0].imported_id is None
    assert stage.rows[0].proposed_id == "q_sa_0011"
    assert "q_sa_0011" not in summary.bank.question_ids

    listed = bank_service.list_question_imports()
    fetched = bank_service.get_question_import(stage.id)

    assert [item.id for item in listed.items] == [stage.id]
    assert fetched.rows[0].question["prompt"] == "Imported short answer JSON is staged before promotion."


def test_stage_question_import_accepts_question_wrapper(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_num_0001").model_dump()
    source.pop("id")

    stage = bank_service.stage_question_import(
        filename="wrapped.json",
        content=json.dumps({"question": source}).encode("utf-8"),
    )

    assert len(stage.rows) == 1
    assert stage.rows[0].status == "valid"
    assert stage.rows[0].proposed_id == "q_num_0008"


def test_stage_question_import_reports_validation_errors(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source.pop("id")
    source["sample_solution"] = ""

    stage = bank_service.stage_question_import(
        filename="invalid.json",
        content=json.dumps({"items": [source]}).encode("utf-8"),
    )

    assert stage.rows[0].status == "invalid"
    assert stage.rows[0].selected is False
    assert any(
        "short_answer questions need a sample_solution" in issue.message
        for issue in stage.rows[0].issues
    )


def test_stage_question_import_reports_duplicate_existing_ids(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_mc_0001").model_dump()

    stage = bank_service.stage_question_import(
        filename="duplicate.json",
        content=json.dumps(source).encode("utf-8"),
    )

    assert stage.rows[0].status == "valid"
    assert stage.rows[0].selected is True
    assert any(
        issue.code == "duplicate_existing_id" and issue.severity == "warning"
        for issue in stage.rows[0].issues
    )


def test_stage_question_import_warns_for_unknown_standard_without_blocking_auto_id(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_mc_0001").model_dump()
    source["id"] = "external_mc_001"
    source["standards"] = [{"standard_id": "EXTERNAL-STANDARD-001"}]

    stage = bank_service.stage_question_import(
        filename="external-standard.json",
        content=json.dumps(source).encode("utf-8"),
    )

    row = stage.rows[0]
    assert row.status == "valid"
    assert row.selected is True
    assert any(
        issue.code == "unknown_standard" and issue.severity == "warning"
        for issue in row.issues
    )


def test_stage_question_import_accepts_multiple_correct_choice_indices(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_mc_0001").model_dump()
    source.pop("id")
    source["answer"] = {
        "choices": ["2x + 4", "x + 4", "4 + 2x", "2x"],
        "correct_choice_indices": [0, 2],
    }

    stage = bank_service.stage_question_import(
        filename="multi-correct.json",
        content=json.dumps(source).encode("utf-8"),
    )

    assert stage.rows[0].status == "valid"
    assert stage.rows[0].issues == []


def test_stage_question_import_accepts_csv_rows(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    csv_content = "\n".join(
        [
            "id,type,topic,difficulty,prompt,tags,standards,sample_solution,status,points",
            ",short_answer,Electricity,2,Explain Ohm's law.,circuits;ohm,PHY-ELE-01,Voltage equals current times resistance.,draft,2",
        ]
    )

    stage = bank_service.stage_question_import(
        filename="questions.csv",
        content=csv_content.encode("utf-8"),
    )

    row = stage.rows[0]
    assert row.status == "valid"
    assert row.selected is True
    assert row.source["tags"] == "circuits;ohm"
    assert row.question["tags"] == ["circuits", "ohm"]
    assert row.question["standards"] == [{"standard_id": "PHY-ELE-01"}]
    assert row.question["points"] == 2.0
    assert row.proposed_id == "q_sa_0011"


def test_stage_question_import_keeps_malformed_csv_rows_visible(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    csv_content = "\n".join(
        [
            "id,type,topic,difficulty,prompt,answer_json",
            ',numeric_response,Waves,two,Find the frequency.,"{bad json"',
        ]
    )

    stage = bank_service.stage_question_import(
        filename="bad-questions.csv",
        content=csv_content.encode("utf-8"),
    )

    row = stage.rows[0]
    assert row.status == "invalid"
    assert row.selected is False
    assert row.source["answer_json"] == "{bad json"
    assert any(issue.code == "malformed_json" for issue in row.issues)
    assert any(issue.location == ["difficulty"] for issue in row.issues)


def test_promote_question_import_rows_uses_proposed_ids_and_refreshes_index(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source.pop("id")
    source["prompt"] = "Promoted staged short answer."

    stage = bank_service.stage_question_import(
        filename="questions.json",
        content=json.dumps([source]).encode("utf-8"),
    )

    response = bank_service.promote_question_import_rows(stage.id)
    summary = bank_service.get_summary()
    promoted = bank_service.get_question("q_sa_0011")
    updated_stage = bank_service.get_question_import(stage.id)

    assert response.promoted_count == 1
    assert response.promoted_question_ids == ["q_sa_0011"]
    assert promoted.prompt == "Promoted staged short answer."
    assert "q_sa_0011" in summary.bank.question_ids
    assert updated_stage.rows[0].status == "promoted"
    assert updated_stage.rows[0].selected is False
    assert updated_stage.rows[0].promoted_question_id == "q_sa_0011"


def test_update_question_import_row_revalidates_invalid_row(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source.pop("id")
    source["sample_solution"] = ""

    stage = bank_service.stage_question_import(
        filename="invalid.json",
        content=json.dumps([source]).encode("utf-8"),
    )
    assert stage.rows[0].status == "invalid"

    source["sample_solution"] = "Ohm's law states V = IR."
    updated_stage = bank_service.update_question_import_row(
        stage.id,
        stage.rows[0].row_id,
        question=source,
    )

    updated_row = updated_stage.rows[0]
    assert updated_row.status == "valid"
    assert updated_row.selected is True
    assert updated_row.issues == []
    assert updated_row.proposed_id == "q_sa_0011"


def test_promote_question_import_rows_can_keep_unique_imported_ids(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source["id"] = "custom_short_answer_001"
    source["prompt"] = "Promoted with imported id."

    stage = bank_service.stage_question_import(
        filename="questions.json",
        content=json.dumps(source).encode("utf-8"),
    )

    response = bank_service.promote_question_import_rows(stage.id, id_policy="keep_imported")

    assert response.promoted_question_ids == ["custom_short_answer_001"]
    assert bank_service.get_question("custom_short_answer_001").prompt == "Promoted with imported id."


def test_promote_question_import_rows_rejects_duplicate_keep_imported_ids_before_writing(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    first = bank_service.get_question("q_sa_0001").model_dump()
    second = bank_service.get_question("q_sa_0001").model_dump()
    first["id"] = "duplicate_imported_short_answer"
    second["id"] = "duplicate_imported_short_answer"
    first["prompt"] = "First duplicate imported id."
    second["prompt"] = "Second duplicate imported id."

    stage = bank_service.stage_question_import(
        filename="duplicate-imported-ids.json",
        content=json.dumps([first, second]).encode("utf-8"),
    )

    assert [row.status for row in stage.rows] == ["valid", "valid"]
    assert all(
        any(issue.code == "duplicate_import_id" and issue.severity == "warning" for issue in row.issues)
        for row in stage.rows
    )

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.promote_question_import_rows(stage.id, id_policy="keep_imported")

    assert exc_info.value.status_code == 422
    assert "Imported ids must be unique" in exc_info.value.message
    with pytest.raises(BankWorkspaceError):
        bank_service.get_question("duplicate_imported_short_answer")


def test_promote_question_import_rows_rejects_invalid_rows(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source.pop("id")
    source["sample_solution"] = ""

    stage = bank_service.stage_question_import(
        filename="invalid.json",
        content=json.dumps([source]).encode("utf-8"),
    )

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.promote_question_import_rows(stage.id, row_ids=[stage.rows[0].row_id])

    assert exc_info.value.status_code == 422
    assert "Only valid staged rows can be promoted" in exc_info.value.message


def test_promoted_question_import_rows_are_saved_in_repacked_bank(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
    tmp_path: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_question("q_sa_0001").model_dump()
    source.pop("id")
    source["prompt"] = "Promoted imports persist into the archive."

    stage = bank_service.stage_question_import(
        filename="questions.json",
        content=json.dumps([source]).encode("utf-8"),
    )
    bank_service.promote_question_import_rows(stage.id)

    destination = tmp_path / "saved-import-bank.bok"
    bank_service.save_bank(str(destination))

    with zipfile.ZipFile(destination) as archive:
        names = set(archive.namelist())
        promoted_question = json.loads(archive.read("questions/q_sa_0011.json"))

    assert "questions/q_sa_0011.json" in names
    assert f"imports/{stage.id}/questions.json" in names
    assert f"imports/{stage.id}/stage.json" in names
    assert promoted_question["prompt"] == "Promoted imports persist into the archive."


def test_create_test_draft_and_add_questions_builds_summary(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    detail = bank_service.create_test_draft("Unit 1 Mechanics", "A")
    detail = bank_service.add_question_to_test(detail.test.id, "q_mc_0001")
    detail = bank_service.add_question_to_test(detail.test.id, "q_sa_0001", experimental=True)

    assert detail.test.id == "test_0001"
    assert detail.test.title == "Unit 1 Mechanics"
    assert [item.question_id for item in detail.test.items] == ["q_mc_0001", "q_sa_0001"]
    assert detail.test.items[1].experimental is True
    assert [question.id for question in detail.questions] == ["q_mc_0001", "q_sa_0001"]
    assert detail.summary.question_type_counts == {
        "multiple_choice": 1,
        "short_answer": 1,
    }
    assert detail.summary.difficulty_counts == {"2": 2}
    assert detail.summary.average_difficulty == 2
    assert detail.summary.total_time_estimate_sec == 180
    assert detail.summary.standard_ids == ["PHY-ELE-01", "PHY-KIN-01"]

    listed = bank_service.list_test_drafts()
    assert [item.test.id for item in listed.items] == ["test_0001"]


def test_test_draft_supports_manual_section_items(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    detail = bank_service.create_test_draft("Manual Sections", "A")
    detail = bank_service.add_question_to_test(detail.test.id, "q_mc_0001")
    test = detail.test.model_copy(deep=True)
    test.items.insert(
        0,
        TestSectionItemModel(
            item_type="section",
            section_id="section_1",
            question_type="multiple_choice",
            title="Part 1",
            instructions="Answer each multiple-choice item.",
            header_template="{{section_title}}\n{{instructions}}\n{{time}}",
            topic="Kinematics",
            standards=["PHY-KIN-01"],
            suggested_time_mode="override",
            suggested_time_sec=300,
        ),
    )

    updated = bank_service.update_test_draft(test.id, test)

    assert updated.test.items[0].item_type == "section"
    assert updated.test.items[0].title == "Part 1"
    assert [question.id for question in updated.questions] == ["q_mc_0001"]
    assert updated.summary.question_type_counts == {"multiple_choice": 1}
    assert updated.summary.total_time_estimate_sec == updated.questions[0].estimated_time_sec


def test_test_drafts_are_saved_in_repacked_bank(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
    tmp_path: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = bank_service.create_test_draft("Printable Practice Test", "B")
    bank_service.add_question_to_test(detail.test.id, "q_num_0001")

    destination = tmp_path / "saved-test-bank.bok"
    bank_service.save_bank(str(destination))

    with zipfile.ZipFile(destination) as archive:
        names = set(archive.namelist())
        tests = json.loads(archive.read("tests/tests.json"))

    assert "tests/tests.json" in names
    assert tests["items"][0]["title"] == "Printable Practice Test"
    assert tests["items"][0]["version"] == "B"
    assert tests["items"][0]["items"] == [
        {
            "question_id": "q_num_0001",
            "experimental": False,
            "response_space_lines": None,
            "teacher_notes": None,
        }
    ]


def test_next_question_id_uses_type_prefix_and_serial(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    assert bank_service.next_question_id("multiple_choice") == "q_mc_0049"
    assert bank_service.next_question_id("numeric_response") == "q_num_0008"
    assert bank_service.next_question_id("short_answer") == "q_sa_0011"
    assert bank_service.next_question_id("free_response") == "q_fr_0013"


def test_asset_paths_must_stay_inside_workspace(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.resolve_asset_path("../manifest.json")

    assert exc_info.value.status_code == 400
    assert "assets/ directory" in exc_info.value.message


def test_svg_placeholders_include_calc_variables() -> None:
    service = BankWorkspaceService()
    source = '<svg><text>{{ label }}</text><line x2="{{ calc: length * scale }}"/></svg>'

    assert service.extract_svg_placeholders(source) == ["label", "length", "scale"]
    assert (
        service.render_svg(source, {"label": "Force", "length": "12", "scale": "2.5"})
        == '<svg><text>Force</text><line x2="30"/></svg>'
    )


def test_create_standards_manually_creates_source_list_and_records(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    response = bank_service.create_standards_manually(
        CreateStandardsManuallyRequest(
            source_list_id="site-core-2026",
            title="Site Core Standards",
            issuer="Local District",
            subject="Physics",
            standards=[
                ManualStandardRowModel(
                    id="SITE-01",
                    statement="Explain conservation of momentum in a closed system.",
                    tags=["mechanics", "momentum"],
                ),
                ManualStandardRowModel(
                    id="SITE-02",
                    code="SITE-2",
                    statement="Model energy transfer during a collision.",
                    subject="Physical Science",
                    grade_band="9-12",
                ),
            ],
        )
    )

    assert response.imported_count == 2
    assert response.source_list.id == "site-core-2026"
    assert response.imported_path is None

    source_list_ids = {item.id for item in bank_service.list_source_standard_lists().items}
    assert "site-core-2026" in source_list_ids

    saved = {
        item.id: item
        for item in bank_service.list_standards(source_list_id="site-core-2026").items
    }
    assert set(saved) == {"SITE-01", "SITE-02"}
    assert saved["SITE-01"].code == "SITE-01"
    assert saved["SITE-01"].subject == "Physics"
    assert saved["SITE-01"].tags == ["mechanics", "momentum"]
    assert saved["SITE-02"].code == "SITE-2"
    assert saved["SITE-02"].subject == "Physical Science"
    assert saved["SITE-02"].grade_band == "9-12"


def test_create_standards_manually_appends_to_existing_source_list(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source_list_count = len(bank_service.list_source_standard_lists().items)

    response = bank_service.create_standards_manually(
        CreateStandardsManuallyRequest(
            source_list_id="physics-core-2026",
            standards=[
                ManualStandardRowModel(
                    id="PHY-MOM-01",
                    statement="Apply conservation of momentum to one-dimensional collisions.",
                )
            ],
        )
    )

    assert response.source_list.title == "Physics Core Standards"
    assert len(bank_service.list_source_standard_lists().items) == source_list_count

    standard_ids = {
        item.id for item in bank_service.list_standards(source_list_id="physics-core-2026").items
    }
    assert {"PHY-KIN-01", "PHY-MOM-01"} <= standard_ids


def test_create_standards_manually_rejects_duplicate_ids(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_standards_manually(
            CreateStandardsManuallyRequest(
                source_list_id="physics-core-2026",
                standards=[
                    ManualStandardRowModel(
                        id="PHY-KIN-01",
                        statement="Collides with a standard that is already saved.",
                    )
                ],
            )
        )

    assert exc_info.value.status_code == 409
    assert "PHY-KIN-01" in exc_info.value.message

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_standards_manually(
            CreateStandardsManuallyRequest(
                source_list_id="physics-core-2026",
                standards=[
                    ManualStandardRowModel(id="PHY-DUP-01", statement="First row."),
                    ManualStandardRowModel(id="PHY-DUP-01", statement="Second row, same id."),
                ],
            )
        )

    assert exc_info.value.status_code == 409
    assert "PHY-DUP-01" not in {
        item.id for item in bank_service.list_standards(source_list_id="physics-core-2026").items
    }


def test_create_standards_manually_validates_required_input(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_standards_manually(
            CreateStandardsManuallyRequest(source_list_id="physics-core-2026", standards=[])
        )
    assert exc_info.value.status_code == 422

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_standards_manually(
            CreateStandardsManuallyRequest(
                source_list_id="brand-new-list",
                standards=[ManualStandardRowModel(id="NEW-01", statement="Needs a title and issuer.")],
            )
        )
    assert exc_info.value.status_code == 422

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_standards_manually(
            CreateStandardsManuallyRequest(
                source_list_id="physics-core-2026",
                standards=[ManualStandardRowModel(id="NEW-02", statement="   ")],
            )
        )
    assert exc_info.value.status_code == 422


def test_inspect_assets_renders_a_batch_in_request_order(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    question = bank_service.get_question("q_fr_0001")
    assert len(question.assets) == 2

    response = bank_service.inspect_assets(
        [
            AssetInspectionRequest(
                path=asset.path,
                kind=asset.kind,
                svg_variables=asset.svg_variables,
            )
            for asset in question.assets
        ]
    )

    assert [item.path for item in response.items] == [asset.path for asset in question.assets]
    for item in response.items:
        assert item.kind == "svg"
        assert item.rendered_svg
        assert "{{" not in item.rendered_svg

    # Variables from the question are substituted into the rendered markup.
    assert "Weight W" in response.items[0].rendered_svg
    assert "Crate" in response.items[1].rendered_svg


def test_inspect_assets_accepts_an_empty_batch(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    assert bank_service.inspect_assets([]).items == []


def test_backend_reports_its_version_from_the_tauri_config() -> None:
    import json
    from pathlib import Path as _Path

    from app.backend.version import get_backend_version, is_frozen

    repo_root = _Path(__file__).resolve().parents[3]
    expected = json.loads((repo_root / "src-tauri" / "tauri.conf.json").read_text())["version"]

    # Running from source, the version tracks the config with no manual syncing.
    assert get_backend_version() == expected
    assert is_frozen() is False


def test_create_questions_from_json_assigns_ids_across_the_batch(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    created = bank_service.create_questions_from_json(
        [
            {
                "type": "multiple_choice",
                "topic": "Batch",
                "difficulty": 1,
                "prompt": "First batched question?",
                "answer": {"choices": ["a", "b"], "correct_choice_index": 0},
            },
            {
                "type": "multiple_choice",
                "topic": "Batch",
                "difficulty": 2,
                "prompt": "Second batched question?",
                "answer": {"choices": ["a", "b"], "correct_choice_index": 1},
            },
            {
                "type": "short_answer",
                "topic": "Batch",
                "difficulty": 1,
                "prompt": "Third batched question?",
                "sample_solution": "A short answer.",
            },
        ]
    )

    # Ids are unique across the batch, not all resolved to the same next id.
    assert [question.id for question in created] == ["q_mc_0049", "q_mc_0050", "q_sa_0011"]

    summary = bank_service.get_summary()
    for question in created:
        assert question.id in summary.bank.question_ids


def test_create_questions_from_json_writes_nothing_when_one_row_is_invalid(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    before = set(bank_service.get_summary().bank.question_ids)

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_questions_from_json(
            [
                {
                    "type": "multiple_choice",
                    "topic": "Batch",
                    "difficulty": 1,
                    "prompt": "Valid question?",
                    "answer": {"choices": ["a", "b"], "correct_choice_index": 0},
                },
                {
                    "type": "multiple_choice",
                    "topic": "Batch",
                    "difficulty": 1,
                    "prompt": "Missing its choices.",
                },
            ]
        )

    assert exc_info.value.status_code == 422
    assert "Question 2" in exc_info.value.message
    # The valid first row must not have been written.
    assert set(bank_service.get_summary().bank.question_ids) == before


def test_create_questions_from_json_rejects_an_empty_batch(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_questions_from_json([])

    assert exc_info.value.status_code == 422


def test_multiple_choice_indices_collapse_to_a_single_correct_answer() -> None:
    from app.backend.models import QuestionModel

    base = {
        "id": "q_mc_9001",
        "type": "multiple_choice",
        "topic": "Ordering",
        "difficulty": 2,
        "prompt": "Order the integers from least to greatest.",
        "answer": {"choices": ["a", "b", "c", "d"]},
    }

    # A repeated index carries no extra meaning: it is one correct answer.
    repeated = QuestionModel.model_validate(
        {**base, "answer": {**base["answer"], "correct_choice_indices": [0, 0]}}
    )
    assert repeated.answer == {"choices": ["a", "b", "c", "d"], "correct_choice_index": 0}

    # A single-element list is a single-answer question written the long way.
    single = QuestionModel.model_validate(
        {**base, "answer": {**base["answer"], "correct_choice_indices": [2]}}
    )
    assert single.answer == {"choices": ["a", "b", "c", "d"], "correct_choice_index": 2}

    # Genuine multi-answer questions keep the list, deduped and sorted.
    multi = QuestionModel.model_validate(
        {**base, "answer": {**base["answer"], "correct_choice_indices": [3, 1, 3]}}
    )
    assert multi.answer == {"choices": ["a", "b", "c", "d"], "correct_choice_indices": [1, 3]}


def test_multiple_choice_indices_still_reject_unusable_values() -> None:
    import pytest as _pytest

    from app.backend.models import QuestionModel

    base = {
        "id": "q_mc_9002",
        "type": "multiple_choice",
        "topic": "Ordering",
        "difficulty": 2,
        "prompt": "Order the integers from least to greatest.",
        "answer": {"choices": ["a", "b"]},
    }

    with _pytest.raises(ValueError, match="must reference choices"):
        QuestionModel.model_validate(
            {**base, "answer": {**base["answer"], "correct_choice_indices": [5]}}
        )

    with _pytest.raises(ValueError, match="at least one choice"):
        QuestionModel.model_validate(
            {**base, "answer": {**base["answer"], "correct_choice_indices": []}}
        )

    with _pytest.raises(ValueError, match="list of integers"):
        QuestionModel.model_validate(
            {**base, "answer": {**base["answer"], "correct_choice_indices": ["0"]}}
        )


def test_import_keeps_standards_with_their_own_sources(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    """A file that names a source per standard splits into one source each."""
    bank_service.open_bank(str(demo_bok))
    csv_text = (
        "id,code,statement,strand,source_title,issuer\n"
        "ELA-R-01,ELA-R-01,Cite textual evidence.,Reading,District ELA Standards,Local District\n"
        "ELA-W-01,ELA-W-01,Write arguments with reasons.,Writing,District ELA Standards,Local District\n"
        "SCI-01,SCI-01,Model energy transfer.,Energy,District Science Standards,Local District\n"
    )

    response = bank_service.import_standards(
        filename="district.csv",
        content=csv_text.encode("utf-8"),
    )

    assert response.imported_count == 3
    assert {item.id for item in response.source_lists} == {
        "district-ela-standards",
        "district-science-standards",
    }

    saved = {item.id: item for item in bank_service.list_standards().items}
    assert saved["ELA-R-01"].source_list_id == "district-ela-standards"
    assert saved["ELA-R-01"].strand == "Reading"
    assert saved["SCI-01"].source_list_id == "district-science-standards"


def test_import_falls_back_to_supplied_source_when_file_is_silent(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    csv_text = "id,code,statement\nGEO-01,GEO-01,Prove triangle congruence.\n"

    # With no source in the file and none supplied, the import asks for one.
    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.import_standards(filename="geo.csv", content=csv_text.encode("utf-8"))
    assert exc_info.value.status_code == 422

    response = bank_service.import_standards(
        filename="geo.csv",
        content=csv_text.encode("utf-8"),
        source_list_id="geometry-2026",
        title="Geometry Standards",
        issuer="Local District",
    )

    assert response.imported_count == 1
    assert response.source_list.id == "geometry-2026"
    saved = {item.id: item for item in bank_service.list_standards().items}
    assert saved["GEO-01"].source_list_id == "geometry-2026"


def test_inspect_standard_import_reports_whether_a_source_is_needed(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    silent = bank_service.inspect_standard_import(
        filename="silent.csv",
        content=b"id,code,statement\nX-01,X-01,Something.\n",
    )
    assert silent.total_rows == 1
    assert silent.rows_with_source == 0
    assert silent.needs_source_input is True

    self_describing = bank_service.inspect_standard_import(
        filename="described.csv",
        content=(
            "id,code,statement,source_title,issuer\n"
            "Y-01,Y-01,Something else.,Y Standards,Y Board\n"
        ).encode("utf-8"),
    )
    assert self_describing.rows_with_source == 1
    assert self_describing.needs_source_input is False
    assert self_describing.detected_sources[0].title == "Y Standards"
    assert self_describing.detected_sources[0].complete is True


def test_manual_standards_can_name_a_source_per_row(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    response = bank_service.create_standards_manually(
        CreateStandardsManuallyRequest(
            standards=[
                ManualStandardRowModel(
                    id="ROW-EXISTING-01",
                    statement="Filed under a source already in the library.",
                    source_list_id="physics-core-2026",
                ),
                ManualStandardRowModel(
                    id="ROW-NEW-01",
                    statement="Filed under a brand new source.",
                    strand="Measurement",
                    source_list_id="site-lab-2026",
                    source_title="Site Lab Standards",
                    source_issuer="Local District",
                ),
            ]
        )
    )

    assert response.imported_count == 2
    saved = {item.id: item for item in bank_service.list_standards().items}
    assert saved["ROW-EXISTING-01"].source_list_id == "physics-core-2026"
    assert saved["ROW-NEW-01"].source_list_id == "site-lab-2026"
    assert saved["ROW-NEW-01"].strand == "Measurement"
    assert "site-lab-2026" in {item.id for item in bank_service.list_source_standard_lists().items}


def test_list_standards_filters_by_strand_and_sorts_by_source(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    bank_service.create_standards_manually(
        CreateStandardsManuallyRequest(
            source_list_id="physics-core-2026",
            standards=[
                ManualStandardRowModel(
                    id="STRAND-01", statement="Waves strand.", strand="Waves"
                ),
                ManualStandardRowModel(
                    id="STRAND-02", statement="Optics strand.", strand="Optics"
                ),
            ],
        )
    )

    assert "Optics" in bank_service.list_standard_strands()
    # Filtering by strand returns everything on that strand, including the demo
    # standards already carrying it.
    waves = {item.id for item in bank_service.list_standards(strand="Waves").items}
    assert "STRAND-01" in waves
    assert "STRAND-02" not in waves
    assert all(item.strand == "Waves" for item in bank_service.list_standards(strand="Waves").items)

    # Searching reaches the strand text, not just the statement.
    assert any(
        item.id == "STRAND-02" for item in bank_service.list_standards(search="optics").items
    )

    by_source = bank_service.list_standards(sort="source").items
    source_titles = {
        item.id: item.title for item in bank_service.list_source_standard_lists().items
    }
    ordered = [source_titles[item.source_list_id].lower() for item in by_source]
    assert ordered == sorted(ordered)


def test_course_detail_reports_coverage_blind_spots_and_extras(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = bank_service.create_test_draft(
        title="Physics Unit 1", version="A", course_ids=["physics-1"]
    )
    test_id = detail.test.id

    # q_mc_0001 carries PHY-KIN-01, which the physics-1 course lists.
    covered_question = next(
        question
        for question in bank_service._load_questions()
        if any(reference.standard_id == "PHY-KIN-01" for reference in question.standards)
    )
    bank_service.add_question_to_test(test_id, covered_question.id)

    # A question whose standards sit outside the course shows up as an extra.
    extra_question = next(
        question
        for question in bank_service._load_questions()
        if question.standards
        and all(
            reference.standard_id
            not in {"PHY-KIN-01", "PHY-NEW-01", "PHY-WAV-02", "PHY-ELE-01"}
            for reference in question.standards
        )
    )
    bank_service.add_question_to_test(test_id, extra_question.id)

    course = bank_service.get_course_detail("physics-1")

    assert [item.test_id for item in course.tests] == [test_id]
    assert course.question_count == 2
    covered_ids = {item.standard_id for item in course.covered_standards}
    uncovered_ids = {item.standard_id for item in course.uncovered_standards}
    assert "PHY-KIN-01" in covered_ids
    assert covered_ids.isdisjoint(uncovered_ids)
    assert len(covered_ids) + len(uncovered_ids) == len(course.course.standard_refs)
    assert all(item.question_count == 0 for item in course.uncovered_standards)
    assert all(item.question_count > 0 for item in course.covered_standards)
    assert course.extra_standards
    assert all(not item.in_course for item in course.extra_standards)


def test_tests_can_serve_several_courses_and_survive_a_deleted_one(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = bank_service.create_test_draft(
        title="Shared Midterm", version="A", course_ids=["physics-1", "algebra-1"]
    )

    assert detail.test.course_ids == ["physics-1", "algebra-1"]
    assert detail.summary.course_ids == ["physics-1", "algebra-1"]
    assert [item.test_id for item in bank_service.get_course_detail("algebra-1").tests] == [
        detail.test.id
    ]

    bank_service.delete_course("algebra-1")

    reloaded = bank_service.get_test_draft(detail.test.id)
    assert reloaded.test.course_ids == ["physics-1"]
    with pytest.raises(BankWorkspaceError):
        bank_service.get_course_detail("algebra-1")


def test_test_draft_rejects_an_unknown_course(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.create_test_draft(title="Orphan", version="A", course_ids=["not-a-course"])

    assert exc_info.value.status_code == 422
    assert "not-a-course" in exc_info.value.message


def test_course_assignments_survive_a_save_and_reopen(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
    tmp_path: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = bank_service.create_test_draft(
        title="Persisted Test", version="A", course_ids=["physics-1"]
    )
    saved_path = tmp_path / "saved-bank.bok"
    bank_service.save_bank(str(saved_path))

    reopened = BankWorkspaceService()
    reopened.open_bank(str(saved_path))

    assert reopened.get_test_draft(detail.test.id).test.course_ids == ["physics-1"]


def test_seeding_a_course_pulls_in_standards_and_associates_tests(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.get_course_detail("physics-1")
    source_standard_ids = [ref.standard_id for ref in source.course.standard_refs]
    shared = bank_service.create_test_draft(
        title="Unit 1 Forces", version="A", course_ids=["physics-1"]
    )

    bank_service.upsert_course(
        course_id="physics-1-2027",
        title="Physics 1 (2027)",
        description=None,
        standard_refs=[],
    )
    detail = bank_service.seed_course_from("physics-1-2027", "physics-1")

    assert [ref.standard_id for ref in detail.course.standard_refs] == source_standard_ids
    assert [item.test_id for item in detail.tests] == [shared.test.id]
    # Associated, not copied: one test now reports coverage for both courses.
    assert bank_service.get_test_draft(shared.test.id).test.course_ids == [
        "physics-1",
        "physics-1-2027",
    ]


def test_seeding_a_course_can_take_standards_without_tests(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    bank_service.create_test_draft(title="Unit 1", version="A", course_ids=["physics-1"])
    bank_service.upsert_course(
        course_id="physics-standards-only",
        title="Physics (standards only)",
        description=None,
        standard_refs=[],
    )

    detail = bank_service.seed_course_from(
        "physics-standards-only", "physics-1", include_tests=False
    )

    assert detail.course.standard_refs
    assert detail.tests == []


def test_seeding_a_course_is_idempotent_and_refuses_itself(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    shared = bank_service.create_test_draft(
        title="Unit 1", version="A", course_ids=["physics-1"]
    )
    bank_service.upsert_course(
        course_id="physics-repeat", title="Physics Repeat", description=None, standard_refs=[]
    )

    first = bank_service.seed_course_from("physics-repeat", "physics-1")
    second = bank_service.seed_course_from("physics-repeat", "physics-1")

    assert [ref.standard_id for ref in first.course.standard_refs] == [
        ref.standard_id for ref in second.course.standard_refs
    ]
    assert bank_service.get_test_draft(shared.test.id).test.course_ids == [
        "physics-1",
        "physics-repeat",
    ]

    with pytest.raises(BankWorkspaceError) as exc_info:
        bank_service.seed_course_from("physics-repeat", "physics-repeat")
    assert exc_info.value.status_code == 400


def test_copying_a_shared_test_restores_the_original_for_the_other_course(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    shared = bank_service.create_test_draft(
        title="Unit 1 Forces", version="A", course_ids=["physics-1", "algebra-1"]
    )
    snapshot = bank_service.get_test_draft(shared.test.id).test.model_copy(deep=True)

    # The teacher edits the shared test, which autosaves for both courses.
    edited = bank_service.add_question_to_test(shared.test.id, "q_fr_0001").test
    assert len(edited.items) == 1

    copy = bank_service.copy_test_draft(
        shared.test.id,
        title="Unit 1 Forces (2027)",
        course_ids=["algebra-1"],
        detach_courses_from_source=True,
        source_restore=snapshot,
    )

    # The copy keeps the edits and only the course it was forked for.
    assert copy.test.id != shared.test.id
    assert copy.test.title == "Unit 1 Forces (2027)"
    assert [item.question_id for item in copy.test.items] == ["q_fr_0001"]
    assert copy.test.course_ids == ["algebra-1"]

    # The original goes back to what the other course had, and keeps that course.
    original = bank_service.get_test_draft(shared.test.id).test
    assert original.items == []
    assert original.course_ids == ["physics-1"]


def test_copying_a_test_defaults_to_the_source_courses_and_drops_results(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    source = bank_service.create_test_draft(
        title="Unit 2", version="B", course_ids=["physics-1"]
    )
    bank_service.add_question_to_test(source.test.id, "q_fr_0001")

    copy = bank_service.copy_test_draft(source.test.id)

    assert copy.test.course_ids == ["physics-1"]
    assert copy.test.title == "Unit 2"
    assert copy.test.version == "B"
    assert [item.question_id for item in copy.test.items] == ["q_fr_0001"]
    assert copy.test.performance_runs == []
    # Untouched, because no restore snapshot was supplied.
    assert bank_service.get_test_draft(source.test.id).test.course_ids == ["physics-1"]


def test_course_coverage_counts_a_test_once_across_its_versions(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    baseline = bank_service.get_course_detail("physics-1").question_count

    version_a = bank_service.create_test_draft(
        title="Kinematics Quiz", version="A", course_ids=["physics-1"]
    )
    for question_id in ("q_fr_0001", "q_fr_0002"):
        bank_service.add_question_to_test(version_a.test.id, question_id)

    after_one = bank_service.get_course_detail("physics-1")
    assert after_one.question_count == baseline + 2

    # Two more versions of the same test: security and retakes, not more assessment.
    for version in ("B", "C"):
        copy = bank_service.copy_test_draft(
            version_a.test.id, version=version, course_ids=["physics-1"]
        )
        assert copy.test.title == "Kinematics Quiz"

    detail = bank_service.get_course_detail("physics-1")
    assert detail.question_count == baseline + 2

    lineage = next(item for item in detail.tests if item.title == "Kinematics Quiz")
    assert lineage.versions == ["A", "B", "C"]
    assert len(lineage.test_ids) == 3
    assert lineage.question_count == 2
    # One row for the lineage, not one per version.
    assert [item.title for item in detail.tests].count("Kinematics Quiz") == 1


def test_course_coverage_takes_the_largest_version_when_versions_differ(
    bank_service: BankWorkspaceService,
    demo_bok: Path,
) -> None:
    bank_service.open_bank(str(demo_bok))
    bank_service.upsert_course(
        course_id="versions-course",
        title="Versions Course",
        description=None,
        standard_refs=[],
    )
    version_a = bank_service.create_test_draft(
        title="Retake Quiz", version="A", course_ids=["versions-course"]
    )
    bank_service.add_question_to_test(version_a.test.id, "q_fr_0001")

    version_b = bank_service.copy_test_draft(
        version_a.test.id, version="B", course_ids=["versions-course"]
    )
    bank_service.add_question_to_test(version_b.test.id, "q_fr_0002")

    detail = bank_service.get_course_detail("versions-course")
    lineage = next(item for item in detail.tests if item.title == "Retake Quiz")

    # B is the longer sitting at two questions; A's single question is not added on.
    assert lineage.question_count == 2
    assert detail.question_count == 2
    assert lineage.versions == ["A", "B"]

    # A standard reached by both versions still counts once.
    covered = {item.standard_id: item for item in detail.extra_standards}
    for coverage in covered.values():
        assert coverage.test_count == 1
        assert coverage.question_count <= 2
