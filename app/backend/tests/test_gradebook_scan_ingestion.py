from __future__ import annotations

from pathlib import Path

import pytest

from app.backend.gradebook_service import GradebookService
from app.backend.service import BankWorkspaceError, BankWorkspaceService
from app.backend.tests.grading_test_utils import fill_cells, png_bytes, rasterize_layout_page


def _build_mc_test(bank_service: BankWorkspaceService):
    detail = bank_service.create_test_draft("Unit 1 Mechanics", "A")
    return bank_service.add_question_to_test(detail.test.id, "q_mc_0001")


def _hand_off(bank_service, gradebook_service, tmp_path: Path, name: str = "period-2.nxgb"):
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / name))
    detail = _build_mc_test(bank_service)
    return gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )


def _fill_correct_choice_png(snapshot, dpi: int = 300) -> bytes:
    page = snapshot.layout.pages[0]
    mc_row = page.rows[0]
    correct_index = snapshot.answer_key.items[0].correct_choice_indices[0]
    image = rasterize_layout_page(snapshot.layout, 0, dpi)
    fill_cells(image, snapshot.layout, [mc_row.cells[correct_index]], dpi)
    return png_bytes(image)


def test_create_scan_batch_requires_existing_snapshot(tmp_path: Path) -> None:
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))
    with pytest.raises(BankWorkspaceError):
        gradebook_service.create_scan_batch("does-not-exist", None)


def test_ingest_correct_sheet_yields_matching_row_result(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)

    batch = gradebook_service.create_scan_batch(snapshot.id, "Period 2 scan")
    png = _fill_correct_choice_png(snapshot)

    updated_batch = gradebook_service.ingest_scan_batch(batch.id, [("scan1.png", png)])

    assert len(updated_batch.sheets) == 1
    sheet = updated_batch.sheets[0]
    assert sheet.identity_status == "unresolved"  # blank mode: no student_id in the QR
    assert sheet.needs_review is True  # identity still needs resolving, even though the mark is clean
    assert sheet.fiducial_confidence == 1.0
    assert len(sheet.row_results) == 1
    row = sheet.row_results[0]
    assert row.detected_choice_indices == snapshot.answer_key.items[0].correct_choice_indices
    assert row.flag == "none"


def test_ingest_qr_unreadable_sheet_gets_no_row_results(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    batch = gradebook_service.create_scan_batch(snapshot.id, None)

    image = rasterize_layout_page(snapshot.layout, 0, 300)
    qr = snapshot.layout.pages[0].qr_box
    scale = 300 / 72.0
    x0, x1 = int(qr.x_pt * scale), int((qr.x_pt + qr.width_pt) * scale)
    y0 = int((snapshot.layout.page_height_pt - qr.y_pt - qr.height_pt) * scale)
    y1 = int((snapshot.layout.page_height_pt - qr.y_pt) * scale)
    image[y0:y1, x0:x1] = 0

    updated_batch = gradebook_service.ingest_scan_batch(batch.id, [("corrupt.png", png_bytes(image))])

    sheet = updated_batch.sheets[0]
    assert sheet.identity_status == "qr_unreadable"
    assert sheet.row_results == []
    assert sheet.needs_review is True


def test_ingest_sheet_from_a_different_snapshot_flags_wrong_snapshot(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    first_snapshot = _hand_off(bank_service, gradebook_service, tmp_path)

    detail = _build_mc_test(bank_service)
    second_snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )

    # Scan a sheet from the second snapshot into a batch declared for the first.
    batch = gradebook_service.create_scan_batch(first_snapshot.id, None)
    png = _fill_correct_choice_png(second_snapshot)
    updated_batch = gradebook_service.ingest_scan_batch(batch.id, [("mismatch.png", png)])

    sheet = updated_batch.sheets[0]
    assert sheet.identity_status == "wrong_snapshot"
    assert sheet.snapshot_id == second_snapshot.id
    # Detection still ran -- we know the true geometry even though it's the
    # wrong batch -- so the read is still captured for the reviewer to see.
    assert sheet.row_results[0].detected_choice_indices == second_snapshot.answer_key.items[0].correct_choice_indices


def test_ingesting_after_bank_test_is_mutated_still_matches_frozen_snapshot(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    png = _fill_correct_choice_png(snapshot)

    # Mutate the live bank test *after* the hand-off and the scan was rendered.
    detail = bank_service.get_test_draft(snapshot.source_test_id)
    bank_service.update_test_draft(detail.test.id, detail.test.model_copy(update={"items": []}))

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated_batch = gradebook_service.ingest_scan_batch(batch.id, [("scan1.png", png)])

    sheet = updated_batch.sheets[0]
    assert sheet.identity_status == "unresolved"
    assert len(sheet.row_results) == 1
    assert sheet.row_results[0].detected_choice_indices == snapshot.answer_key.items[0].correct_choice_indices


def test_pre_id_sheet_is_pre_identified_and_does_not_need_identity_review(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    from app.backend.models import UpsertStudentRequest

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    detail = _build_mc_test(bank_service)
    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="pre_id",
        page_size="letter",
        blank_count=None,
        student_ids=[student.id],
    )
    png = _fill_correct_choice_png(snapshot)

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated_batch = gradebook_service.ingest_scan_batch(batch.id, [("scan1.png", png)])

    sheet = updated_batch.sheets[0]
    assert sheet.identity_status == "pre_identified"
    assert sheet.student_id == student.id
    assert sheet.needs_review is False  # clean mark + known identity == nothing to review


def test_ingest_via_api(gradebook_client, demo_bok: Path, tmp_path: Path) -> None:
    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})
    create_response = gradebook_client.post("/api/tests", json={"title": "Unit 1", "version": "A"})
    test_id = create_response.json()["test"]["id"]
    gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )
    handoff_response = gradebook_client.post(
        "/api/gradebook/administered-tests",
        json={"test_id": test_id, "mode": "blank", "blank_count": 1},
    )
    snapshot_body = handoff_response.json()

    batch_response = gradebook_client.post(
        "/api/gradebook/batches", json={"snapshot_id": snapshot_body["id"]}
    )
    batch_id = batch_response.json()["id"]

    from app.backend.models import AdministeredTestSnapshotModel

    snapshot = AdministeredTestSnapshotModel.model_validate(snapshot_body)
    png = _fill_correct_choice_png(snapshot)

    ingest_response = gradebook_client.post(
        f"/api/gradebook/batches/{batch_id}/ingest",
        files=[("files", ("scan1.png", png, "image/png"))],
    )
    assert ingest_response.status_code == 200
    sheets = ingest_response.json()["sheets"]
    assert len(sheets) == 1
    assert sheets[0]["row_results"][0]["detected_choice_indices"] == (
        snapshot.answer_key.items[0].correct_choice_indices
    )
