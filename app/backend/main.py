from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any
import zipfile

from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .models import (
    AdministeredTestSnapshotCollectionModel,
    AssetInspectionBatchRequest,
    AssetInspectionRequest,
    AddQuestionToTestRequest,
    CopyTestDraftRequest,
    CreateAdministeredTestRequest,
    CreateBankRequest,
    CreateGradebookRequest,
    CreateResponseSheetBatchRequest,
    CreateScanBatchRequest,
    CreateStandardPlaceholdersRequest,
    CreateStandardsManuallyRequest,
    CreateQuestionRequest,
    CreateQuestionsFromJsonRequest,
    CreateQuestionsFromJsonResponse,
    CreateTestDraftRequest,
    NextQuestionIdResponse,
    OpenBankRequest,
    OpenGradebookRequest,
    OverrideRowResultRequest,
    QuestionDetailModel,
    QuestionImportPromoteRequest,
    QuestionImportRowUpdateRequest,
    QuestionModel,
    QuestionType,
    ReassignSheetRequest,
    RecordPerformanceRunRequest,
    RelinkSnapshotLineageRequest,
    UpdateMasterySettingsRequest,
    ResolveSheetIdentityRequest,
    SaveBankRequest,
    SaveGradebookRequest,
    SeedCourseRequest,
    SetTestCoursesRequest,
    StandardRecordModel,
    TestDraftModel,
    UpdateBankDetailsRequest,
    UpdateGradebookDetailsRequest,
    UpsertCourseRequest,
    UpsertStudentRequest,
)
from .gradebook_service import GradebookService
from .service import BankWorkspaceError, BankWorkspaceService
from .validation import lint_question
from .version import get_backend_version, is_frozen


app = FastAPI(title="Nexam Backend", version="0.1.0")
service = BankWorkspaceService()
gradebook_service = GradebookService()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "tauri://localhost",
        "http://tauri.localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(BankWorkspaceError)
def handle_workspace_error(_, exc: BankWorkspaceError):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


@app.exception_handler(ValidationError)
def handle_validation_error(_, exc: ValidationError):
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": exc.errors()}))


@app.exception_handler(RequestValidationError)
def handle_request_validation_error(_, exc: RequestValidationError):
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": exc.errors()}))


@app.get("/health")
@app.get("/api/health")
def healthcheck() -> dict[str, str]:
    return {
        "status": "ok",
        "version": get_backend_version(),
        "build": "frozen" if is_frozen() else "source",
    }


@app.post("/api/banks/open")
def open_bank(request: OpenBankRequest):
    return service.open_bank(request.path)


@app.post("/api/banks/open-demo")
def open_demo_bank():
    bundled_demo_bank = os.environ.get("NEXAM_DEMO_BANK_PATH")
    if bundled_demo_bank:
        return service.open_bank(bundled_demo_bank)

    repo_root = Path(__file__).resolve().parents[2]
    demo_dir = repo_root / "samples" / "demo-bank"
    demo_archive = repo_root / "samples" / "demo-bank.bok"
    if not demo_archive.exists():
        with zipfile.ZipFile(demo_archive, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_path in sorted(demo_dir.rglob("*")):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(demo_dir))
    return service.open_bank(str(demo_archive))


@app.get("/api/banks/current")
def get_current_bank():
    return service.get_summary()


@app.post("/api/banks/create")
def create_bank(request: CreateBankRequest):
    return service.create_bank(request.title, request.description, request.destination_path)


@app.put("/api/banks/current")
def update_bank_details(request: UpdateBankDetailsRequest):
    return service.update_bank_details(request.title, request.description)


@app.post("/api/banks/save")
def save_bank(request: SaveBankRequest):
    return {"saved_to": service.save_bank(request.destination_path)}


def _validated_resolution(resolution: str) -> str:
    """How a student's retakes collapse into the one score that counts."""

    if resolution not in ("most_recent", "highest", "average"):
        raise BankWorkspaceError(
            f"Unknown retake resolution: {resolution}. "
            "Expected most_recent, highest, or average.",
            status_code=400,
        )
    return resolution


@app.post("/api/gradebook/open")
def open_gradebook(request: OpenGradebookRequest):
    return gradebook_service.open_gradebook(request.path)


