from __future__ import annotations

from pathlib import Path

from app.backend.gradebook_service import GradebookService
from app.backend.models import UpsertStudentRequest
from app.backend.service import BankWorkspaceService
from app.backend.tests.grading_test_utils import (
    fill_cells,
    numeric_correct_fill_cells,
    png_bytes,
    rasterize_layout_page,
)


def _build_mixed_test(bank_service: BankWorkspaceService, title: str = "Unit 1 Mechanics", version: str = "A"):
    detail = bank_service.create_test_draft(title, version)
    detail = bank_service.add_question_to_test(detail.test.id, "q_mc_0001")
    detail = bank_service.add_question_to_test(detail.test.id, "q_num_0001")
    detail = bank_service.add_question_to_test(detail.test.id, "q_sa_0001")
    return detail


def _hand_off_mixed(bank_service, gradebook_service, tmp_path, title="Unit 1 Mechanics", version="A", gb_name="gb.nxgb"):
    detail = _build_mixed_test(bank_service, title, version)
    return gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Physics 1",
        mode="blank",
        page_size="letter",
        blank_count=2,
        student_ids=None,
    )


def _all_correct_image(snapshot, dpi=300):
    image = rasterize_layout_page(snapshot.layout, 0, dpi)
    rows_by_kind = {row.kind: row for row in snapshot.layout.pages[0].rows}
    items_by_kind = {item.row_kind: item for item in snapshot.answer_key.items}

    mc_item = items_by_kind["multiple_choice"]
    mc_row = rows_by_kind["multiple_choice"]
    fill_cells(image, snapshot.layout, [mc_row.cells[mc_item.correct_choice_indices[0]]], dpi)

    numeric_item = items_by_kind["numeric_response"]
    numeric_row = rows_by_kind["numeric_response"]
    fill_cells(image, snapshot.layout, numeric_correct_fill_cells(numeric_row, numeric_item), dpi)

    return image


def _all_wrong_image(snapshot, dpi=300):
    image = rasterize_layout_page(snapshot.layout, 0, dpi)
    rows_by_kind = {row.kind: row for row in snapshot.layout.pages[0].rows}
    items_by_kind = {item.row_kind: item for item in snapshot.answer_key.items}

    mc_item = items_by_kind["multiple_choice"]
    mc_row = rows_by_kind["multiple_choice"]
    wrong_index = next(i for i in range(mc_item.choice_count) if i not in mc_item.correct_choice_indices)
    fill_cells(image, snapshot.layout, [mc_row.cells[wrong_index]], dpi)
    # numeric row left blank -> no_mark, definitely wrong
    return image


def _manual_question_id(snapshot):
    return next(item.question_id for item in snapshot.answer_key.items if item.row_kind == "manual_capture")


def _mc_question_id(snapshot):
    return next(item.question_id for item in snapshot.answer_key.items if item.row_kind == "multiple_choice")


