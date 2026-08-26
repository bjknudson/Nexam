from __future__ import annotations

from pathlib import Path

import pytest

from app.backend.gradebook_service import GradebookService
from app.backend.models import UpsertStudentRequest
from app.backend.service import BankWorkspaceError, BankWorkspaceService


def _build_mixed_test(bank_service: BankWorkspaceService):
    """One MC, one numeric, one manual (short-answer) item -- exercises all
    three SheetRowModel kinds in a single hand-off."""
    detail = bank_service.create_test_draft("Unit 1 Mechanics", "A")
    detail = bank_service.add_question_to_test(detail.test.id, "q_mc_0001")
    detail = bank_service.add_question_to_test(detail.test.id, "q_num_0001")
    detail = bank_service.add_question_to_test(detail.test.id, "q_sa_0001")
    return detail


def _ready_gradebook(tmp_path: Path, name: str = "period-2.nxgb") -> GradebookService:
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / name))
    return gradebook_service


def test_hand_off_produces_snapshot_with_all_three_row_kinds(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = _build_mixed_test(bank_service)
    gradebook_service = _ready_gradebook(tmp_path)

    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=3,
        student_ids=None,
    )

    assert snapshot.source_test_id == detail.test.id
    assert snapshot.source_bank_title == "Physics 1"
    row_kinds = [item.row_kind for item in snapshot.answer_key.items]
    assert row_kinds == ["multiple_choice", "numeric_response", "manual_capture"]
    # q_mc_0001=1pt, q_num_0001=2pt, q_sa_0001=2pt in the demo bank.
    assert snapshot.answer_key.total_points == pytest.approx(5.0)

    mc_item = snapshot.answer_key.items[0]
    assert mc_item.correct_choice_indices == [1]
    assert mc_item.choice_count == 4

    # 3 blank copies, one page each (rows fit on one page for this test).
    assert len(snapshot.layout.pages) == 3
    sheet_ids = {page.qr_box.width_pt for page in snapshot.layout.pages}  # sanity: geometry present
    assert sheet_ids == {72.0}

    pdf_bytes = gradebook_service.get_sheet_pdf_bytes(snapshot.layout.id)
    assert pdf_bytes.startswith(b"%PDF")


def test_reprint_creates_a_new_distinct_snapshot(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = _build_mixed_test(bank_service)
    gradebook_service = _ready_gradebook(tmp_path)

    first = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )
    second = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )

    assert first.id != second.id
    assert first.layout.id != second.layout.id

    listing = gradebook_service.list_administered_tests().items
    assert {summary.id for summary in listing} == {first.id, second.id}


def test_editing_bank_test_after_handoff_does_not_change_existing_snapshot(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = _build_mixed_test(bank_service)
    gradebook_service = _ready_gradebook(tmp_path)

    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )
    original_item_count = len(snapshot.answer_key.items)

    # Mutate the live bank test -- remove all items -- after the hand-off.
    bank_service.update_test_draft(
        detail.test.id, detail.test.model_copy(update={"items": []})
    )
    reopened = bank_service.get_test_draft(detail.test.id)
    assert reopened.test.items == []

    listing = gradebook_service.list_administered_tests().items
    assert listing[0].total_points == snapshot.answer_key.total_points
    assert original_item_count == 3


def test_pre_id_mode_prints_roster_names_and_requires_known_students(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = _build_mixed_test(bank_service)
    gradebook_service = _ready_gradebook(tmp_path)

    with pytest.raises(BankWorkspaceError):
        gradebook_service.create_snapshot_and_sheets(
            test=detail.test,
            questions=detail.questions,
            source_bank_title="Physics 1",
            mode="pre_id",
            page_size="letter",
            blank_count=None,
            student_ids=["does-not-exist"],
        )

    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="pre_id",
        page_size="letter",
        blank_count=None,
        student_ids=[student.id],
    )
    assert len(snapshot.layout.pages) == 1
    assert snapshot.layout.pages[0].printed_name == "Ada Lovelace"
    assert snapshot.layout.pages[0].name_box is not None


def test_handoff_via_api(gradebook_client, demo_bok: Path, tmp_path: Path) -> None:
    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})
    create_response = gradebook_client.post("/api/tests", json={"title": "Unit 1", "version": "A"})
    test_id = create_response.json()["test"]["id"]
    gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})
    gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_num_0001"})

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )

    handoff_response = gradebook_client.post(
        "/api/gradebook/administered-tests",
        json={"test_id": test_id, "mode": "blank", "blank_count": 2},
    )
    assert handoff_response.status_code == 200
    body = handoff_response.json()
    assert body["source_test_id"] == test_id
    layout_id = body["layout"]["id"]

    list_response = gradebook_client.get("/api/gradebook/administered-tests")
    assert len(list_response.json()["items"]) == 1

    pdf_response = gradebook_client.get(f"/api/gradebook/sheets/{layout_id}/pdf")
    assert pdf_response.status_code == 200
    assert pdf_response.content.startswith(b"%PDF")