@app.post("/api/gradebook/open-demo")
def open_demo_gradebook():
    """Open the shipped sample roster.

    Resolved the same way the demo bank is: a bundled resource path in a
    release build, the repo's samples directory when running from source.
    """

    bundled = os.environ.get("NEXAM_DEMO_GRADEBOOK_PATH")
    if bundled:
        return gradebook_service.open_gradebook(bundled)

    repo_root = Path(__file__).resolve().parents[2]
    demo_gradebook = repo_root / "samples" / "demo-gradebook.nxgb"
    if not demo_gradebook.exists():
        raise BankWorkspaceError(
            "The demo gradebook is missing. Run scripts/build_demo_gradebook.py.",
            status_code=404,
        )
    return gradebook_service.open_gradebook(str(demo_gradebook))


@app.get("/api/gradebook/current")
def get_current_gradebook():
    return gradebook_service.get_summary()


@app.post("/api/gradebook/create")
def create_gradebook(request: CreateGradebookRequest):
    return gradebook_service.create_gradebook(
        request.title, request.description, request.destination_path
    )


@app.put("/api/gradebook/current")
def update_gradebook_details(request: UpdateGradebookDetailsRequest):
    return gradebook_service.update_gradebook_details(request.title, request.description)


@app.post("/api/gradebook/save")
def save_gradebook(request: SaveGradebookRequest):
    return {"saved_to": gradebook_service.save_gradebook(request.destination_path)}


@app.post("/api/gradebook/close")
def close_gradebook():
    gradebook_service.close_gradebook()
    return {"closed": True}


@app.get("/api/gradebook/students")
def list_students():
    return gradebook_service.list_students()


@app.put("/api/gradebook/students/{student_id}")
def upsert_student(student_id: str, request: UpsertStudentRequest):
    return gradebook_service.upsert_student(student_id, request)


@app.post("/api/gradebook/students")
def create_student(request: UpsertStudentRequest):
    return gradebook_service.upsert_student(None, request)


@app.delete("/api/gradebook/students/{student_id}", status_code=204)
def delete_student(student_id: str):
    gradebook_service.delete_student(student_id)
    return None


@app.post("/api/gradebook/administered-tests")
def create_administered_test(request: CreateAdministeredTestRequest):
    """The hand-off: reads the live test from the open bank, writes only into
    the open gradebook. See docs/grading-plan.md."""
    test_detail = service.get_test_draft(request.test_id)
    if not test_detail.test.finished:
        raise BankWorkspaceError(
            "Finish this test before generating response sheets for it.",
            status_code=400,
        )
    source_bank_title = service.get_summary().manifest.title

    # An interchangeable sheet has to carry every version's key, so the lineage
    # -- same title, the convention "New Version" already follows -- comes along.
    # Only finished versions are eligible: an unfinished same-titled draft is
    # often a leftover copy, not a real sibling version, and must not leak a
    # phantom version bubble onto the printed sheet.
    alternates = []
    if test_detail.test.interchangeable_sheets:
        lineage_key = test_detail.test.title.strip().casefold()
        for other in service.list_test_drafts().items:
            if other.test.id == test_detail.test.id:
                continue
            if not other.test.finished:
                continue
            if other.test.title.strip().casefold() == lineage_key:
                alternates.append((other.test, other.questions))

    snapshot = gradebook_service.create_snapshot_and_sheets(
        test=test_detail.test,
        questions=test_detail.questions,
        source_bank_title=source_bank_title,
        mode=request.mode,
        page_size=request.page_size,
        blank_count=request.blank_count,
        student_ids=request.student_ids,
        alternates=alternates,
    )

    # Sheets are now in the wild for every version actually printed on them;
    # lock each one against edits that would move a bubble out from under them.
    service.mark_test_administered(test_detail.test.id)
    used_alternate_ids = {key.test_id for key in snapshot.alternate_answer_keys}
    for other_test, _ in alternates:
        if other_test.id in used_alternate_ids:
            service.mark_test_administered(other_test.id)

    return snapshot


