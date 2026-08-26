from __future__ import annotations

import os
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
    AssetInspectionBatchRequest,
    AssetInspectionRequest,
    AddQuestionToTestRequest,
    CopyTestDraftRequest,
    CreateAdministeredTestRequest,
    CreateBankRequest,
    CreateGradebookRequest,
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
    QuestionImportPromoteRequest,
    QuestionImportRowUpdateRequest,
    QuestionModel,
    QuestionType,
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
from .version import get_backend_version, is_frozen


app = FastAPI(title="Nexzam Backend", version="0.1.0")
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
    bundled_demo_bank = os.environ.get("NEXZAM_DEMO_BANK_PATH")
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


@app.post("/api/gradebook/open")
def open_gradebook(request: OpenGradebookRequest):
    return gradebook_service.open_gradebook(request.path)


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
    source_bank_title = service.get_summary().manifest.title
    return gradebook_service.create_snapshot_and_sheets(
        test=test_detail.test,
        questions=test_detail.questions,
        source_bank_title=source_bank_title,
        mode=request.mode,
        page_size=request.page_size,
        blank_count=request.blank_count,
        student_ids=request.student_ids,
    )


@app.get("/api/gradebook/administered-tests")
def list_administered_tests():
    return gradebook_service.list_administered_tests()


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


@app.put("/api/gradebook/batches/{batch_id}/sheets/{sheet_id}/rows/{question_id}")
def override_row_result(
    batch_id: str, sheet_id: str, question_id: str, request: OverrideRowResultRequest
):
    return gradebook_service.override_row_result(
        batch_id,
        sheet_id,
        question_id,
        override_choice_indices=request.override_choice_indices,
        override_value=request.override_value,
        override_note=request.override_note,
        manual_score=request.manual_score,
        manual_score_max=request.manual_score_max,
        manual_grader_note=request.manual_grader_note,
    )


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


@app.get("/api/questions/{question_id}")
def get_question(question_id: str):
    return service.get_question(question_id)


@app.put("/api/questions/{question_id}")
def update_question(question_id: str, payload: QuestionModel):
    return service.update_question(question_id, payload)


@app.post("/api/questions")
def create_question(request: CreateQuestionRequest):
    return service.create_question(template_question_id=request.template_question_id)


@app.post("/api/questions/from-json")
def create_question_from_json(payload: dict[str, Any]):
    return service.create_question_from_json(payload)


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
