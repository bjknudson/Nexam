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
    test_payload = gradebook_client.get(f"/api/tests/{test_id}").json()["test"]
    test_payload["finished"] = True
    gradebook_client.put(f"/api/tests/{test_id}", json=test_payload)

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


def test_marking_a_row_blank_resolves_it_without_inventing_an_answer(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """A student who skipped a question is a valid reading, not a stuck flag."""

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
        batch_id, sheet_id, question_id, override_blank=True
    )

    row = next(r for r in updated_sheet.row_results if r.question_id == question_id)
    assert row.override_blank is True
    # No answer was invented on the student's behalf.
    assert row.override_choice_indices is None
    assert row.override_value is None
    # The raw detection still says what the scanner saw.
    assert row.flag == "no_mark"


def test_a_sheet_of_blanks_can_be_fully_reviewed(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Grace", last_name="Hopper")
    )
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)
    gradebook_service.resolve_sheet_identity(batch_id, sheet_id, student_id=student.id)

    sheet = gradebook_service.get_scan_batch(batch_id).sheets[0]
    assert sheet.needs_review is True

    for row in sheet.row_results:
        if row.kind == "manual_capture":
            sheet = gradebook_service.override_row_result(
                batch_id, sheet_id, row.question_id, manual_score=0.0
            )
        else:
            sheet = gradebook_service.override_row_result(
                batch_id, sheet_id, row.question_id, override_blank=True
            )

    # Every question answered "nothing" still finishes review.
    assert sheet.needs_review is False


def test_a_sheet_with_an_unreadable_qr_can_be_matched_to_a_printing_by_hand(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """A damaged QR leaves a readable page unscoreable. If a human can say which
    test it is, the corner markers still line it up and it scores normally."""

    import cv2
    from app.backend.tests.grading_test_utils import png_bytes, rasterize_layout_page

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)

    # A real page with its QR scribbled out.
    image = rasterize_layout_page(snapshot.layout, 0, 300)
    page = snapshot.layout.pages[0]
    scale = 300 / 72
    box = page.qr_box
    cv2.rectangle(
        image,
        (int(box.x_pt * scale), int((snapshot.layout.page_height_pt - box.y_pt - box.height_pt) * scale)),
        (
            int((box.x_pt + box.width_pt) * scale),
            int((snapshot.layout.page_height_pt - box.y_pt) * scale),
        ),
        0,
        -1,
    )
    correct = snapshot.answer_key.items[0].correct_choice_indices[0]
    from app.backend.tests.grading_test_utils import fill_cells

    fill_cells(image, snapshot.layout, [page.rows[0].cells[correct]], 300)

    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated = gradebook_service.ingest_scan_batch(batch.id, [("damaged.png", png_bytes(image))])
    sheet = updated.sheets[0]

    # As ingested it is unusable: no printing, no rows.
    assert sheet.identity_status == "qr_unreadable"
    assert sheet.row_results == []

    recovered = gradebook_service.reassign_sheet_to_printing(batch.id, sheet.id, snapshot.id)

    assert recovered.snapshot_id == snapshot.id
    assert recovered.fiducial_confidence is not None
    assert recovered.row_results, "the page should read once it is matched by hand"
    assert recovered.row_results[0].detected_choice_indices == [correct]


def test_matching_by_hand_still_fails_loudly_on_a_page_that_cannot_be_lined_up(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """Naming a printing must not become a way to pretend a blank page was read."""

    import numpy as np
    from app.backend.tests.grading_test_utils import png_bytes

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("blank.png", png_bytes(np.full((3300, 2550), 255, dtype=np.uint8)))]
    )

    with pytest.raises(BankWorkspaceError) as exc_info:
        gradebook_service.reassign_sheet_to_printing(
            batch.id, updated.sheets[0].id, snapshot.id
        )

    assert exc_info.value.status_code == 400
    assert "corner markers" in exc_info.value.message