@app.post("/api/tests/{test_id}/response-sheets/batch")
def create_response_sheet_batch(test_id: str, request: CreateResponseSheetBatchRequest):
    """Generate sheets across several versions of one lineage in a single run.

    `test_id` anchors the lineage (same title, the "New Version" convention);
    each assignment names one of that lineage's finished versions by its
    `version` label and the students taking it. Every assignment gets its own
    dedicated sheet -- no "mark your version" bubble, since the teacher
    already knows who's taking what.
    """

    anchor = service.get_test_draft(test_id)
    if not anchor.test.finished:
        raise BankWorkspaceError(
            "Finish this test before generating response sheets for it.",
            status_code=400,
        )

    lineage_key = anchor.test.title.strip().casefold()
    lineage_by_version = {
        detail.test.version: detail
        for detail in service.list_test_drafts().items
        if detail.test.finished and detail.test.title.strip().casefold() == lineage_key
    }

    source_bank_title = service.get_summary().manifest.title
    batch_id = uuid.uuid4().hex
    snapshots = []
    for assignment in request.assignments:
        if request.mode == "blank":
            if not assignment.blank_count:
                continue
            student_ids, blank_count = None, assignment.blank_count
        else:
            if not assignment.student_ids:
                continue
            student_ids, blank_count = assignment.student_ids, None

        version_detail = lineage_by_version.get(assignment.version)
        if version_detail is None:
            raise BankWorkspaceError(
                f"No finished version '{assignment.version}' found for this test.",
                status_code=400,
            )
        snapshot = gradebook_service.create_snapshot_and_sheets(
            test=version_detail.test,
            questions=version_detail.questions,
            source_bank_title=source_bank_title,
            mode=request.mode,
            page_size=request.page_size,
            blank_count=blank_count,
            student_ids=student_ids,
            generation_batch_id=batch_id,
        )
        service.mark_test_administered(version_detail.test.id)
        snapshots.append(snapshot)

    return AdministeredTestSnapshotCollectionModel(items=snapshots)


@app.get("/api/gradebook/response-sheets/batches/{generation_batch_id}/pdf")
def get_response_sheet_batch_pdf(generation_batch_id: str):
    pdf_bytes = gradebook_service.get_batch_pdf_bytes(generation_batch_id)
    return Response(content=pdf_bytes, media_type="application/pdf")


@app.get("/api/gradebook/administered-tests")
def list_administered_tests():
    return gradebook_service.list_administered_tests()


@app.get("/api/gradebook/administered-tests/{snapshot_id}")
def get_administered_test(snapshot_id: str):
    return gradebook_service.get_administered_test(snapshot_id)


@app.get("/api/gradebook/sheets/{layout_id}/pdf")
def get_sheet_pdf(layout_id: str):
    pdf_bytes = gradebook_service.get_sheet_pdf_bytes(layout_id)
    return Response(content=pdf_bytes, media_type="application/pdf")


@app.post("/api/gradebook/batches")
def create_scan_batch(request: CreateScanBatchRequest):
    return gradebook_service.create_scan_batch(request.snapshot_id, request.source_description)


@app.get("/api/gradebook/batches")
def list_scan_batches():
    return gradebook_service.list_scan_batches()


@app.get("/api/gradebook/batches/{batch_id}")
def get_scan_batch(batch_id: str):
    return gradebook_service.get_scan_batch(batch_id)


@app.post("/api/gradebook/scans/ingest")
async def ingest_scans(
    files: list[UploadFile] = File(...),
    fallback_snapshot_id: str | None = Form(None),
):
    """Sort a pile of scans into batches by the test each sheet belongs to.

    `fallback_snapshot_id` is where pages with an unreadable QR go -- the test
    the teacher is scanning from, when the caller knows it."""

    uploaded = [(file.filename or "scan", await file.read()) for file in files]
    return {"items": gradebook_service.ingest_scans(uploaded, fallback_snapshot_id)}


@app.post("/api/gradebook/batches/{batch_id}/ingest")
async def ingest_scan_batch(batch_id: str, files: list[UploadFile] = File(...)):
    uploaded = [(file.filename or "scan", await file.read()) for file in files]
    return gradebook_service.ingest_scan_batch(batch_id, uploaded)


@app.get("/api/gradebook/batches/{batch_id}/review-queue")
def get_review_queue(batch_id: str):
    return {"items": gradebook_service.get_review_queue(batch_id)}


@app.get("/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/image")
def get_sheet_image(batch_id: str, sheet_id: str):
    image_bytes = gradebook_service.get_sheet_image_bytes(batch_id, sheet_id)
    return Response(content=image_bytes, media_type="image/png")


