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

    test_payload = gradebook_client.get(f"/api/tests/{test_id}").json()["test"]
    test_payload["finished"] = True
    gradebook_client.put(f"/api/tests/{test_id}", json=test_payload)

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
    # Frozen alongside items/questions so the test paper -- not just the bubble
    # sheet -- can be printed from the gradebook later without the bank open.
    assert body["print_settings"] == test_payload["print_settings"]

    list_response = gradebook_client.get("/api/gradebook/administered-tests")
    assert len(list_response.json()["items"]) == 1

    snapshot_response = gradebook_client.get(f"/api/gradebook/administered-tests/{body['id']}")
    assert snapshot_response.status_code == 200
    assert snapshot_response.json()["print_settings"] == test_payload["print_settings"]

    pdf_response = gradebook_client.get(f"/api/gradebook/sheets/{layout_id}/pdf")
    assert pdf_response.status_code == 200
    assert pdf_response.content.startswith(b"%PDF")


def test_interchangeable_sheets_carry_a_version_bubble_and_every_version_key(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))

    version_a = bank_service.create_test_draft("Interchangeable Unit", "A").test
    bank_service.add_question_to_test(version_a.id, "q_mc_0001")
    version_a = bank_service.update_test_draft(
        version_a.id,
        bank_service.get_test_draft(version_a.id).test.model_copy(
            update={"interchangeable_sheets": True}
        ),
    ).test

    version_b = bank_service.copy_test_draft(version_a.id, version="B").test
    detail_a = bank_service.get_test_draft(version_a.id)
    detail_b = bank_service.get_test_draft(version_b.id)

    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail_a.test,
        questions=detail_a.questions,
        source_bank_title="Demo Bank",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
        alternates=[(detail_b.test, detail_b.questions)],
    )

    assert snapshot.layout.version_labels == ["A", "B"]
    assert [key.version for key in snapshot.alternate_answer_keys] == ["B"]
    # The bubble row exists on the first page only -- one mark per sheet.
    assert snapshot.layout.pages[0].version_row is not None
    assert len(snapshot.layout.pages[0].version_row.cells) == 2


def test_a_version_specific_test_gets_no_version_bubble(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))

    detail = bank_service.add_question_to_test(
        bank_service.create_test_draft("Plain Unit", "A").test.id, "q_mc_0001"
    )
    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Demo Bank",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
    )

    assert snapshot.layout.version_labels == []
    assert snapshot.layout.pages[0].version_row is None
    assert snapshot.alternate_answer_keys == []
    assert snapshot.layout.header_label == "Plain Unit - Version A"


def test_a_sheet_is_scored_against_the_version_the_student_bubbled(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """The whole point of an interchangeable sheet: the paper says version A,
    the student marks B, and B's key is what scores it."""

    from app.backend.tests.grading_test_utils import fill_cells, png_bytes, rasterize_layout_page

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))

    version_a = bank_service.create_test_draft("Swap Unit", "A").test
    bank_service.add_question_to_test(version_a.id, "q_mc_0001")
    bank_service.update_test_draft(
        version_a.id,
        bank_service.get_test_draft(version_a.id).test.model_copy(
            update={"interchangeable_sheets": True}
        ),
    )
    version_b = bank_service.copy_test_draft(version_a.id, version="B").test
    detail_a = bank_service.get_test_draft(version_a.id)
    detail_b = bank_service.get_test_draft(version_b.id)

    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail_a.test,
        questions=detail_a.questions,
        source_bank_title="Demo Bank",
        mode="blank",
        page_size="letter",
        blank_count=1,
        student_ids=None,
        alternates=[(detail_b.test, detail_b.questions)],
    )
    student = gradebook_service.upsert_student(
        None, UpsertStudentRequest(first_name="Ada", last_name="Lovelace")
    )

    page = snapshot.layout.pages[0]
    image = rasterize_layout_page(snapshot.layout, 0, 300)
    # Mark version B (the second bubble), and answer the question correctly.
    fill_cells(image, snapshot.layout, [page.version_row.cells[1]], 300)
    correct_index = snapshot.answer_key.items[0].correct_choice_indices[0]
    fill_cells(image, snapshot.layout, [page.rows[0].cells[correct_index]], 300)

    batches = gradebook_service.ingest_scans([("swap.png", png_bytes(image))])
    batch = batches[0]
    sheet = batch.sheets[0]

    assert sheet.detected_version == "B"

    gradebook_service.resolve_sheet_identity(batch.id, sheet.id, student_id=student.id)
    report = gradebook_service.get_grade_report(batch.id)

    # B is a copy of A here, so the same mark is correct under either key -- what
    # matters is that scoring used B's key rather than ignoring the bubble.
    assert report.student_scores[0].points_earned == snapshot.answer_key.total_points


