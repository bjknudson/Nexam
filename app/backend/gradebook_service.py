from __future__ import annotations

import io
import json
import tempfile
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np
import pymupdf
from PIL import Image

from .grading.aggregate import build_student_performance
from .grading.answer_key import derive_answer_key
from .grading.csv_export import build_scores_csv, suggested_filename
from .grading.detect import decode_qr_payload, parse_qr_payload, read_sheet
from .grading.layout import SheetCopySpec, build_sheet_layout
from .grading.lineage import lineage_id_for_title, lineage_title, resolve_lineage_id
from .grading.pdf import render_sheet_layout_to_pdf
from .grading.scoring import combine_by_standard, score_batch
from .models import (
    AdministeredTestSnapshotListResponseModel,
    AdministeredTestSnapshotModel,
    AdministeredTestSnapshotSummaryModel,
    AnswerKeyModel,
    CombinedGradeReportModel,
    DetectedRowResultModel,
    GradebookManifestModel,
    GradebookSummaryModel,
    GradeReportModel,
    GradingBatchListResponseModel,
    GradingBatchModel,
    QuestionModel,
    RetakeResolution,
    ScannedSheetModel,
    ScoreExportMethod,
    SheetPageModel,
    StudentCollectionModel,
    StudentListResponseModel,
    StudentModel,
    StudentPerformanceListResponseModel,
    StudentPerformanceModel,
    TestDraftModel,
    TestPerformanceItemModel,
    TestPerformanceRunModel,
    UpsertStudentRequest,
)
from .grading.review_state import sheet_needs_review
from .service import BankWorkspaceError

_SCAN_RASTER_DPI = 300


_UNSET_PAYLOAD: dict = {"__unset__": True}