def test_grade_report_reflects_correct_and_wrong_sheets(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    snapshot = _hand_off_mixed(bank_service, gradebook_service, tmp_path)

    ada = gradebook_service.upsert_student(None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace"))
    grace = gradebook_service.upsert_student(None, UpsertStudentRequest(first_name="Grace", last_name="Hopper"))

    batch = gradebook_service.create_scan_batch(snapshot.id, "Period 2 scan")
    correct_png = png_bytes(_all_correct_image(snapshot))
    wrong_png = png_bytes(_all_wrong_image(snapshot))
    updated = gradebook_service.ingest_scan_batch(batch.id, [("correct.png", correct_png), ("wrong.png", wrong_png)])
    correct_sheet_id, wrong_sheet_id = (s.id for s in updated.sheets)

    gradebook_service.resolve_sheet_identity(batch.id, correct_sheet_id, student_id=ada.id)
    gradebook_service.resolve_sheet_identity(batch.id, wrong_sheet_id, student_id=grace.id)

    manual_question_id = _manual_question_id(snapshot)
    report = gradebook_service.get_grade_report(batch.id)
    assert report.contains_unscored_manual_items is True

    gradebook_service.override_row_result(batch.id, correct_sheet_id, manual_question_id, manual_score=2.0, manual_score_max=2.0)
    gradebook_service.override_row_result(batch.id, wrong_sheet_id, manual_question_id, manual_score=0.0, manual_score_max=2.0)

    report = gradebook_service.get_grade_report(batch.id)
    assert report.contains_unscored_manual_items is False
    assert report.scored_sheet_count == 2
    assert report.excluded_sheet_count == 0
    assert report.total_possible_points == snapshot.answer_key.total_points

    by_item = {item.question_id: item for item in report.by_item}
    mc_question_id = _mc_question_id(snapshot)
    assert by_item[mc_question_id].attempts == 2
    assert by_item[mc_question_id].full_credit_count == 1
    assert by_item[mc_question_id].percent_full_credit == 50.0
    assert by_item[manual_question_id].full_credit_count == 1

    scores_by_student = {score.student_id: score for score in report.student_scores}
    assert scores_by_student[ada.id].percent_correct == 100.0
    assert scores_by_student[grace.id].percent_correct == 0.0
    assert report.average_percent_correct == 50.0
    assert sum(report.score_histogram.values()) == 2

    by_standard = {entry.standard_id: entry for entry in report.by_standard}
    assert by_standard["PHY-KIN-01"].attempts == 2  # q_mc_0001's standard
    assert by_standard["PHY-KIN-01"].full_credit_count == 1
    assert by_standard["PHY-ELE-01"].full_credit_count == 1  # q_sa_0001's standard


def test_excluded_sheets_are_not_scored(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    snapshot = _hand_off_mixed(bank_service, gradebook_service, tmp_path)

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    correct_png = png_bytes(_all_correct_image(snapshot))

    corrupted = rasterize_layout_page(snapshot.layout, 0, 300)
    qr = snapshot.layout.pages[0].qr_box
    scale = 300 / 72.0
    x0, x1 = int(qr.x_pt * scale), int((qr.x_pt + qr.width_pt) * scale)
    y0 = int((snapshot.layout.page_height_pt - qr.y_pt - qr.height_pt) * scale)
    y1 = int((snapshot.layout.page_height_pt - qr.y_pt) * scale)
    corrupted[y0:y1, x0:x1] = 0

    gradebook_service.ingest_scan_batch(
        batch.id, [("correct.png", correct_png), ("unreadable.png", png_bytes(corrupted))]
    )

    report = gradebook_service.get_grade_report(batch.id)
    assert report.scored_sheet_count == 1
    assert report.excluded_sheet_count == 1
    assert report.student_scores == []  # neither sheet has a resolved identity yet


def test_combined_lineage_report_sums_across_versions(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))

    snapshot_a = _hand_off_mixed(bank_service, gradebook_service, tmp_path, title="Unit 1 Mechanics", version="A")
    snapshot_b = _hand_off_mixed(bank_service, gradebook_service, tmp_path, title="unit 1 mechanics", version="B")

    batch_a = gradebook_service.create_scan_batch(snapshot_a.id, None)
    gradebook_service.ingest_scan_batch(batch_a.id, [("a.png", png_bytes(_all_correct_image(snapshot_a)))])

    batch_b = gradebook_service.create_scan_batch(snapshot_b.id, None)
    gradebook_service.ingest_scan_batch(batch_b.id, [("b.png", png_bytes(_all_correct_image(snapshot_b)))])

    combined = gradebook_service.get_combined_lineage_report("Unit 1 Mechanics")
    assert set(combined.batch_ids) == {batch_a.id, batch_b.id}
    assert combined.scored_sheet_count == 2

    by_standard = {entry.standard_id: entry for entry in combined.by_standard}
    assert by_standard["PHY-KIN-01"].attempts == 2  # summed across both versions, not maxed
    assert by_standard["PHY-KIN-01"].full_credit_count == 2


def test_record_batch_as_performance_run_writes_into_bank(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    snapshot = _hand_off_mixed(bank_service, gradebook_service, tmp_path)

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    gradebook_service.ingest_scan_batch(batch.id, [("a.png", png_bytes(_all_correct_image(snapshot)))])

    run = gradebook_service.build_performance_run(batch.id, cohort_label="Period 2")
    updated_test = bank_service.add_performance_run(snapshot.source_test_id, run)

    assert len(updated_test.test.performance_runs) == 1
    recorded = updated_test.test.performance_runs[0]
    assert recorded.cohort_label == "Period 2"
    mc_item_result = next(r for r in recorded.item_results if r.question_id == _mc_question_id(snapshot))
    assert mc_item_result.attempts == 1
    assert mc_item_result.correct == 1


def test_reporting_via_api(gradebook_client, demo_bok: Path, tmp_path: Path) -> None:
    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})
    create_response = gradebook_client.post("/api/tests", json={"title": "Unit 1", "version": "A"})
    test_id = create_response.json()["test"]["id"]
    gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "gb.nxgb")},
    )
    handoff_response = gradebook_client.post(
        "/api/gradebook/administered-tests",
        json={"test_id": test_id, "mode": "blank", "blank_count": 1},
    )
    snapshot_body = handoff_response.json()

    from app.backend.models import AdministeredTestSnapshotModel

    snapshot = AdministeredTestSnapshotModel.model_validate(snapshot_body)
    batch_response = gradebook_client.post(
        "/api/gradebook/batches", json={"snapshot_id": snapshot.id}
    )
    batch_id = batch_response.json()["id"]

    correct_png = png_bytes(_all_correct_image_mc_only(snapshot))
    gradebook_client.post(
        f"/api/gradebook/batches/{batch_id}/ingest",
        files=[("files", ("scan1.png", correct_png, "image/png"))],
    )

    report_response = gradebook_client.get(f"/api/gradebook/batches/{batch_id}/report")
    assert report_response.status_code == 200
    assert report_response.json()["scored_sheet_count"] == 1

    combined_response = gradebook_client.get(
        "/api/gradebook/report/combined", params={"test_title": "Unit 1"}
    )
    assert combined_response.status_code == 200
    assert combined_response.json()["scored_sheet_count"] == 1

    record_response = gradebook_client.post(
        f"/api/gradebook/batches/{batch_id}/record-performance-run",
        json={"cohort_label": "Period 2"},
    )
    assert record_response.status_code == 200
    assert len(record_response.json()["test"]["performance_runs"]) == 1


def _all_correct_image_mc_only(snapshot, dpi=300):
    image = rasterize_layout_page(snapshot.layout, 0, dpi)
    row = snapshot.layout.pages[0].rows[0]
    item = snapshot.answer_key.items[0]
    fill_cells(image, snapshot.layout, [row.cells[item.correct_choice_indices[0]]], dpi)
    return image