def test_confirming_a_low_confidence_read_resolves_it_without_retyping(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """A faint but correct mark is the common case; accepting the read is the
    whole interaction, and it must clear the flag."""

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)
    gradebook_service.resolve_sheet_identity(batch_id, sheet_id, student_id=student.id)

    question_id = snapshot.answer_key.items[0].question_id
    # Confirming is an override set to exactly what the detector read.
    updated = gradebook_service.override_row_result(
        batch_id, sheet_id, question_id, override_choice_indices=[2]
    )

    row = next(r for r in updated.row_results if r.question_id == question_id)
    assert row.override_choice_indices == [2]
    assert updated.needs_review is False


def test_two_marks_score_against_a_multi_select_key(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """A multiple-select question is right only when the marks match the key
    exactly, and the same two marks on a single-select question are wrong."""

    from app.backend.grading.scoring import score_batch
    from app.backend.models import AnswerKeyItemModel

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    snapshot = _hand_off(bank_service, gradebook_service, tmp_path)
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )
    batch_id, sheet_id = _ingest_blank_sheet(gradebook_service, snapshot)
    gradebook_service.resolve_sheet_identity(batch_id, sheet_id, student_id=student.id)

    question_id = snapshot.answer_key.items[0].question_id
    gradebook_service.override_row_result(
        batch_id, sheet_id, question_id, override_choice_indices=[0, 2]
    )
    batch = gradebook_service.get_scan_batch(batch_id)
    students = gradebook_service.list_students().items

    # Against a key that wants exactly those two, the answer is right.
    multi = snapshot.model_copy(deep=True)
    multi.answer_key.items[0] = AnswerKeyItemModel(
        **{**snapshot.answer_key.items[0].model_dump(), "correct_choice_indices": [0, 2]}
    )
    assert score_batch(batch, multi, students).student_scores[0].points_earned > 0

    # Against a single-answer key, two marks are wrong -- not silently reduced.
    single = snapshot.model_copy(deep=True)
    single.answer_key.items[0] = AnswerKeyItemModel(
        **{**snapshot.answer_key.items[0].model_dump(), "correct_choice_indices": [0]}
    )
    by_item = {item.question_id: item for item in score_batch(batch, single, students).by_item}
    assert by_item[question_id].full_credit_count == 0


# -- Saving one field must not wipe the others --------------------------------


def _manual_row_sheet(bank_service, gradebook_service, tmp_path):
    """A scanned sheet with one written-response row to score."""

    from app.backend.tests.test_gradebook_performance_export import _hand_off
    from app.backend.tests.grading_test_utils import rasterize_layout_page

    snapshot = _hand_off(bank_service, gradebook_service, ["q_fr_0001"], "Projectiles")
    batch = gradebook_service.create_scan_batch(snapshot.id, None)
    updated = gradebook_service.ingest_scan_batch(
        batch.id, [("sheet.png", png_bytes(rasterize_layout_page(snapshot.layout, 0, 300)))]
    )
    return snapshot, batch, updated.sheets[0]