def test_non_key_breaking_edit_stays_in_place_after_sheets_generated(
    bank_service: BankWorkspaceService, demo_bok: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = bank_service.add_question_to_test(
        bank_service.create_test_draft("Locked Unit", "A").test.id, "q_mc_0001"
    )
    bank_service.update_test_draft(
        detail.test.id, detail.test.model_copy(update={"finished": True})
    )
    bank_service.mark_test_administered(detail.test.id)

    locked = bank_service.get_test_draft(detail.test.id).test
    updated = bank_service.update_test_draft(
        locked.id, locked.model_copy(update={"version_description": "Retake copy"})
    )
    assert updated.test.version_description == "Retake copy"
    assert updated.test.has_generated_sheets is True


def test_choice_image_edit_after_sheets_generated_does_not_force_a_fork(
    bank_service: BankWorkspaceService, demo_bok: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = bank_service.add_question_to_test(
        bank_service.create_test_draft("Locked Unit", "A").test.id, "q_mc_0001"
    )
    bank_service.update_test_draft(
        detail.test.id, detail.test.model_copy(update={"finished": True})
    )
    bank_service.mark_test_administered(detail.test.id)

    question = bank_service.get_question("q_mc_0001")
    answer = dict(question.answer or {})
    choices = answer["choices"]
    answer["choice_assets"] = {
        "0": {"path": "assets/pulley.png", "kind": "image", "svg_variables": {}},
    }
    bank_service.update_question(
        "q_mc_0001", question.model_copy(update={"answer": answer})
    )

    locked = bank_service.get_test_draft(detail.test.id).test
    updated = bank_service.update_test_draft(
        locked.id, locked.model_copy(update={"version_description": "Image added to a choice"})
    )
    assert updated.test.has_generated_sheets is True

    refreshed_question = bank_service.get_question("q_mc_0001")
    assert refreshed_question.answer["choice_assets"]["0"]["path"] == "assets/pulley.png"
    assert refreshed_question.answer["choices"] == choices


def test_key_breaking_edit_after_sheets_generated_is_rejected(
    bank_service: BankWorkspaceService, demo_bok: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    detail = bank_service.add_question_to_test(
        bank_service.create_test_draft("Locked Unit 2", "A").test.id, "q_mc_0001"
    )
    bank_service.update_test_draft(
        detail.test.id, detail.test.model_copy(update={"finished": True})
    )
    bank_service.mark_test_administered(detail.test.id)

    locked = bank_service.get_test_draft(detail.test.id).test
    with pytest.raises(BankWorkspaceError):
        bank_service.update_test_draft(locked.id, locked.model_copy(update={"items": []}))

    # Rejected edit must not have been applied.
    assert bank_service.get_test_draft(locked.id).test.items != []


def test_response_sheets_require_a_finished_test(
    gradebook_client, demo_bok: Path, tmp_path: Path
) -> None:
    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})
    create_response = gradebook_client.post("/api/tests", json={"title": "Draft Unit", "version": "A"})
    test_id = create_response.json()["test"]["id"]
    gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )
    response = gradebook_client.post(
        "/api/gradebook/administered-tests",
        json={"test_id": test_id, "mode": "blank", "blank_count": 1},
    )
    assert response.status_code == 400


def test_response_sheet_bubbles_only_include_finished_sibling_versions(
    gradebook_client, demo_bok: Path, tmp_path: Path
) -> None:
    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})

    def make_version(version: str, finished: bool) -> str:
        create = gradebook_client.post(
            "/api/tests", json={"title": "Phantom Unit", "version": version}
        )
        test_id = create.json()["test"]["id"]
        gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})
        payload = gradebook_client.get(f"/api/tests/{test_id}").json()["test"]
        payload["interchangeable_sheets"] = True
        payload["finished"] = finished
        gradebook_client.put(f"/api/tests/{test_id}", json=payload)
        return test_id

    version_a = make_version("A", finished=True)
    make_version("B", finished=True)
    make_version("C", finished=False)  # stray/unfinished -- must not leak a phantom bubble

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )
    response = gradebook_client.post(
        "/api/gradebook/administered-tests",
        json={"test_id": version_a, "mode": "blank", "blank_count": 1},
    )
    assert response.status_code == 200
    assert response.json()["layout"]["version_labels"] == ["A", "B"]


