from __future__ import annotations

from pathlib import Path

import pytest

from app.backend.gradebook_service import GradebookService
from app.backend.models import UpsertStudentRequest
from app.backend.service import BankWorkspaceError, BankWorkspaceService
from app.backend.tests.grading_test_utils import png_bytes, rasterize_layout_page
from app.backend.tests.test_gradebook_scan_ingestion import _fill_correct_choice_png, _hand_off


def _ingest_blank_sheet(gradebook_service, snapshot):
    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    blank_png = png_bytes(rasterize_layout_page(snapshot.layout, 0, 300))
    updated = gradebook_service.ingest_scan_batch(batch.id, [("blank.png", blank_png)])
    return updated.id, updated.sheets[0].id


def test_resolve_identity_by_student_id_clears_identity_review(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    png = _fill_correct_choice_png(snapshot)
    updated = gradebook_service.ingest_scan_batch(batch.id, [("scan1.png", png)])
    sheet = updated.sheets[0]
    assert sheet.identity_status == "unresolved"
    assert sheet.needs_review is True  # clean mark, but identity still unknown

    resolved = gradebook_service.resolve_sheet_identity(
        batch.id, sheet.id, student_id=student.id
    )
    assert resolved.identity_status == "manually_resolved"
    assert resolved.student_id == student.id
    assert resolved.needs_review is False  # mark was clean, identity now known


def test_resolve_identity_by_free_text_name(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    png = _fill_correct_choice_png(snapshot)
    updated = gradebook_service.ingest_scan_batch(batch.id, [("scan1.png", png)])
    sheet_id = updated.sheets[0].id

    resolved = gradebook_service.resolve_sheet_identity(
        batch.id, sheet_id, free_text_name="Transfer Student"
    )
    assert resolved.identity_status == "manually_resolved"
    assert resolved.free_text_name == "Transfer Student"
    assert resolved.student_id is None


def test_resolve_identity_requires_a_target(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)

    with pytest.raises(BankWorkspaceError):
        gradebook_service.resolve_sheet_identity(batch_id, sheet_id)


def test_resolve_identity_rejects_unknown_student(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)

    with pytest.raises(BankWorkspaceError):
        gradebook_service.resolve_sheet_identity(batch_id, sheet_id, student_id="nope")


def test_override_choice_indices_on_blank_row_clears_that_rows_review_flag(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)
    gradebook_service.resolve_sheet_identity(batch_id, sheet_id, student_id=student.id)

    question_id = snapshot.answer_key.items[0].question_id
    updated_sheet = gradebook_service.override_row_result(
        batch_id,
        sheet_id,
        question_id,
        override_choice_indices=[1],
        override_note="Student circled the letter instead of filling the bubble.",
    )
    row = next(r for r in updated_sheet.row_results if r.question_id == question_id)
    assert row.override_choice_indices == [1]
    assert row.flag == "no_mark"  # raw detection is untouched, only the override sits alongside it
    assert updated_sheet.needs_review is False


def test_override_unknown_question_id_raises(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)

    with pytest.raises(BankWorkspaceError):
        gradebook_service.override_row_result(batch_id, sheet_id, "not-a-question", override_choice_indices=[0])


def test_manual_capture_row_needs_review_until_scored(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))
    # Only a manual-capture question, so identity is the sole other thing
    # standing between this sheet and needs_review == False.
    detail = bank_service.create_test_draft("Circuits Quiz", "A")
    detail = bank_service.add_question_to_test(detail.test.id, "q_sa_0001")
    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)
    gradebook_service.resolve_sheet_identity(batch_id, sheet_id, student_id=student.id)

    manual_question_id = next(
        item.question_id for item in snapshot.answer_key.items if item.row_kind == "manual_capture"
    )
    sheet = gradebook_service.get_scan_batch(batch_id).sheets[0]
    assert sheet.needs_review is True  # manual row always starts needing a human score

    scored_sheet = gradebook_service.override_row_result(
        batch_id, sheet_id, manual_question_id, manual_score=1.5, manual_score_max=2.0
    )
    manual_row = next(r for r in scored_sheet.row_results if r.question_id == manual_question_id)
    assert manual_row.manual_score == 1.5
    assert scored_sheet.needs_review is False


def test_review_queue_only_lists_sheets_still_needing_attention(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    clean_png = _fill_correct_choice_png(snapshot)
    blank_png = png_bytes(rasterize_layout_page(snapshot.layout, 0, 300))
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("clean.png", clean_png), ("blank.png", blank_png)]
    )
    clean_sheet_id, blank_sheet_id = (s.id for s in updated.sheets)

    assert {s.id for s in gradebook_service.get_review_queue(batch.id)} == {
        clean_sheet_id,
        blank_sheet_id,
    }

    gradebook_service.resolve_sheet_identity(batch.id, clean_sheet_id, student_id=student.id)
    remaining = gradebook_service.get_review_queue(batch.id)
    assert {s.id for s in remaining} == {blank_sheet_id}


def test_sheet_image_bytes_match_what_was_ingested(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    png = _fill_correct_choice_png(snapshot)
    updated = gradebook_service.ingest_scan_batch(batch.id, [("scan1.png", png)])

    stored_bytes = gradebook_service.get_sheet_image_bytes(batch.id, updated.sheets[0].id)
    assert stored_bytes[:8] == b"\x89PNG\r\n\x1a\n"


def test_review_workflow_via_api(gradebook_client, demo_bok: Path, tmp_path: Path) -> None:
    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})
    create_response = gradebook_client.post("/api/tests", json={"title": "Unit 1", "version": "A"})
    test_id = create_response.json()["test"]["id"]
    gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )
    student_response = gradebook_client.post(
        "/api/gradebook/students", json={"first_name": "Ada", "last_name": "Lovelace"}
    )
    student_id = student_response.json()["id"]

    handoff_response = gradebook_client.post(
        "/api/gradebook/administered-tests",
        json={"test_id": test_id, "mode": "blank", "blank_count": 1},
    )
    snapshot_body = handoff_response.json()
    question_id = snapshot_body["answer_key"]["items"][0]["question_id"]

    batch_response = gradebook_client.post(
        "/api/gradebook/batches", json={"snapshot_id": snapshot_body["id"]}
    )
    batch_id = batch_response.json()["id"]

    from app.backend.models import AdministeredTestSnapshotModel

    snapshot = AdministeredTestSnapshotModel.model_validate(snapshot_body)
    blank_png = png_bytes(rasterize_layout_page(snapshot.layout, 0, 300))
    ingest_response = gradebook_client.post(
        f"/api/gradebook/batches/{batch_id}/ingest",
        files=[("files", ("blank.png", blank_png, "image/png"))],
    )
    sheet_id = ingest_response.json()["sheets"][0]["id"]

    queue_response = gradebook_client.get(f"/api/gradebook/batches/{batch_id}/review-queue")
    assert len(queue_response.json()["items"]) == 1

    image_response = gradebook_client.get(
        f"/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/image"
    )
    assert image_response.status_code == 200
    assert image_response.content[:4] == b"\x89PNG"

    gradebook_client.put(
        f"/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/identity",
        json={"student_id": student_id},
    )
    override_response = gradebook_client.put(
        f"/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/rows/{question_id}",
        json={"override_choice_indices": [1]},
    )
    assert override_response.json()["needs_review"] is False

    queue_after_response = gradebook_client.get(f"/api/gradebook/batches/{batch_id}/review-queue")
    assert queue_after_response.json()["items"] == []