def test_scoring_a_row_leaves_the_grader_note_alone(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """The whole-row overwrite meant every save cleared whatever it did not
    mention -- entering a score wiped the note written beside it."""

    bank_service.open_bank(str(demo_bok))
    service = GradebookService()
    service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    _, batch, sheet = _manual_row_sheet(bank_service, service, tmp_path)

    service.override_row_result(
        batch.id, sheet.id, "q_fr_0001", manual_grader_note="Check the units in part b."
    )
    service.override_row_result(batch.id, sheet.id, "q_fr_0001", manual_score=6.0)

    row = service.get_scan_batch(batch.id).sheets[0].row_results[0]
    assert row.manual_score == 6.0
    assert row.manual_grader_note == "Check the units in part b."


def test_scoring_a_row_leaves_points_possible_alone(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    service = GradebookService()
    service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    _, batch, sheet = _manual_row_sheet(bank_service, service, tmp_path)

    service.override_row_result(batch.id, sheet.id, "q_fr_0001", manual_score_max=8.0)
    service.override_row_result(batch.id, sheet.id, "q_fr_0001", manual_score=8.0)

    row = service.get_scan_batch(batch.id).sheets[0].row_results[0]
    assert row.manual_score_max == 8.0
    # Full credit is judged against the max, so losing it changed the result.
    assert row.manual_score == 8.0


def test_an_explicit_null_still_clears_a_field(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """Not mentioning a field leaves it; naming it as null clears it. The two
    have to stay distinguishable or a note could never be deleted."""

    bank_service.open_bank(str(demo_bok))
    service = GradebookService()
    service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    _, batch, sheet = _manual_row_sheet(bank_service, service, tmp_path)

    service.override_row_result(batch.id, sheet.id, "q_fr_0001", manual_grader_note="Draft")
    service.override_row_result(batch.id, sheet.id, "q_fr_0001", manual_grader_note=None)

    row = service.get_scan_batch(batch.id).sheets[0].row_results[0]
    assert row.manual_grader_note is None


def test_a_total_entered_directly_supersedes_a_stale_breakdown(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """The parts no longer add up to the total, so keeping them would leave
    Rubric Levels laddering evidence that contradicts the score."""

    bank_service.open_bank(str(demo_bok))
    service = GradebookService()
    service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    _, batch, sheet = _manual_row_sheet(bank_service, service, tmp_path)

    service.override_row_result(batch.id, sheet.id, "q_fr_0001", component_scores=[1.0, 2.0])
    assert service.get_scan_batch(batch.id).sheets[0].row_results[0].manual_score == 3.0

    service.override_row_result(batch.id, sheet.id, "q_fr_0001", manual_score=9.0)
    row = service.get_scan_batch(batch.id).sheets[0].row_results[0]
    assert row.manual_score == 9.0
    assert row.component_scores is None


def test_correcting_an_answer_leaves_the_override_note_alone(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    service = GradebookService()
    service.create_gradebook("Period 2", None, str(tmp_path / "gb.nxgb"))
    snapshot = _hand_off(bank_service, service, tmp_path)
    batch = service.create_scan_batch(snapshot.id, None)
    updated = service.ingest_scan_batch(
        batch.id, [("scan.png", _fill_correct_choice_png(snapshot))]
    )
    sheet_id = updated.sheets[0].id
    question_id = snapshot.answer_key.items[0].question_id

    service.override_row_result(
        batch.id, sheet_id, question_id, override_note="Smudged, read as B."
    )
    service.override_row_result(batch.id, sheet_id, question_id, override_choice_indices=[1])

    row = service.get_scan_batch(batch.id).sheets[0].row_results[0]
    assert row.override_choice_indices == [1]
    assert row.override_note == "Smudged, read as B."


def test_the_http_route_only_applies_what_the_body_carried(
    gradebook_client, demo_bok: Path, tmp_path: Path
) -> None:
    """The same guarantee over the wire: a body naming one field must not null
    the rest, which is where the frontend's `?? null` payload went wrong."""

    from app.backend import main

    assert gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200
    assert (
        gradebook_client.post(
            "/api/gradebook/create",
            json={"title": "P2", "destination_path": str(tmp_path / "gb.nxgb")},
        ).status_code
        == 200
    )
    _, batch, sheet = _manual_row_sheet(main.service, main.gradebook_service, tmp_path)
    url = f"/api/gradebook/batches/{batch.id}/sheets/{sheet.id}/rows/q_fr_0001"

    assert gradebook_client.put(url, json={"manual_grader_note": "Partial credit for setup"}).status_code == 200
    assert gradebook_client.put(url, json={"manual_score": 5.0}).status_code == 200

    row = gradebook_client.get(f"/api/gradebook/batches/{batch.id}").json()["sheets"][0][
        "row_results"
    ][0]
    assert row["manual_score"] == 5.0
    assert row["manual_grader_note"] == "Partial credit for setup"