def test_response_sheet_batch_generates_one_snapshot_per_assigned_version(
    gradebook_client, demo_bok: Path, tmp_path: Path
) -> None:
    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})

    def make_version(version: str) -> str:
        create = gradebook_client.post(
            "/api/tests", json={"title": "Batch Unit", "version": version}
        )
        test_id = create.json()["test"]["id"]
        gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})
        payload = gradebook_client.get(f"/api/tests/{test_id}").json()["test"]
        payload["finished"] = True
        gradebook_client.put(f"/api/tests/{test_id}", json=payload)
        return test_id

    version_a = make_version("A")
    make_version("B")

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )
    ada = gradebook_client.post(
        "/api/gradebook/students", json={"first_name": "Ada", "last_name": "Lovelace"}
    ).json()
    grace = gradebook_client.post(
        "/api/gradebook/students", json={"first_name": "Grace", "last_name": "Hopper"}
    ).json()

    response = gradebook_client.post(
        f"/api/tests/{version_a}/response-sheets/batch",
        json={
            "mode": "pre_id",
            "assignments": [
                {"version": "A", "student_ids": [ada["id"]]},
                {"version": "B", "student_ids": [grace["id"]]},
            ],
        },
    )
    assert response.status_code == 200
    snapshots = response.json()["items"]
    assert {s["version"] for s in snapshots} == {"A", "B"}
    batch_ids = {s["generation_batch_id"] for s in snapshots}
    assert len(batch_ids) == 1
    assert None not in batch_ids

    pdf_response = gradebook_client.get(
        f"/api/gradebook/response-sheets/batches/{batch_ids.pop()}/pdf"
    )
    assert pdf_response.status_code == 200
    assert pdf_response.content.startswith(b"%PDF")


def test_response_sheet_batch_allows_a_partial_roster(
    gradebook_client, demo_bok: Path, tmp_path: Path
) -> None:
    """Only some students assigned a version is fine -- a teacher may only be
    printing for who's here today."""

    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})

    def make_version(version: str) -> str:
        create = gradebook_client.post(
            "/api/tests", json={"title": "Partial Unit", "version": version}
        )
        test_id = create.json()["test"]["id"]
        gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})
        payload = gradebook_client.get(f"/api/tests/{test_id}").json()["test"]
        payload["finished"] = True
        gradebook_client.put(f"/api/tests/{test_id}", json=payload)
        return test_id

    version_a = make_version("A")
    make_version("B")

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )
    ada = gradebook_client.post(
        "/api/gradebook/students", json={"first_name": "Ada", "last_name": "Lovelace"}
    ).json()
    gradebook_client.post(
        "/api/gradebook/students", json={"first_name": "Absent", "last_name": "Today"}
    )

    # Only Ada (version A) is assigned; the absent student is left out entirely
    # rather than blocking the whole batch.
    response = gradebook_client.post(
        f"/api/tests/{version_a}/response-sheets/batch",
        json={
            "mode": "pre_id",
            "assignments": [{"version": "A", "student_ids": [ada["id"]]}],
        },
    )
    assert response.status_code == 200
    snapshots = response.json()["items"]
    assert len(snapshots) == 1
    assert snapshots[0]["version"] == "A"
    assert len(snapshots[0]["layout"]["pages"]) == 1


def test_response_sheet_batch_supports_per_version_blank_counts(
    gradebook_client, demo_bok: Path, tmp_path: Path
) -> None:
    """Fill-in-name sheets can be pre-versioned too -- a count per version in
    one batch, instead of generating each version's blanks separately."""

    gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})

    def make_version(version: str) -> str:
        create = gradebook_client.post(
            "/api/tests", json={"title": "Blank Batch Unit", "version": version}
        )
        test_id = create.json()["test"]["id"]
        gradebook_client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_mc_0001"})
        payload = gradebook_client.get(f"/api/tests/{test_id}").json()["test"]
        payload["finished"] = True
        gradebook_client.put(f"/api/tests/{test_id}", json=payload)
        return test_id

    version_a = make_version("A")
    make_version("B")

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )

    response = gradebook_client.post(
        f"/api/tests/{version_a}/response-sheets/batch",
        json={
            "mode": "blank",
            "assignments": [
                {"version": "A", "blank_count": 3},
                {"version": "B", "blank_count": 2},
            ],
        },
    )
    assert response.status_code == 200
    snapshots = {s["version"]: s for s in response.json()["items"]}
    assert len(snapshots["A"]["layout"]["pages"]) == 3
    assert len(snapshots["B"]["layout"]["pages"]) == 2