@app.put("/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/identity")
def resolve_sheet_identity(batch_id: str, sheet_id: str, request: ResolveSheetIdentityRequest):
    return gradebook_service.resolve_sheet_identity(
        batch_id,
        sheet_id,
        student_id=request.student_id,
        free_text_name=request.free_text_name,
    )


@app.put("/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/printing")
def reassign_sheet_to_printing(batch_id: str, sheet_id: str, request: ReassignSheetRequest):
    return gradebook_service.reassign_sheet_to_printing(
        batch_id, sheet_id, request.snapshot_id, request.page_index
    )


@app.put("/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/rows/{question_id}")
def override_row_result(
    batch_id: str, sheet_id: str, question_id: str, request: OverrideRowResultRequest
):
    # exclude_unset, so a request that says nothing about a field leaves it
    # alone rather than nulling it. An explicit null in the body still clears.
    return gradebook_service.override_row_result(
        batch_id, sheet_id, question_id, **request.model_dump(exclude_unset=True)
    )


@app.get("/api/gradebook/batches/{batch_id}/report")
def get_grade_report(batch_id: str):
    return gradebook_service.get_grade_report(batch_id)


@app.get("/api/gradebook/report/combined")
def get_combined_lineage_report(
    test_title: str | None = Query(None), lineage_id: str | None = Query(None)
):
    """Pass `lineage_id` where you have one -- it follows the explicit retake
    link. `test_title` remains for callers that only know the title."""

    return gradebook_service.get_combined_lineage_report(test_title, lineage_id)


@app.get("/api/gradebook/students/performance")
def get_student_performance(resolution: str = Query("most_recent")):
    """Every student's record across every test in this gradebook.

    Returned for the whole roster in one call: the scoring pass reads every
    batch either way, so a per-student endpoint would cost the same and make
    the roster page issue one request per student.
    """

    return gradebook_service.get_student_performance(_validated_resolution(resolution))


@app.get("/api/gradebook/students/{student_id}/performance")
def get_one_student_performance(student_id: str, resolution: str = Query("most_recent")):
    return gradebook_service.get_one_student_performance(
        student_id, _validated_resolution(resolution)
    )


@app.put("/api/gradebook/administered-tests/{snapshot_id}/lineage")
def relink_snapshot_lineage(snapshot_id: str, request: RelinkSnapshotLineageRequest):
    """Link a printing to another as the same test, so a retake counts as a
    second attempt rather than a separate test nobody ever passed."""

    return gradebook_service.relink_snapshot_lineage(
        snapshot_id,
        lineage_of_snapshot_id=request.lineage_of_snapshot_id,
        lineage_id=request.lineage_id,
    )


@app.get("/api/gradebook/mastery-settings")
def get_mastery_settings():
    """The gradebook default plus every per-test override, keyed by lineage."""

    return gradebook_service.get_mastery_config()


@app.put("/api/gradebook/mastery-settings")
def set_default_mastery_settings(request: UpdateMasterySettingsRequest):
    """Change the gradebook default. Tests carrying their own override keep it."""

    return gradebook_service.set_default_mastery_settings(request.calculation, request.reporting)


@app.put("/api/gradebook/mastery-settings/{lineage_id}")
def set_lineage_mastery_settings(lineage_id: str, request: UpdateMasterySettingsRequest):
    """Override one test's mode, or -- with both fields null -- drop the
    override so the test follows the gradebook default again."""

    return gradebook_service.set_lineage_mastery_settings(
        lineage_id, request.calculation, request.reporting
    )


@app.get("/api/gradebook/export/scores.csv")
def export_scores_csv(
    method: str = Query("total"),
    resolution: str = Query("most_recent"),
    section: str | None = Query(None),
):
    """Student scores as CSV, in one of three shapes -- see grading/csv_export.py.

    Standard *codes* only exist in a bank, so they are used when one happens to
    be open and standard ids stand in when it is not. The export never requires
    a bank: a gradebook has to stay exportable on its own.
    """

    if method not in ("total", "by_standard", "mastery"):
        raise BankWorkspaceError(
            f"Unknown export method: {method}. Expected total, by_standard, or mastery.",
            status_code=400,
        )

    standard_codes: dict[str, str] = {}
    try:
        # A standard with no code of its own falls through to its id, which is
        # always present -- a "None" column header would be worse than an id.
        standard_codes = {
            standard.id: standard.code
            for standard in service.list_standards().items
            if standard.code
        }
    except BankWorkspaceError:
        pass

    csv_text, filename = gradebook_service.export_scores_csv(
        method=method,
        resolution=_validated_resolution(resolution),
        section=section,
        standard_codes=standard_codes,
    )
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/gradebook/batches/{batch_id}/record-performance-run")
def record_batch_as_performance_run(batch_id: str, request: RecordPerformanceRunRequest):
    """Requires a bank to be open -- this is the one place a completed
    grading result can flow back into the bank, and it's an explicit,
    user-initiated action, never automatic. See docs/grading-plan.md."""

    batch = gradebook_service.get_scan_batch(batch_id)
    snapshot = gradebook_service.get_snapshot(batch.snapshot_id)
    run = gradebook_service.build_performance_run(batch_id, request.cohort_label)
    return service.add_performance_run(snapshot.source_test_id, run)


