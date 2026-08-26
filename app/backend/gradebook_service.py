from __future__ import annotations

import tempfile
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from .grading.answer_key import derive_answer_key
from .grading.layout import SheetCopySpec, build_sheet_layout
from .grading.pdf import render_sheet_layout_to_pdf
from .models import (
    AdministeredTestSnapshotListResponseModel,
    AdministeredTestSnapshotModel,
    AdministeredTestSnapshotSummaryModel,
    GradebookManifestModel,
    GradebookSummaryModel,
    QuestionModel,
    StudentCollectionModel,
    StudentListResponseModel,
    StudentModel,
    TestDraftModel,
    UpsertStudentRequest,
)
from .service import BankWorkspaceError


class GradebookService:
    """Owns the .nxgb package: roster today, snapshots/scans/scores in later phases.

    Deliberately independent of BankWorkspaceService -- a gradebook can be open
    with no bank open, a bank open with no gradebook, both, or neither. See
    docs/grading-plan.md for why student data must never live inside a .bok.
    """

    GRADEBOOK_SCHEMA_VERSION = "1.0.0"

    def __init__(self) -> None:
        self._source_path: Path | None = None
        self._workspace_path: Path | None = None

    def ensure_open(self) -> tuple[Path, Path]:
        if self._source_path is None or self._workspace_path is None:
            raise BankWorkspaceError("No gradebook is currently open.", status_code=400)
        return self._source_path, self._workspace_path

    def open_gradebook(self, nxgb_path: str) -> GradebookSummaryModel:
        source_path = Path(nxgb_path).expanduser().resolve()
        if not source_path.exists():
            raise BankWorkspaceError(f"Gradebook file not found: {source_path}", status_code=404)
        if not zipfile.is_zipfile(source_path):
            raise BankWorkspaceError("Selected file is not a valid .nxgb zip archive.", status_code=400)

        workspace_path = self._new_workspace_dir(source_path.stem)
        with zipfile.ZipFile(source_path) as archive:
            archive.extractall(workspace_path)

        self._ensure_support_files(workspace_path)
        self._validate_workspace(workspace_path)

        self._source_path = source_path
        self._workspace_path = workspace_path
        return self.get_summary()

    def create_gradebook(
        self, title: str, description: str | None, destination_path: str
    ) -> GradebookSummaryModel:
        title = (title or "").strip()
        if not title:
            raise BankWorkspaceError("Gradebook title must not be empty.", status_code=400)

        target_path = Path(destination_path).expanduser().resolve()
        if target_path.suffix != ".nxgb":
            raise BankWorkspaceError("Destination path must end with .nxgb", status_code=400)

        workspace_path = self._new_workspace_dir(target_path.stem)

        now = datetime.now(UTC)
        manifest = GradebookManifestModel(
            schema_version=self.GRADEBOOK_SCHEMA_VERSION,
            gradebook_id=uuid.uuid4().hex,
            title=title,
            description=(description or "").strip() or None,
            created_at=now,
            updated_at=now,
        )
        (workspace_path / "manifest.json").write_text(manifest.model_dump_json(indent=2) + "\n")

        self._source_path = target_path
        self._workspace_path = workspace_path
        self._ensure_support_files(workspace_path)

        self.save_gradebook(str(target_path))
        return self.get_summary()

    def update_gradebook_details(self, title: str, description: str | None) -> GradebookSummaryModel:
        title = (title or "").strip()
        if not title:
            raise BankWorkspaceError("Gradebook title must not be empty.", status_code=400)

        _, workspace_path = self.ensure_open()
        manifest = self._read_manifest()
        manifest.title = title
        manifest.description = (description or "").strip() or None
        manifest.updated_at = datetime.now(UTC)
        (workspace_path / "manifest.json").write_text(manifest.model_dump_json(indent=2) + "\n")
        return self.get_summary()

    def save_gradebook(self, destination_path: str | None = None) -> str:
        source_path, workspace_path = self.ensure_open()
        target_path = Path(destination_path).expanduser().resolve() if destination_path else source_path
        if target_path.suffix != ".nxgb":
            raise BankWorkspaceError("Destination path must end with .nxgb", status_code=400)

        self._refresh_manifest_timestamp()

        target_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(target_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for entry_path in sorted(workspace_path.rglob("*")):
                relative_path = entry_path.relative_to(workspace_path)
                if entry_path.is_file():
                    archive.write(entry_path, relative_path)
                elif entry_path.is_dir() and not any(entry_path.iterdir()):
                    archive.writestr(f"{relative_path.as_posix()}/", "")
        self._source_path = target_path
        return str(target_path)

    def close_gradebook(self) -> None:
        self._source_path = None
        self._workspace_path = None

    def get_summary(self) -> GradebookSummaryModel:
        source_path, workspace_path = self.ensure_open()
        return GradebookSummaryModel(
            source_path=str(source_path),
            workspace_path=str(workspace_path),
            manifest=self._read_manifest(),
        )

    # -- Roster -------------------------------------------------------------

    def list_students(self) -> StudentListResponseModel:
        return StudentListResponseModel(items=self._read_students().items)

    def upsert_student(self, student_id: str | None, request: UpsertStudentRequest) -> StudentModel:
        _, workspace_path = self.ensure_open()
        students = self._read_students()

        if student_id:
            existing = next((s for s in students.items if s.id == student_id), None)
            if existing is None:
                raise BankWorkspaceError(f"Student not found: {student_id}", status_code=404)
            updated = StudentModel(
                id=student_id,
                first_name=request.first_name,
                last_name=request.last_name,
                external_id=request.external_id,
            )
            students.items = [updated if s.id == student_id else s for s in students.items]
        else:
            updated = StudentModel(
                id=uuid.uuid4().hex,
                first_name=request.first_name,
                last_name=request.last_name,
                external_id=request.external_id,
            )
            students.items.append(updated)

        self._write_students(workspace_path, students)
        return updated

    def delete_student(self, student_id: str) -> None:
        _, workspace_path = self.ensure_open()
        students = self._read_students()
        remaining = [s for s in students.items if s.id != student_id]
        if len(remaining) == len(students.items):
            raise BankWorkspaceError(f"Student not found: {student_id}", status_code=404)
        students.items = remaining
        self._write_students(workspace_path, students)

    # -- Hand-off / administered tests --------------------------------------

    def create_snapshot_and_sheets(
        self,
        *,
        test: TestDraftModel,
        questions: list[QuestionModel],
        source_bank_title: str | None,
        mode: str,
        page_size: str,
        blank_count: int | None,
        student_ids: list[str] | None,
    ) -> AdministeredTestSnapshotModel:
        _, workspace_path = self.ensure_open()

        questions_by_id = {question.id: question for question in questions}
        answer_key = derive_answer_key(test, questions_by_id)

        copies = self._build_copies(mode, blank_count, student_ids)
        layout_id = uuid.uuid4().hex
        layout = build_sheet_layout(
            layout_id=layout_id,
            answer_key=answer_key,
            mode=mode,
            page_size=page_size,
            copies=copies,
        )

        snapshot = AdministeredTestSnapshotModel(
            id=uuid.uuid4().hex,
            source_bank_title=source_bank_title,
            source_test_id=test.id,
            title=test.title,
            version=test.version,
            printed_at=datetime.now(UTC),
            items=test.items,
            questions=questions,
            answer_key=answer_key,
            layout=layout,
        )

        snapshot_dir = workspace_path / "snapshots" / snapshot.id
        snapshot_dir.mkdir(parents=True, exist_ok=False)
        (snapshot_dir / "snapshot.json").write_text(snapshot.model_dump_json(indent=2) + "\n")
        (snapshot_dir / "sheet.pdf").write_bytes(render_sheet_layout_to_pdf(layout))

        return snapshot

    def _build_copies(
        self, mode: str, blank_count: int | None, student_ids: list[str] | None
    ) -> list[SheetCopySpec]:
        if mode == "pre_id":
            if not student_ids:
                raise BankWorkspaceError(
                    "pre_id mode requires at least one student_id.", status_code=400
                )
            students_by_id = {s.id: s for s in self._read_students().items}
            copies = []
            for student_id in student_ids:
                student = students_by_id.get(student_id)
                if student is None:
                    raise BankWorkspaceError(f"Student not found: {student_id}", status_code=404)
                copies.append(
                    SheetCopySpec(
                        sheet_id=uuid.uuid4().hex,
                        student_id=student.id,
                        printed_name=f"{student.first_name} {student.last_name}",
                    )
                )
            return copies

        count = blank_count if blank_count and blank_count > 0 else 1
        return [SheetCopySpec(sheet_id=uuid.uuid4().hex) for _ in range(count)]

    def list_administered_tests(self) -> AdministeredTestSnapshotListResponseModel:
        summaries = [self._snapshot_summary(snapshot) for snapshot in self._read_all_snapshots()]
        summaries.sort(key=lambda summary: summary.printed_at, reverse=True)
        return AdministeredTestSnapshotListResponseModel(items=summaries)

    def get_sheet_pdf_bytes(self, layout_id: str) -> bytes:
        _, workspace_path = self.ensure_open()
        for snapshot in self._read_all_snapshots():
            if snapshot.layout.id == layout_id:
                pdf_path = workspace_path / "snapshots" / snapshot.id / "sheet.pdf"
                return pdf_path.read_bytes()
        raise BankWorkspaceError(f"No sheet found for layout: {layout_id}", status_code=404)

    def _snapshot_summary(
        self, snapshot: AdministeredTestSnapshotModel
    ) -> AdministeredTestSnapshotSummaryModel:
        return AdministeredTestSnapshotSummaryModel(
            id=snapshot.id,
            source_bank_title=snapshot.source_bank_title,
            source_test_id=snapshot.source_test_id,
            title=snapshot.title,
            version=snapshot.version,
            printed_at=snapshot.printed_at,
            total_points=snapshot.answer_key.total_points,
            page_count=len(snapshot.layout.pages),
            mode=snapshot.layout.mode,
        )

    def _read_all_snapshots(self) -> list[AdministeredTestSnapshotModel]:
        _, workspace_path = self.ensure_open()
        snapshots_dir = workspace_path / "snapshots"
        if not snapshots_dir.exists():
            return []
        return [
            AdministeredTestSnapshotModel.model_validate_json(snapshot_path.read_text())
            for snapshot_path in sorted(snapshots_dir.glob("*/snapshot.json"))
        ]

    # -- Internal helpers -----------------------------------------------------

    def _new_workspace_dir(self, stem: str) -> Path:
        workspace_root = Path(tempfile.gettempdir()) / "nexzam-gradebook-workspaces"
        workspace_root.mkdir(parents=True, exist_ok=True)
        workspace_path = workspace_root / f"{stem}-{uuid.uuid4().hex[:8]}"
        workspace_path.mkdir(parents=True, exist_ok=False)
        return workspace_path

    def _ensure_support_files(self, workspace_path: Path) -> None:
        roster_dir = workspace_path / "roster"
        roster_dir.mkdir(parents=True, exist_ok=True)
        students_path = roster_dir / "students.json"
        if not students_path.exists():
            students_path.write_text(StudentCollectionModel().model_dump_json(indent=2) + "\n")

        (workspace_path / "snapshots").mkdir(parents=True, exist_ok=True)

    def _validate_workspace(self, workspace_path: Path) -> None:
        manifest_path = workspace_path / "manifest.json"
        if not manifest_path.exists():
            raise BankWorkspaceError("Gradebook is missing manifest.json", status_code=400)
        GradebookManifestModel.model_validate_json(manifest_path.read_text())
        StudentCollectionModel.model_validate_json((workspace_path / "roster" / "students.json").read_text())

    def _read_manifest(self) -> GradebookManifestModel:
        _, workspace_path = self.ensure_open()
        return GradebookManifestModel.model_validate_json((workspace_path / "manifest.json").read_text())

    def _refresh_manifest_timestamp(self) -> None:
        _, workspace_path = self.ensure_open()
        manifest = self._read_manifest()
        manifest.updated_at = datetime.now(UTC)
        (workspace_path / "manifest.json").write_text(manifest.model_dump_json(indent=2) + "\n")

    def _read_students(self) -> StudentCollectionModel:
        _, workspace_path = self.ensure_open()
        return StudentCollectionModel.model_validate_json(
            (workspace_path / "roster" / "students.json").read_text()
        )

    def _write_students(self, workspace_path: Path, students: StudentCollectionModel) -> None:
        (workspace_path / "roster" / "students.json").write_text(
            students.model_dump_json(indent=2) + "\n"
        )