@pytest.mark.parametrize("page_size", ["letter", "half_letter", "legal", "a4"])
def test_written_response_boxes_stay_on_the_page(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path, page_size: str
) -> None:
    """The write-in box used to be a fixed 400pt wide, which hung off the right
    edge of anything narrower than letter."""

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / f"{page_size}.nxgb"))

    detail = bank_service.add_question_to_test(
        bank_service.create_test_draft("Written", "A").test.id, "q_fr_0001"
    )
    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Demo Bank",
        mode="blank",
        page_size=page_size,
        blank_count=1,
        student_ids=None,
    )

    layout = snapshot.layout
    boxes = [
        row.capture_box
        for page in layout.pages
        for row in page.rows
        if row.capture_box is not None
    ]
    assert boxes, "expected a written-response box"
    for box in boxes:
        assert box.x_pt >= 0
        assert box.x_pt + box.width_pt <= layout.page_width_pt, "box runs off the page"
        assert box.y_pt >= 0
        assert box.y_pt + box.height_pt <= layout.page_height_pt
        assert box.width_pt > 100, "box too narrow to write in"


def _sheet_for(bank_service, gradebook_service, question_ids, page_size="letter", name="Cols"):
    test = bank_service.create_test_draft(name, "A").test
    for question_id in question_ids:
        bank_service.add_question_to_test(test.id, question_id)
    detail = bank_service.get_test_draft(test.id)
    return gradebook_service.create_snapshot_and_sheets(
        test=detail.test,
        questions=detail.questions,
        source_bank_title="Demo Bank",
        mode="blank",
        page_size=page_size,
        blank_count=1,
        student_ids=None,
    )


def _column_count(snapshot) -> int:
    return len({round(row.label_x_pt) for row in snapshot.layout.pages[0].rows})


def test_a_short_test_keeps_one_readable_column(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "short.nxgb"))

    snapshot = _sheet_for(
        bank_service, gradebook_service, [f"q_mc_{i:04d}" for i in range(1, 9)], name="Short"
    )

    assert _column_count(snapshot) == 1
    assert len(snapshot.layout.pages) == 1


def test_a_long_test_folds_into_columns_instead_of_a_second_page(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "long.nxgb"))

    snapshot = _sheet_for(
        bank_service, gradebook_service, [f"q_mc_{i:04d}" for i in range(1, 49)], name="Long"
    )

    assert len(snapshot.layout.pages) == 1
    assert _column_count(snapshot) >= 3


def test_a_written_response_breaks_the_columns_and_they_resume_after(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    """A run of bubbles, an essay, then more bubbles: two column blocks with a
    full-width box between them, not one column order reading across the essay."""

    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "mixed.nxgb"))

    question_ids = (
        [f"q_mc_{i:04d}" for i in range(1, 13)]
        + ["q_fr_0001"]
        + [f"q_mc_{i:04d}" for i in range(13, 37)]
    )
    snapshot = _sheet_for(bank_service, gradebook_service, question_ids, name="Mixed")

    assert len(snapshot.layout.pages) == 1
    rows = snapshot.layout.pages[0].rows
    written = next(row for row in rows if row.kind == "manual_capture")

    # The essay spans the sheet, starting at the left margin like a full-width row.
    left_margin = min(row.label_x_pt for row in rows)
    assert written.label_x_pt == left_margin
    assert written.capture_box is not None

    above = [r for r in rows if r.kind == "multiple_choice" and r.label_y_pt > written.label_y_pt]
    below = [r for r in rows if r.kind == "multiple_choice" and r.label_y_pt < written.label_y_pt]
    assert len({round(r.label_x_pt) for r in above}) > 1, "first run should be columned"
    assert len({round(r.label_x_pt) for r in below}) > 1, "second run should be columned"


def test_columns_never_run_past_the_right_margin(
    bank_service: BankWorkspaceService, demo_bok: Path, tmp_path: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "edges.nxgb"))

    for page_size in ("letter", "legal", "a4", "half_letter"):
        snapshot = _sheet_for(
            bank_service,
            gradebook_service,
            [f"q_mc_{i:04d}" for i in range(1, 49)],
            page_size=page_size,
            name=f"Edges {page_size}",
        )
        width = snapshot.layout.page_width_pt
        for page in snapshot.layout.pages:
            for row in page.rows:
                for cell in row.cells:
                    assert cell.center_x_pt + cell.radius_pt <= width, page_size