@app.post("/api/banks/close", status_code=204)
def close_bank():
    service.close_bank()


@app.get("/api/questions")
def list_questions(
    search: str | None = Query(default=None),
    topic: str | None = Query(default=None),
    question_type: str | None = Query(default=None, alias="type"),
):
    return service.list_questions(search=search, topic=topic, question_type=question_type)


@app.get("/api/questions/next-id")
def get_next_question_id(question_type: QuestionType = Query(..., alias="type")) -> NextQuestionIdResponse:
    return NextQuestionIdResponse(id=service.next_question_id(question_type))


@app.get("/api/standards/source-lists")
def list_source_standard_lists():
    return service.list_source_standard_lists()


@app.get("/api/standards")
def list_standards(
    source_list_id: str | None = Query(default=None),
    search: str | None = Query(default=None),
    course_id: str | None = Query(default=None),
    strand: str | None = Query(default=None),
    sort: str | None = Query(default=None),
):
    return service.list_standards(
        source_list_id=source_list_id,
        search=search,
        course_id=course_id,
        strand=strand,
        sort=sort,
    )


@app.get("/api/standards/strands")
def list_standard_strands():
    return {"items": service.list_standard_strands()}


@app.get("/api/courses")
def list_courses():
    return service.list_courses()


@app.get("/api/courses/{course_id}")
def get_course_detail(course_id: str):
    return service.get_course_detail(course_id)


@app.put("/api/courses/{course_id}")
def upsert_course(course_id: str, request: UpsertCourseRequest):
    return service.upsert_course(
        course_id=course_id,
        title=request.title,
        description=request.description,
        standard_refs=request.standard_refs,
    )


@app.post("/api/courses/{course_id}/seed")
def seed_course(course_id: str, request: SeedCourseRequest):
    return service.seed_course_from(
        course_id,
        request.source_course_id,
        include_standards=request.include_standards,
        include_tests=request.include_tests,
    )


@app.delete("/api/courses/{course_id}", status_code=204)
def delete_course(course_id: str):
    service.delete_course(course_id)


@app.post("/api/courses/{course_id}/standards/{standard_id}")
def attach_standard_to_course(course_id: str, standard_id: str):
    return service.attach_standard_to_course(course_id, standard_id)


@app.delete("/api/courses/{course_id}/standards/{standard_id}")
def detach_standard_from_course(course_id: str, standard_id: str):
    return service.detach_standard_from_course(course_id, standard_id)


@app.post("/api/standards/import")
async def import_standards(
    file: UploadFile = File(...),
    source_list_id: str | None = Form(default=None),
    title: str | None = Form(default=None),
    issuer: str | None = Form(default=None),
    subject: str | None = Form(default=None),
    version: str | None = Form(default=None),
    description: str | None = Form(default=None),
):
    return service.import_standards(
        filename=file.filename or "",
        content=await file.read(),
        source_list_id=source_list_id,
        title=title,
        issuer=issuer,
        subject=subject,
        version=version,
        description=description,
    )


@app.post("/api/standards/import/inspect")
async def inspect_standard_import(file: UploadFile = File(...)):
    return service.inspect_standard_import(
        filename=file.filename or "",
        content=await file.read(),
    )


@app.post("/api/standards/manual")
def create_standards_manually(request: CreateStandardsManuallyRequest):
    return service.create_standards_manually(request)


@app.put("/api/standards/{standard_id}")
def update_standard_record(standard_id: str, payload: StandardRecordModel):
    return service.update_standard_record(standard_id, payload)