def _new_sheet_id() -> str:
    """12 uppercase hex characters.

    48 bits is unique enough for every sheet a gradebook will ever hold, and
    uppercase keeps the payload inside QR's alphanumeric character set. The two
    together fit the smallest QR there is, which is what decides how many
    scanner pixels land on each module.
    """

    return uuid.uuid4().hex[:12].upper()


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

    @staticmethod
    def _as_gradebook_path(destination_path: str) -> Path:
        """Normalize a destination into a `.nxgb` path.

        A teacher typing a path should not have to remember the extension, and a
        save dialog can hand back a name without one, so append it rather than
        refusing the path. A different extension is still an error: silently
        renaming someone's `.bok` would be worse than saying no.
        """

        target_path = Path(destination_path).expanduser().resolve()
        if target_path.suffix == ".nxgb":
            return target_path
        if target_path.suffix:
            raise BankWorkspaceError(
                f"A gradebook file must end with .nxgb, not {target_path.suffix}",
                status_code=400,
            )
        return target_path.with_name(f"{target_path.name}.nxgb")

    def create_gradebook(
        self, title: str, description: str | None, destination_path: str
    ) -> GradebookSummaryModel:
        title = (title or "").strip()
        if not title:
            raise BankWorkspaceError("Gradebook title must not be empty.", status_code=400)

        target_path = self._as_gradebook_path(destination_path)

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
        target_path = (
            self._as_gradebook_path(destination_path) if destination_path else source_path
        )

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
                section=request.section,
                grouping=request.grouping,
            )
            students.items = [updated if s.id == student_id else s for s in students.items]
        else:
            updated = StudentModel(
                id=uuid.uuid4().hex,
                first_name=request.first_name,
                last_name=request.last_name,
                external_id=request.external_id,
                section=request.section,
                grouping=request.grouping,
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
        alternates: list[tuple[TestDraftModel, list[QuestionModel]]] | None = None,
        generation_batch_id: str | None = None,
    ) -> AdministeredTestSnapshotModel:
        _, workspace_path = self.ensure_open()

        questions_by_id = {question.id: question for question in questions}
        answer_key = derive_answer_key(test, questions_by_id)

        alternate_keys: list[AnswerKeyModel] = []
        version_labels: list[str] = []
        if test.interchangeable_sheets and alternates:
            alternate_keys = self._compatible_alternate_keys(answer_key, alternates)
            version_labels = sorted(
                {answer_key.version, *(key.version for key in alternate_keys)}
            )

        copies = self._build_copies(mode, blank_count, student_ids)
        layout_id = uuid.uuid4().hex
        layout = build_sheet_layout(
            layout_id=layout_id,
            answer_key=answer_key,
            mode=mode,
            page_size=page_size,
            copies=copies,
            header_label=(
                f"{test.title} - mark your version below"
                if version_labels
                else f"{test.title} - Version {test.version}"
            ),
            version_labels=version_labels,
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
            print_settings=test.print_settings,
            answer_key=answer_key,
            alternate_answer_keys=alternate_keys,
            layout=layout,
            generation_batch_id=generation_batch_id,
            lineage_id=lineage_id_for_title(test.title),
        )

        snapshot_dir = workspace_path / "snapshots" / snapshot.id
        snapshot_dir.mkdir(parents=True, exist_ok=False)
        (snapshot_dir / "snapshot.json").write_text(snapshot.model_dump_json(indent=2) + "\n")
        (snapshot_dir / "sheet.pdf").write_bytes(render_sheet_layout_to_pdf(layout))

        return snapshot

    def _compatible_alternate_keys(
        self,
        answer_key: AnswerKeyModel,
        alternates: list[tuple[TestDraftModel, list[QuestionModel]]],
    ) -> list[AnswerKeyModel]:
        """Keys for the sibling versions, kept only where the sheet shape matches.

        One sheet can serve several versions only if every version asks for the
        same run of row kinds -- same multiple choice, then numeric, then written
        -- because the bubbles are at fixed coordinates. A version that diverges
        is dropped rather than silently mis-scored: its own sheets still work.
        """

        def shape(key: AnswerKeyModel) -> list[str]:
            return [item.row_kind for item in key.items]

        target_shape = shape(answer_key)
        compatible: list[AnswerKeyModel] = []
        for alternate_test, alternate_questions in alternates:
            alternate_key = derive_answer_key(
                alternate_test, {question.id: question for question in alternate_questions}
            )
            if shape(alternate_key) == target_shape:
                compatible.append(alternate_key)
        return compatible

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
                        sheet_id=_new_sheet_id(),
                        student_id=student.id,
                        printed_name=f"{student.first_name} {student.last_name}",
                    )
                )
            return copies

        count = blank_count if blank_count and blank_count > 0 else 1
        return [SheetCopySpec(sheet_id=_new_sheet_id()) for _ in range(count)]

    def list_administered_tests(self) -> AdministeredTestSnapshotListResponseModel:
        summaries = [self._snapshot_summary(snapshot) for snapshot in self._read_all_snapshots()]
        summaries.sort(key=lambda summary: summary.printed_at, reverse=True)
        return AdministeredTestSnapshotListResponseModel(items=summaries)

    def get_administered_test(self, snapshot_id: str) -> AdministeredTestSnapshotModel:
        """The full frozen snapshot, including the questions as they were printed.

        Scan review needs the question text and rubric to score a written
        response, and those must come from the snapshot rather than the bank:
        the bank may have changed, or not be open at all.
        """

        for snapshot in self._read_all_snapshots():
            if snapshot.id == snapshot_id:
                return snapshot
        raise BankWorkspaceError(f"Administered test not found: {snapshot_id}", status_code=404)

    def get_sheet_pdf_bytes(self, layout_id: str) -> bytes:
        _, workspace_path = self.ensure_open()
        for snapshot in self._read_all_snapshots():
            if snapshot.layout.id == layout_id:
                pdf_path = workspace_path / "snapshots" / snapshot.id / "sheet.pdf"
                return pdf_path.read_bytes()
        raise BankWorkspaceError(f"No sheet found for layout: {layout_id}", status_code=404)

    def get_batch_pdf_bytes(self, generation_batch_id: str) -> bytes:
        """One print job's worth of pages, across every version in a batch.

        A version-assignment run produces one snapshot per version (each keeps
        its own frozen answer key), but the teacher wants to print them as a
        single job -- so their PDFs are concatenated here rather than at
        generation time, reusing pymupdf the same way scan ingestion already
        does for reading uploaded PDFs.
        """

        _, workspace_path = self.ensure_open()
        batch_snapshots = [
            snapshot
            for snapshot in self._read_all_snapshots()
            if snapshot.generation_batch_id == generation_batch_id
        ]
        if not batch_snapshots:
            raise BankWorkspaceError(
                f"No response sheets found for batch: {generation_batch_id}", status_code=404
            )
        batch_snapshots.sort(key=lambda snapshot: snapshot.version)

        merged = pymupdf.open()
        for snapshot in batch_snapshots:
            pdf_path = workspace_path / "snapshots" / snapshot.id / "sheet.pdf"
            with pymupdf.open(pdf_path) as document:
                merged.insert_pdf(document)
        return merged.tobytes()

    def _snapshot_summary(
        self, snapshot: AdministeredTestSnapshotModel
    ) -> AdministeredTestSnapshotSummaryModel:
        return AdministeredTestSnapshotSummaryModel(
            id=snapshot.id,
            layout_id=snapshot.layout.id,
            source_bank_title=snapshot.source_bank_title,
            source_test_id=snapshot.source_test_id,
            title=snapshot.title,
            version=snapshot.version,
            printed_at=snapshot.printed_at,
            total_points=snapshot.answer_key.total_points,
            page_count=len(snapshot.layout.pages),
            mode=snapshot.layout.mode,
            lineage_id=resolve_lineage_id(snapshot),
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

    # -- Scan batches / ingestion --------------------------------------------

    def create_scan_batch(self, snapshot_id: str, source_description: str | None) -> GradingBatchModel:
        _, workspace_path = self.ensure_open()
        if not any(s.id == snapshot_id for s in self._read_all_snapshots()):
            raise BankWorkspaceError(f"Snapshot not found: {snapshot_id}", status_code=404)

        batch = GradingBatchModel(
            id=uuid.uuid4().hex,
            snapshot_id=snapshot_id,
            created_at=datetime.now(UTC),
            source_description=source_description,
            sheets=[],
        )
        (workspace_path / "scans" / batch.id).mkdir(parents=True, exist_ok=True)
        self._write_batch(workspace_path, batch)
        return batch

    def list_scan_batches(self) -> GradingBatchListResponseModel:
        return GradingBatchListResponseModel(items=self._read_all_batches())

    def get_scan_batch(self, batch_id: str) -> GradingBatchModel:
        return self._read_batch(batch_id)

    def ingest_scan_batch(
        self, batch_id: str, files: list[tuple[str, bytes]]
    ) -> GradingBatchModel:
        _, workspace_path = self.ensure_open()
        batch = self._read_batch(batch_id)
        sheet_lookup = self._build_sheet_lookup()
        scans_dir = workspace_path / "scans" / batch.id

        for filename, content in files:
            for page_image in self._rasterize_upload(filename, content):
                sheet = self._ingest_page(page_image, batch, sheet_lookup, scans_dir)
                batch.sheets.append(sheet)

        self._write_batch(workspace_path, batch)
        return batch

    def ingest_scans(
        self, files: list[tuple[str, bytes]], fallback_snapshot_id: str | None = None
    ) -> list[GradingBatchModel]:
        """Take a pile of scans and sort them by the test each sheet says it is.

        Every sheet already carries a QR naming the exact printing it came from,
        so asking the teacher to declare a batch first was asking for something
        the paper already knows. Pages are routed to the batch for their own
        snapshot, one batch per test and version, created on first sight.

        `fallback_snapshot_id` is where pages whose QR could not be read go. The
        caller passes the test the teacher is actually looking at, so an
        unreadable page files itself under the test they were scanning rather
        than under whichever test happens to have been printed most recently.
        """

        _, workspace_path = self.ensure_open()
        if fallback_snapshot_id is not None:
            # Fail now rather than filing pages against an id that isn't real.
            self.get_snapshot(fallback_snapshot_id)
        sheet_lookup = self._build_sheet_lookup()
        touched: dict[str, GradingBatchModel] = {}

        for filename, content in files:
            for page_image in self._rasterize_upload(filename, content):
                payload = decode_qr_payload(page_image)
                snapshot_id = None
                if payload is not None and isinstance(payload.get("sheet_id"), str):
                    match = sheet_lookup.get(payload["sheet_id"])
                    if match is not None:
                        snapshot_id = match[0].id

                batch = self._batch_for_snapshot(snapshot_id, touched, fallback_snapshot_id)
                scans_dir = workspace_path / "scans" / batch.id
                scans_dir.mkdir(parents=True, exist_ok=True)
                sheet = self._ingest_page(
                    page_image, batch, sheet_lookup, scans_dir, payload=payload
                )
                batch.sheets.append(sheet)

        for batch in touched.values():
            self._write_batch(workspace_path, batch)
        return sorted(touched.values(), key=lambda item: item.created_at)

    def _batch_for_snapshot(
        self,
        snapshot_id: str | None,
        touched: dict[str, GradingBatchModel],
        fallback_snapshot_id: str | None = None,
    ) -> GradingBatchModel:
        """The open batch for a snapshot, reused across this upload and across
        uploads, so re-scanning a few stragglers does not fragment a class set.

        A page whose QR could not be read has no snapshot to sort by, and is
        filed somewhere real and flagged for review -- a sheet a teacher cannot
        find is worse than one filed in the wrong place. In order of preference:
        the test the caller says they are working on, then whatever this upload
        has already landed in, then the most recently printed test.
        """

        if snapshot_id is None:
            if fallback_snapshot_id is not None:
                snapshot_id = fallback_snapshot_id
            elif touched:
                return next(reversed(list(touched.values())))
            else:
                snapshots = self._read_all_snapshots()
                if not snapshots:
                    raise BankWorkspaceError(
                        "No tests have been handed off to this gradebook yet, so there is "
                        "nothing for these scans to belong to.",
                        status_code=400,
                    )
                snapshot_id = max(snapshots, key=lambda item: item.printed_at).id

        if snapshot_id in touched:
            return touched[snapshot_id]

        existing = next(
            (batch for batch in self._read_all_batches() if batch.snapshot_id == snapshot_id),
            None,
        )
        if existing is not None:
            touched[snapshot_id] = existing
            return existing

        snapshot = self.get_snapshot(snapshot_id)
        created = self.create_scan_batch(
            snapshot_id, f"{snapshot.title} - Version {snapshot.version}"
        )
        touched[snapshot_id] = created
        return created

    def get_review_queue(self, batch_id: str) -> list[ScannedSheetModel]:
        return [sheet for sheet in self._read_batch(batch_id).sheets if sheet.needs_review]

    # -- Reporting ------------------------------------------------------------

    def get_grade_report(self, batch_id: str) -> GradeReportModel:
        batch = self._read_batch(batch_id)
        snapshot = self.get_snapshot(batch.snapshot_id)
        return score_batch(batch, snapshot, self._read_students().items)

    def get_combined_lineage_report(
        self, test_title: str | None = None, lineage_id: str | None = None
    ) -> CombinedGradeReportModel:
        """Score-by-standard across every version of one test.

        `lineage_id` is the accurate way in -- it follows the explicit retake
        link, so a retake titled differently is included and a test deliberately
        split out is not. Title lookup stays for callers that only have a title,
        and resolves through the same lineage so it picks up linked retakes too.
        """

        all_snapshots = self._read_all_snapshots()
        if lineage_id:
            target_lineage = lineage_id
        elif test_title:
            target_lineage = lineage_id_for_title(test_title)
        else:
            raise BankWorkspaceError(
                "A combined report needs either a lineage_id or a test_title.", status_code=400
            )

        snapshots = [s for s in all_snapshots if resolve_lineage_id(s) == target_lineage]
        snapshot_ids = {s.id for s in snapshots}
        batches = [b for b in self._read_all_batches() if b.snapshot_id in snapshot_ids]

        reports = [self.get_grade_report(batch.id) for batch in batches]
        return CombinedGradeReportModel(
            test_title=lineage_title(snapshots) or (test_title or ""),
            lineage_id=target_lineage,
            snapshot_ids=sorted(snapshot_ids),
            batch_ids=[batch.id for batch in batches],
            scored_sheet_count=sum(report.scored_sheet_count for report in reports),
            by_standard=combine_by_standard(reports),
        )

    # -- Cross-test student performance ---------------------------------------

    def get_student_performance(
        self, resolution: RetakeResolution = "most_recent"
    ) -> StudentPerformanceListResponseModel:
        """Every student's whole record in this gradebook, in one pass.

        Deliberately computed for the whole roster at once rather than per
        student: scoring is driven off the batches, so answering for one student
        costs the same read-and-score of every batch that answering for all of
        them does. One call, one pass, and the caller filters.
        """

        return build_student_performance(
            students=self._read_students().items,
            snapshots=self._read_all_snapshots(),
            batches=self._read_all_batches(),
            resolution=resolution,
        )

    def get_one_student_performance(
        self, student_id: str, resolution: RetakeResolution = "most_recent"
    ) -> StudentPerformanceModel:
        performance = self.get_student_performance(resolution)
        for item in performance.items:
            if item.student.id == student_id:
                return item
        raise BankWorkspaceError(f"Student not found: {student_id}", status_code=404)

    def relink_snapshot_lineage(
        self,
        snapshot_id: str,
        *,
        lineage_of_snapshot_id: str | None,
        lineage_id: str | None,
    ) -> AdministeredTestSnapshotSummaryModel:
        """Say that this printing is (or is no longer) the same test as another.

        The only edit ever made to a stored snapshot. It touches nothing that
        describes what was printed -- not the items, not the key, not the layout
        -- so the promise that a snapshot is a faithful record of the paper
        still holds; it only changes which pile the gradebook files it under.
        """

        _, workspace_path = self.ensure_open()
        snapshot = self.get_snapshot(snapshot_id)

        if lineage_of_snapshot_id:
            snapshot.lineage_id = resolve_lineage_id(self.get_snapshot(lineage_of_snapshot_id))
        elif lineage_id:
            snapshot.lineage_id = lineage_id
        else:
            # Back to whatever the title says, which is where it started.
            snapshot.lineage_id = lineage_id_for_title(snapshot.title)

        snapshot_path = workspace_path / "snapshots" / snapshot.id / "snapshot.json"
        snapshot_path.write_text(snapshot.model_dump_json(indent=2) + "\n")
        return self._snapshot_summary(snapshot)

    # -- CSV export -----------------------------------------------------------

    def export_scores_csv(
        self,
        method: ScoreExportMethod = "total",
        resolution: RetakeResolution = "most_recent",
        section: str | None = None,
        standard_codes: dict[str, str] | None = None,
    ) -> tuple[str, str]:
        """Returns (csv_text, suggested_filename).

        `section` filters the roster the same way response-sheet generation
        does, so a teacher can export one class period at a time out of a
        gradebook that holds several.
        """

        performance = self.get_student_performance(resolution)
        if section:
            wanted = section.strip().casefold()
            performance = performance.model_copy(
                update={
                    "items": [
                        item
                        for item in performance.items
                        if (item.student.section or "").strip().casefold() == wanted
                    ]
                }
            )

        return (
            build_scores_csv(performance, method, standard_codes),
            suggested_filename(method, resolution),
        )

    def build_performance_run(self, batch_id: str, cohort_label: str | None = None) -> TestPerformanceRunModel:
        """Pure mapping from a grade report to the bank's performance-run
        shape -- writing it into a bank is the caller's job (main.py), since
        this service must stay usable with no bank open at all."""

        report = self.get_grade_report(batch_id)
        return TestPerformanceRunModel(
            id=uuid.uuid4().hex,
            administered_at=datetime.now(UTC),
            cohort_label=cohort_label,
            notes=(
                f"Recorded from gradebook batch {batch_id}."
                + (" Some manual-capture items were not yet scored." if report.contains_unscored_manual_items else "")
            ),
            item_results=[
                TestPerformanceItemModel(
                    question_id=item.question_id,
                    attempts=item.attempts,
                    correct=item.full_credit_count,
                    average_score=None,
                    # QuestionModel.difficulty is 1 (easy) to 5 (hard); map full-credit
                    # rate onto that same scale rather than reporting a raw percentage.
                    observed_difficulty=(
                        1.0 + 4.0 * (1.0 - item.percent_full_credit / 100.0) if item.attempts else None
                    ),
                    tricky=item.attempts > 0 and item.percent_full_credit < 50.0,
                    notes=None,
                )
                for item in report.by_item
            ],
        )

    def get_snapshot(self, snapshot_id: str) -> AdministeredTestSnapshotModel:
        snapshot = next((s for s in self._read_all_snapshots() if s.id == snapshot_id), None)
        if snapshot is None:
            raise BankWorkspaceError(f"Snapshot not found: {snapshot_id}", status_code=404)
        return snapshot

    def get_sheet_image_bytes(self, batch_id: str, sheet_id: str) -> bytes:
        _, workspace_path = self.ensure_open()
        batch = self._read_batch(batch_id)
        sheet = self._find_sheet(batch, sheet_id)
        return (workspace_path / sheet.source_image_path).read_bytes()

    def reassign_sheet_to_printing(
        self, batch_id: str, sheet_id: str, snapshot_id: str, page_index: int = 0
    ) -> ScannedSheetModel:
        """Read a scan against a printing the teacher names, instead of the QR.

        A damaged or unreadable QR leaves a perfectly good page unscoreable, and
        a page from an earlier printing lands in the wrong batch. Both are
        recoverable when a human can say which test the paper is: the corner
        markers still line the page up, and the layout supplies the rest.

        The read is redone from the stored scan, so this is not a way to assert
        answers -- if the page still cannot be lined up, it still fails, and it
        says so.
        """

        _, workspace_path = self.ensure_open()
        batch = self._read_batch(batch_id)
        sheet = self._find_sheet(batch, sheet_id)
        snapshot = self.get_snapshot(snapshot_id)

        if snapshot.id != batch.snapshot_id:
            raise BankWorkspaceError(
                "That printing belongs to a different batch. Move the sheet to that batch, or "
                "pick the printing this batch was made for.",
                status_code=400,
            )

        pages = snapshot.layout.pages
        page = next((p for p in pages if p.page_index == page_index), pages[0] if pages else None)
        if page is None:
            raise BankWorkspaceError("That printing has no pages to match.", status_code=400)

        image_bytes = (workspace_path / sheet.source_image_path).read_bytes()
        images = list(self._rasterize_upload(sheet.source_image_path, image_bytes))
        if not images:
            raise BankWorkspaceError("The stored scan could not be read back.", status_code=400)

        row_results, fiducial_confidence, detected_version = read_sheet(
            images[0],
            page,
            snapshot.layout.page_width_pt,
            snapshot.layout.page_height_pt,
            version_labels=snapshot.layout.version_labels,
        )

        if fiducial_confidence is None:
            raise BankWorkspaceError(
                "The page still could not be lined up: its corner markers were not found. "
                "Rescan it flat, fully in frame, and right way up.",
                status_code=400,
            )

        sheet.snapshot_id = snapshot.id
        sheet.layout_id = snapshot.layout.id
        sheet.page_index = page.page_index
        sheet.fiducial_confidence = fiducial_confidence
        sheet.detected_version = detected_version
        sheet.row_results = row_results
        # The page is now matched by hand; keep whoever it was already attributed to.
        if sheet.identity_status in ("qr_unreadable", "wrong_snapshot", "unresolved"):
            sheet.identity_status = (
                "manually_resolved" if (sheet.student_id or sheet.free_text_name) else "unresolved"
            )
        sheet.needs_review = sheet_needs_review(sheet)

        self._write_batch(workspace_path, batch)
        return sheet

    def resolve_sheet_identity(
        self,
        batch_id: str,
        sheet_id: str,
        *,
        student_id: str | None = None,
        free_text_name: str | None = None,
    ) -> ScannedSheetModel:
        # Blank strings arrive from empty form fields; treat them as absent so the
        # message below is about what the teacher did, not about the payload.
        student_id = (student_id or "").strip() or None
        free_text_name = (free_text_name or "").strip() or None
        if not student_id and not free_text_name:
            raise BankWorkspaceError(
                "Pick a student from the roster, or type a name, before saving this sheet's identity.",
                status_code=400,
            )
        if student_id and not any(s.id == student_id for s in self._read_students().items):
            raise BankWorkspaceError(f"Student not found: {student_id}", status_code=404)

        _, workspace_path = self.ensure_open()
        batch = self._read_batch(batch_id)
        sheet = self._find_sheet(batch, sheet_id)

        sheet.student_id = student_id
        sheet.free_text_name = free_text_name
        sheet.identity_status = "manually_resolved"
        sheet.needs_review = sheet_needs_review(sheet)

        self._write_batch(workspace_path, batch)
        return sheet

    def override_row_result(
        self,
        batch_id: str,
        sheet_id: str,
        question_id: str,
        *,
        override_choice_indices: list[int] | None = None,
        override_value: float | None = None,
        override_blank: bool | None = None,
        override_note: str | None = None,
        manual_score: float | None = None,
        manual_score_max: float | None = None,
        manual_grader_note: str | None = None,
    ) -> ScannedSheetModel:
        _, workspace_path = self.ensure_open()
        batch = self._read_batch(batch_id)
        sheet = self._find_sheet(batch, sheet_id)
        row = next((r for r in sheet.row_results if r.question_id == question_id), None)
        if row is None:
            raise BankWorkspaceError(
                f"No row result for question {question_id} on sheet {sheet_id}.", status_code=404
            )

        if row.kind == "manual_capture":
            row.manual_score = manual_score
            row.manual_score_max = manual_score_max
            row.manual_grader_note = manual_grader_note
        else:
            row.override_choice_indices = override_choice_indices
            row.override_value = override_value
            if override_blank is not None:
                row.override_blank = override_blank
            row.override_note = override_note

        sheet.needs_review = sheet_needs_review(sheet)
        self._write_batch(workspace_path, batch)
        return sheet

    def _find_sheet(self, batch: GradingBatchModel, sheet_id: str) -> ScannedSheetModel:
        sheet = next((s for s in batch.sheets if s.id == sheet_id), None)
        if sheet is None:
            raise BankWorkspaceError(f"Sheet not found: {sheet_id}", status_code=404)
        return sheet

    def _ingest_page(
        self,
        page_image: np.ndarray,
        batch: GradingBatchModel,
        sheet_lookup: dict[str, tuple[AdministeredTestSnapshotModel, SheetPageModel]],
        scans_dir: Path,
        payload: dict | None = _UNSET_PAYLOAD,
    ) -> ScannedSheetModel:
        sheet_seq = len(list(scans_dir.glob("*.png")))
        image_path = scans_dir / f"{sheet_seq:04d}.png"
        cv2.imwrite(str(image_path), page_image)
        relative_image_path = str(image_path.relative_to(scans_dir.parents[1]))

        # Decoding a 300dpi page is not cheap, so a caller that already looked at
        # the QR to decide where this page belongs passes it back in.
        if payload is _UNSET_PAYLOAD:
            payload = decode_qr_payload(page_image)
        if payload is None or not isinstance(payload.get("sheet_id"), str):
            return ScannedSheetModel(
                id=uuid.uuid4().hex,
                source_image_path=relative_image_path,
                identity_status="qr_unreadable",
                needs_review=True,
            )

        sheet_id = payload["sheet_id"]
        match = sheet_lookup.get(sheet_id)
        if match is None:
            return ScannedSheetModel(
                id=uuid.uuid4().hex,
                sheet_id=sheet_id,
                source_image_path=relative_image_path,
                identity_status="qr_unreadable",
                needs_review=True,
            )

        snapshot, page = match
        # From the page, falling back to the payload for sheets printed before
        # the student id was taken out of the QR.
        student_id = page.student_id or payload.get("student_id")
        if snapshot.id != batch.snapshot_id:
            identity_status = "wrong_snapshot"
        elif student_id:
            identity_status = "pre_identified"
        else:
            identity_status = "unresolved"

        row_results, fiducial_confidence, detected_version = read_sheet(
            page_image,
            page,
            snapshot.layout.page_width_pt,
            snapshot.layout.page_height_pt,
            version_labels=snapshot.layout.version_labels,
        )

        sheet = ScannedSheetModel(
            id=uuid.uuid4().hex,
            snapshot_id=snapshot.id,
            layout_id=snapshot.layout.id,
            sheet_id=sheet_id,
            source_image_path=relative_image_path,
            page_index=page.page_index,
            student_id=student_id,
            identity_status=identity_status,
            fiducial_confidence=fiducial_confidence,
            detected_version=detected_version,
            row_results=row_results,
        )
        sheet.needs_review = sheet_needs_review(sheet)
        return sheet

    def _build_sheet_lookup(
        self,
    ) -> dict[str, tuple[AdministeredTestSnapshotModel, SheetPageModel]]:
        """Every sheet_id is unique across every snapshot ever printed in this
        gradebook, so it alone is enough to resolve which snapshot and page a
        scanned QR code belongs to -- no need to also encode layout/snapshot
        ids in the QR payload itself."""

        lookup: dict[str, tuple[AdministeredTestSnapshotModel, SheetPageModel]] = {}
        for snapshot in self._read_all_snapshots():
            for page in snapshot.layout.pages:
                page_payload = parse_qr_payload(page.qr_payload)
                if page_payload is None:
                    continue
                page_sheet_id = page_payload.get("sheet_id")
                if isinstance(page_sheet_id, str):
                    lookup[page_sheet_id] = (snapshot, page)
        return lookup

    def _rasterize_upload(self, filename: str, content: bytes) -> list[np.ndarray]:
        is_pdf = filename.lower().endswith(".pdf") or content[:4] == b"%PDF"
        if is_pdf:
            document = pymupdf.open(stream=content, filetype="pdf")
            images = []
            for page in document:
                pixmap = page.get_pixmap(dpi=_SCAN_RASTER_DPI)
                array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                    pixmap.height, pixmap.width, pixmap.n
                )
                images.append(
                    cv2.cvtColor(array, cv2.COLOR_RGB2GRAY) if pixmap.n >= 3 else array[:, :, 0]
                )
            return images

        pil_image = Image.open(io.BytesIO(content)).convert("L")
        return [np.array(pil_image)]

    def _write_batch(self, workspace_path: Path, batch: GradingBatchModel) -> None:
        batch_path = workspace_path / "batches" / f"{batch.id}.json"
        batch_path.write_text(batch.model_dump_json(indent=2) + "\n")

    def _read_batch(self, batch_id: str) -> GradingBatchModel:
        _, workspace_path = self.ensure_open()
        batch_path = workspace_path / "batches" / f"{batch_id}.json"
        if not batch_path.exists():
            raise BankWorkspaceError(f"Scan batch not found: {batch_id}", status_code=404)
        return GradingBatchModel.model_validate_json(batch_path.read_text())

    def _read_all_batches(self) -> list[GradingBatchModel]:
        _, workspace_path = self.ensure_open()
        batches_dir = workspace_path / "batches"
        if not batches_dir.exists():
            return []
        return [
            GradingBatchModel.model_validate_json(batch_path.read_text())
            for batch_path in sorted(batches_dir.glob("*.json"))
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
        (workspace_path / "batches").mkdir(parents=True, exist_ok=True)
        (workspace_path / "scans").mkdir(parents=True, exist_ok=True)

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