@app.post("/api/standards/placeholders")
def create_standard_placeholders(request: CreateStandardPlaceholdersRequest):
    return service.create_standard_placeholders(request.standard_ids)


@app.post("/api/question-imports/stage")
async def stage_question_import(file: UploadFile = File(...)):
    return service.stage_question_import(
        filename=file.filename or "",
        content=await file.read(),
    )


@app.get("/api/question-imports")
def list_question_imports():
    return service.list_question_imports()


@app.get("/api/question-imports/{import_id}")
def get_question_import(import_id: str):
    return service.get_question_import(import_id)


@app.put("/api/question-imports/{import_id}/rows/{row_id}")
def update_question_import_row(
    import_id: str,
    row_id: str,
    request: QuestionImportRowUpdateRequest,
):
    return service.update_question_import_row(
        import_id,
        row_id,
        question=request.question,
        selected=request.selected,
    )


@app.post("/api/question-imports/{import_id}/promote")
def promote_question_import(import_id: str, request: QuestionImportPromoteRequest):
    return service.promote_question_import_rows(
        import_id,
        row_ids=request.row_ids,
        id_policy=request.id_policy,
    )


@app.get("/api/tests")
def list_test_drafts():
    return service.list_test_drafts()


@app.post("/api/tests")
def create_test_draft(request: CreateTestDraftRequest):
    return service.create_test_draft(
        title=request.title,
        version=request.version,
        course_ids=request.course_ids,
    )


@app.get("/api/tests/{test_id}")
def get_test_draft(test_id: str):
    return service.get_test_draft(test_id)


@app.put("/api/tests/{test_id}")
def update_test_draft(test_id: str, payload: TestDraftModel):
    return service.update_test_draft(test_id, payload)


@app.put("/api/tests/{test_id}/courses")
def set_test_courses(test_id: str, request: SetTestCoursesRequest):
    return service.set_test_courses(test_id, request.course_ids)


@app.post("/api/tests/{test_id}/copy")
def copy_test_draft(test_id: str, request: CopyTestDraftRequest):
    return service.copy_test_draft(
        test_id,
        title=request.title,
        version=request.version,
        course_ids=request.course_ids,
        detach_courses_from_source=request.detach_courses_from_source,
        source_restore=request.source_restore,
    )


@app.post("/api/tests/{test_id}/items")
def add_question_to_test(test_id: str, request: AddQuestionToTestRequest):
    return service.add_question_to_test(
        test_id,
        request.question_id,
        experimental=request.experimental,
    )


@app.get("/api/assets")
def list_assets():
    return service.list_assets()


def _question_detail(question: QuestionModel) -> QuestionDetailModel:
    return QuestionDetailModel(question=question, issues=lint_question(question))


@app.get("/api/questions/{question_id}")
def get_question(question_id: str):
    return _question_detail(service.get_question(question_id))


@app.put("/api/questions/{question_id}")
def update_question(question_id: str, payload: QuestionModel):
    return _question_detail(service.update_question(question_id, payload))


@app.post("/api/questions")
def create_question(request: CreateQuestionRequest):
    return _question_detail(
        service.create_question(template_question_id=request.template_question_id)
    )


@app.post("/api/questions/from-json")
def create_question_from_json(payload: dict[str, Any]):
    return _question_detail(service.create_question_from_json(payload))


@app.post("/api/questions/from-json-batch")
def create_questions_from_json(request: CreateQuestionsFromJsonRequest):
    return CreateQuestionsFromJsonResponse(
        items=service.create_questions_from_json(request.questions)
    )


@app.delete("/api/questions/{question_id}", status_code=204)
def delete_question(question_id: str):
    service.delete_question(question_id)


@app.post("/api/assets/upload")
async def upload_asset(file: UploadFile = File(...)):
    return service.upload_asset(file.filename or "", await file.read())


@app.post("/api/assets/inspect")
def inspect_asset(payload: AssetInspectionRequest):
    return service.inspect_asset(payload)


@app.post("/api/assets/inspect-batch")
def inspect_assets(request: AssetInspectionBatchRequest):
    return service.inspect_assets(request.assets)


@app.get("/api/assets/file")
def get_asset_file(path: str = Query(...)):
    asset_path = service.resolve_asset_path(path)
    return FileResponse(asset_path, media_type=service.get_asset_media_type(path))
