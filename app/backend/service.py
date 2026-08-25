from __future__ import annotations
import ast
import csv
import json
import shutil
import tempfile
import uuid
import zipfile
from datetime import UTC, datetime
from mimetypes import guess_type
from pathlib import Path
import re

from pydantic import ValidationError

from .models import (
    AssetInspectionBatchRequest,
    AssetInspectionBatchResponseModel,
    AssetInspectionRequest,
    AssetInspectionResponseModel,
    AssetListItemModel,
    AssetListResponseModel,
    AssetUploadResponseModel,
    BankIndexModel,
    BankSummaryModel,
    CourseCollectionModel,
    CourseDetailModel,
    CourseListResponseModel,
    CourseModel,
    CourseStandardCoverageModel,
    CourseTestSummaryModel,
    CreateStandardsManuallyRequest,
    DetectedImportSourceModel,
    ManifestModel,
    ManualStandardRowModel,
    QuestionListItemModel,
    QuestionListResponseModel,
    QuestionImportListResponseModel,
    QuestionImportPromoteResponseModel,
    QuestionImportRowModel,
    QuestionImportStageModel,
    QuestionImportValidationIssueModel,
    QuestionModel,
    QuestionType,
    SourceStandardListCollectionModel,
    SourceStandardListModel,
    StandardImportInspectionModel,
    StandardImportResponseModel,
    StandardListResponseModel,
    StandardRecordCollectionModel,
    StandardRecordModel,
    StandardReferenceModel,
    StandardSearchResponseModel,
    TestDraftCollectionModel,
    TestDraftDetailModel,
    TestDraftListResponseModel,
    TestDraftModel,
    TestDraftSummaryModel,
    TestQuestionItemModel,
    TestSectionItemModel,
    TestStandardBalanceModel,
)


class BankWorkspaceError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


ParsedQuestionImportRow = tuple[
    dict[str, object],
    dict[str, object],
    list[QuestionImportValidationIssueModel],
]


class BankWorkspaceService:
    BANK_SCHEMA_VERSION = "1.0.0"
    QUESTION_ID_PREFIX_BY_TYPE: dict[str, str] = {
        "multiple_choice": "q_mc",
        "numeric_response": "q_num",
        "short_answer": "q_sa",
        "free_response": "q_fr",
    }
    # Column and key spellings an imported standard may use to name its own
    # source. A bare `subject`/`version` belongs to the standard, so only the
    # explicit `source_*` spellings claim those for the source.
    SOURCE_ROW_ALIASES: dict[str, tuple[str, ...]] = {
        "id": ("source_list_id", "source_id"),
        "title": ("source_title", "source_list", "source_name", "source", "framework"),
        "issuer": ("source_issuer", "issuer", "publisher", "organization", "organisation"),
        "subject": ("source_subject",),
        "version": ("source_version",),
        "description": ("source_description",),
    }
    SVG_PLACEHOLDER_PATTERN = re.compile(r"{{\s*([a-zA-Z0-9_.-]+)\s*}}")
    SVG_CALC_PATTERN = re.compile(r"{{\s*calc:\s*([^{}]+?)\s*}}")
    SVG_EXPR_VARIABLE_PATTERN = re.compile(r"\b([A-Za-z_][A-Za-z0-9_.-]*)\b")
    ALLOWED_ASSET_EXTENSIONS = {
        ".svg": "svg",
        ".png": "image",
        ".jpg": "image",
        ".jpeg": "image",
        ".gif": "image",
        ".webp": "image",
    }

    def __init__(self) -> None:
        self._source_path: Path | None = None
        self._workspace_path: Path | None = None

    def ensure_open(self) -> tuple[Path, Path]:
        if self._source_path is None or self._workspace_path is None:
            raise BankWorkspaceError("No bank is currently open.", status_code=400)
        return self._source_path, self._workspace_path

    def open_bank(self, bok_path: str) -> BankSummaryModel:
        source_path = Path(bok_path).expanduser().resolve()
        if not source_path.exists():
            raise BankWorkspaceError(f"Bank file not found: {source_path}", status_code=404)
        if not zipfile.is_zipfile(source_path):
            raise BankWorkspaceError("Selected file is not a valid .bok zip archive.", status_code=400)

        workspace_root = Path(tempfile.gettempdir()) / "nexzam-workspaces"
        workspace_root.mkdir(parents=True, exist_ok=True)
        workspace_path = workspace_root / f"{source_path.stem}-{uuid.uuid4().hex[:8]}"
        workspace_path.mkdir(parents=True, exist_ok=False)

        with zipfile.ZipFile(source_path) as archive:
            archive.extractall(workspace_path)

        normalized_path = self._normalize_workspace_root(workspace_path)
        self._ensure_support_files(normalized_path)
        self._ensure_referenced_standard_records(normalized_path)
        self._ensure_referenced_course_ids(normalized_path)
        self._validate_workspace(normalized_path)

        self._source_path = source_path
        self._workspace_path = normalized_path

        self._refresh_bank_index()
        return self.get_summary()

    def create_bank(self, title: str, description: str | None, destination_path: str) -> BankSummaryModel:
        title = (title or "").strip()
        if not title:
            raise BankWorkspaceError("Bank title must not be empty.", status_code=400)

        target_path = Path(destination_path).expanduser().resolve()
        if target_path.suffix != ".bok":
            raise BankWorkspaceError("Destination path must end with .bok", status_code=400)

        workspace_root = Path(tempfile.gettempdir()) / "nexzam-workspaces"
        workspace_root.mkdir(parents=True, exist_ok=True)
        workspace_path = workspace_root / f"{target_path.stem}-{uuid.uuid4().hex[:8]}"
        workspace_path.mkdir(parents=True, exist_ok=False)
        (workspace_path / "questions").mkdir(parents=True, exist_ok=True)
        (workspace_path / "assets").mkdir(parents=True, exist_ok=True)

        now = datetime.now(UTC)
        manifest = ManifestModel(
            schema_version=self.BANK_SCHEMA_VERSION,
            bank_id=uuid.uuid4().hex,
            title=title,
            description=(description or "").strip() or None,
            created_at=now,
            updated_at=now,
        )
        (workspace_path / "manifest.json").write_text(manifest.model_dump_json(indent=2) + "\n")

        self._source_path = target_path
        self._workspace_path = workspace_path
        self._ensure_support_files(workspace_path)
        self._refresh_bank_index()

        self.save_bank(str(target_path))
        return self.get_summary()

    def update_bank_details(self, title: str, description: str | None) -> BankSummaryModel:
        title = (title or "").strip()
        if not title:
            raise BankWorkspaceError("Bank title must not be empty.", status_code=400)

        _, workspace_path = self.ensure_open()
        manifest = self._read_manifest()
        manifest.title = title
        manifest.description = (description or "").strip() or None
        manifest.updated_at = datetime.now(UTC)
        (workspace_path / "manifest.json").write_text(manifest.model_dump_json(indent=2) + "\n")
        return self.get_summary()

    def get_summary(self) -> BankSummaryModel:
        source_path, workspace_path = self.ensure_open()
        return BankSummaryModel(
            source_path=str(source_path),
            workspace_path=str(workspace_path),
            manifest=self._read_manifest(),
            bank=self._read_bank_index(),
        )

    def list_source_standard_lists(self) -> StandardListResponseModel:
        return StandardListResponseModel(items=self._read_source_standard_lists().items)

    def list_standards(
        self,
        source_list_id: str | None = None,
        search: str | None = None,
        course_id: str | None = None,
        strand: str | None = None,
        sort: str | None = None,
    ) -> StandardSearchResponseModel:
        """Browse the standards library.

        Standards are always grouped under the source they came from, so the
        default order is by source and then by code. Search covers every text
        field on the standard, including its strand.
        """
        standards = self._read_standard_records().items
        lowered_search = (search or "").strip().lower()
        lowered_strand = (strand or "").strip().lower()
        allowed_standard_ids: set[str] | None = None

        if course_id:
            course = next((item for item in self._read_courses().items if item.id == course_id), None)
            if course is None:
                raise BankWorkspaceError(f"Course not found: {course_id}", status_code=404)
            allowed_standard_ids = {reference.standard_id for reference in course.standard_refs}

        filtered: list[StandardRecordModel] = []
        for standard in standards:
            if source_list_id and standard.source_list_id != source_list_id:
                continue
            if allowed_standard_ids is not None and standard.id not in allowed_standard_ids:
                continue
            if lowered_strand and (standard.strand or "").strip().lower() != lowered_strand:
                continue
            if lowered_search and lowered_search not in self._standard_haystack(standard):
                continue
            filtered.append(standard)

        return StandardSearchResponseModel(items=self._sort_standards(filtered, sort))

    def list_standard_strands(self) -> list[str]:
        strands = {
            (standard.strand or "").strip()
            for standard in self._read_standard_records().items
        }
        return sorted(strand for strand in strands if strand)

    def _standard_haystack(self, standard: StandardRecordModel) -> str:
        return " ".join(
            [
                standard.id,
                standard.code,
                standard.statement,
                standard.subject or "",
                standard.strand or "",
                standard.grade_band or "",
                " ".join(standard.tags),
            ]
        ).lower()

    def _sort_standards(
        self,
        standards: list[StandardRecordModel],
        sort: str | None,
    ) -> list[StandardRecordModel]:
        source_titles = {item.id: item.title for item in self._read_source_standard_lists().items}

        def source_key(standard: StandardRecordModel) -> str:
            return (source_titles.get(standard.source_list_id) or standard.source_list_id).lower()

        sort_key = (sort or "source").strip().lower()
        if sort_key == "code":
            return sorted(standards, key=lambda item: (item.code.lower(), item.id.lower()))
        if sort_key == "strand":
            return sorted(
                standards,
                key=lambda item: ((item.strand or "~").lower(), item.code.lower(), item.id.lower()),
            )
        if sort_key == "id":
            return sorted(standards, key=lambda item: item.id.lower())
        return sorted(
            standards,
            key=lambda item: (source_key(item), (item.strand or "").lower(), item.code.lower()),
        )

    def list_courses(self) -> CourseListResponseModel:
        return CourseListResponseModel(items=self._read_courses().items)

    def upsert_course(self, course_id: str, title: str, description: str | None, standard_refs: list[StandardReferenceModel]) -> CourseModel:
        course_id = course_id.strip()
        if not course_id:
            raise BankWorkspaceError("Course id must not be empty.", status_code=400)
        if not title.strip():
            raise BankWorkspaceError("Course title must not be empty.", status_code=400)

        standards_by_id = {item.id for item in self._read_standard_records().items}
        for reference in standard_refs:
            if reference.standard_id not in standards_by_id:
                raise BankWorkspaceError(
                    f"Unknown standard reference: {reference.standard_id}",
                    status_code=422,
                )

        courses = self._read_courses()
        course = CourseModel(
            id=course_id,
            title=title.strip(),
            description=description,
            standard_refs=self._dedupe_standard_refs(standard_refs),
        )

        existing_index = next((index for index, item in enumerate(courses.items) if item.id == course_id), None)
        if existing_index is None:
            courses.items.append(course)
        else:
            courses.items[existing_index] = course

        courses.items.sort(key=lambda item: item.id)
        self._write_courses(courses)
        return course

    def seed_course_from(
        self,
        course_id: str,
        source_course_id: str,
        *,
        include_standards: bool = True,
        include_tests: bool = True,
    ) -> CourseDetailModel:
        """Pull a source course's standards and/or tests into `course_id`.

        Tests are associated, not copied: the source's tests gain `course_id` in
        their `course_ids` so a test written for last year's course still
        reports coverage for this year's. Forking a shared test into its own
        draft is `copy_test_draft`.
        """

        if course_id == source_course_id:
            raise BankWorkspaceError("A course cannot be seeded from itself.", status_code=400)

        courses = self._read_courses()
        target = next((item for item in courses.items if item.id == course_id), None)
        if target is None:
            raise BankWorkspaceError(f"Course not found: {course_id}", status_code=404)
        source = next((item for item in courses.items if item.id == source_course_id), None)
        if source is None:
            raise BankWorkspaceError(f"Course not found: {source_course_id}", status_code=404)

        if include_standards and source.standard_refs:
            target.standard_refs = self._dedupe_standard_refs(
                [*target.standard_refs, *source.standard_refs]
            )
            self._write_courses(courses)

        if include_tests:
            tests = self._read_tests()
            associated = False
            for test in tests.items:
                if source_course_id in test.course_ids and course_id not in test.course_ids:
                    test.course_ids.append(course_id)
                    associated = True
            if associated:
                self._write_tests(tests)

        return self.get_course_detail(course_id)

    def delete_course(self, course_id: str) -> None:
        courses = self._read_courses()
        remaining = [item for item in courses.items if item.id != course_id]
        if len(remaining) == len(courses.items):
            raise BankWorkspaceError(f"Course not found: {course_id}", status_code=404)

        courses.items = remaining
        self._write_courses(courses)

        # A deleted course must not linger as a dangling reference on its tests.
        tests = self._read_tests()
        tests_changed = False
        for test in tests.items:
            if course_id in test.course_ids:
                test.course_ids = [item for item in test.course_ids if item != course_id]
                tests_changed = True
        if tests_changed:
            self._write_tests(tests)

    def get_course_detail(self, course_id: str) -> CourseDetailModel:
        """Report how well a course's tests cover the standards it teaches.

        Splits the standards into three buckets: course standards the tests do
        cover, course standards nothing covers yet (the blind spots), and
        standards the tests address that the course never claimed -- writing and
        reading standards often show up this way.
        """
        course = self._require_course(course_id)
        standards_by_id = {item.id: item for item in self._read_standard_records().items}
        questions_by_id = {question.id: question for question in self._load_questions()}
        course_standard_ids = [reference.standard_id for reference in course.standard_refs]
        course_standard_id_set = set(course_standard_ids)

        # Versions of one test are one assessment given under different covers, so
        # coverage counts a lineage once. Grouping by title matches how "New
        # Version" builds them: same title, next version label.
        lineages: dict[str, list[TestDraftModel]] = {}
        for test in self._read_tests().items:
            if course_id not in test.course_ids:
                continue
            lineages.setdefault(test.title.strip().casefold(), []).append(test)

        question_counts: dict[str, int] = {}
        test_ids_by_standard: dict[str, list[str]] = {}
        test_summaries: list[CourseTestSummaryModel] = []
        total_question_count = 0

        for versions in lineages.values():
            versions.sort(key=lambda item: (item.version, item.id))
            primary = versions[0]

            lineage_standard_ids: set[str] = set()
            # Per standard, the most any single version asks -- not the total
            # across versions, which would multiply coverage by the version count.
            lineage_standard_counts: dict[str, int] = {}
            lineage_question_count = 0

            for test in versions:
                version_counts: dict[str, int] = {}
                version_question_count = 0
                for item in test.items:
                    if not isinstance(item, TestQuestionItemModel):
                        continue
                    question = questions_by_id.get(item.question_id)
                    if question is None:
                        continue
                    version_question_count += 1
                    for reference in question.standards:
                        version_counts[reference.standard_id] = (
                            version_counts.get(reference.standard_id, 0) + 1
                        )

                lineage_question_count = max(lineage_question_count, version_question_count)
                for standard_id, count in version_counts.items():
                    lineage_standard_counts[standard_id] = max(
                        lineage_standard_counts.get(standard_id, 0), count
                    )
                    lineage_standard_ids.add(standard_id)

            for standard_id, count in lineage_standard_counts.items():
                question_counts[standard_id] = question_counts.get(standard_id, 0) + count
                test_ids_by_standard.setdefault(standard_id, []).append(primary.id)

            total_question_count += lineage_question_count
            test_summaries.append(
                CourseTestSummaryModel(
                    test_id=primary.id,
                    title=primary.title,
                    version=primary.version,
                    versions=[item.version for item in versions],
                    test_ids=[item.id for item in versions],
                    question_count=lineage_question_count,
                    course_standard_count=len(lineage_standard_ids & course_standard_id_set),
                    extra_standard_count=len(lineage_standard_ids - course_standard_id_set),
                )
            )

        def build_coverage(standard_id: str, in_course: bool) -> CourseStandardCoverageModel:
            standard = standards_by_id.get(standard_id)
            test_ids = sorted(test_ids_by_standard.get(standard_id, []))
            return CourseStandardCoverageModel(
                standard_id=standard_id,
                code=standard.code if standard else None,
                statement=standard.statement if standard else None,
                source_list_id=standard.source_list_id if standard else None,
                strand=standard.strand if standard else None,
                in_course=in_course,
                question_count=question_counts.get(standard_id, 0),
                test_count=len(test_ids),
                test_ids=test_ids,
            )

        covered: list[CourseStandardCoverageModel] = []
        uncovered: list[CourseStandardCoverageModel] = []
        for standard_id in course_standard_ids:
            coverage = build_coverage(standard_id, in_course=True)
            (covered if coverage.question_count > 0 else uncovered).append(coverage)

        extra = [
            build_coverage(standard_id, in_course=False)
            for standard_id in sorted(set(question_counts) - course_standard_id_set)
        ]

        return CourseDetailModel(
            course=course,
            tests=sorted(test_summaries, key=lambda item: (item.title.lower(), item.version)),
            covered_standards=sorted(covered, key=lambda item: -item.question_count),
            uncovered_standards=uncovered,
            extra_standards=sorted(extra, key=lambda item: -item.question_count),
            question_count=total_question_count,
        )

    def set_test_courses(self, test_id: str, course_ids: list[str]) -> TestDraftDetailModel:
        tests = self._read_tests()
        test = next((item for item in tests.items if item.id == test_id), None)
        if test is None:
            raise BankWorkspaceError(f"Test draft not found: {test_id}", status_code=404)

        test.course_ids = self._validate_course_ids(course_ids)
        self._write_tests(tests)
        return self.get_test_draft(test.id)

    def _validate_course_ids(self, course_ids: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(item.strip() for item in course_ids if item.strip()))
        known_course_ids = {item.id for item in self._read_courses().items}
        unknown = [item for item in normalized if item not in known_course_ids]
        if unknown:
            raise BankWorkspaceError(
                f"Unknown course reference: {', '.join(sorted(unknown))}",
                status_code=422,
            )
        return normalized

    def import_standards(
        self,
        *,
        filename: str,
        content: bytes,
        source_list_id: str | None = None,
        title: str | None = None,
        issuer: str | None = None,
        subject: str | None = None,
        version: str | None = None,
        description: str | None = None,
    ) -> StandardImportResponseModel:
        """Import standards, keeping each one attached to the source it came from.

        A file that names a source per standard is split into one group per
        source. Anything the file leaves unattributed falls back to the source
        information supplied with the import, which is what the caller is asked
        for when inspection says the file cannot name a source for every row.
        """
        _, workspace_path = self.ensure_open()
        embedded_source_list, imported_rows, safe_name = self._read_standard_import_file(
            filename, content
        )

        groups = self._resolve_import_source_groups(
            rows=imported_rows,
            embedded_source_list=embedded_source_list,
            source_list_id=source_list_id,
            title=title,
            issuer=issuer,
            subject=subject,
            version=version,
            description=description,
        )

        source_lists = self._read_source_standard_lists()
        known_source_ids = {item.id for item in source_lists.items}
        records = self._read_standard_records()
        claimed_standard_ids = {item.id for item in records.items}

        imported_standards: list[StandardRecordModel] = []
        touched_sources: list[SourceStandardListModel] = []
        for source_list, rows in groups:
            group_records = self._build_standard_records(
                source_list=source_list,
                rows=rows,
                existing_standard_ids=claimed_standard_ids,
            )
            claimed_standard_ids.update(item.id for item in group_records)
            imported_standards.extend(group_records)
            touched_sources.append(source_list)
            if source_list.id not in known_source_ids:
                source_lists.items.append(source_list)
                known_source_ids.add(source_list.id)

        source_lists.items.sort(key=lambda item: item.id)
        records.items.extend(imported_standards)
        records.items.sort(key=lambda item: item.id)
        self._write_source_standard_lists(source_lists)
        self._write_standard_records(records)

        imported_path = self._store_import_file(
            workspace_path, touched_sources[0].id, safe_name, content
        )
        return StandardImportResponseModel(
            source_list=touched_sources[0],
            source_lists=touched_sources,
            imported_count=len(imported_standards),
            imported_path=imported_path,
        )

    def inspect_standard_import(
        self,
        *,
        filename: str,
        content: bytes,
    ) -> StandardImportInspectionModel:
        """Report what a standards file says about its own sources.

        The caller uses this to decide whether to ask for source information:
        it only needs to when the file cannot name a source for every standard.
        """
        self.ensure_open()
        embedded_source_list, rows, safe_name = self._read_standard_import_file(filename, content)
        existing_by_id = {item.id: item for item in self._read_source_standard_lists().items}

        detected: dict[str, DetectedImportSourceModel] = {}
        detected_order: list[str] = []
        detected_columns: list[str] = []
        rows_with_source = 0

        for row in rows:
            for key in row:
                column = str(key)
                if column not in detected_columns:
                    detected_columns.append(column)

            fields = self._extract_row_source(row)
            if not fields:
                continue

            rows_with_source += 1
            described = self._describe_detected_source(fields, existing_by_id)
            key = described.id or described.title or ""
            if key not in detected:
                detected[key] = described
                detected_order.append(key)
            detected[key].standard_count += 1

        # A top-level `source_list` covers whatever the rows did not claim, so it
        # is only worth reporting when some rows are still unattributed.
        embedded_described: DetectedImportSourceModel | None = None
        rows_without_source = len(rows) - rows_with_source
        if embedded_source_list and rows_without_source > 0:
            embedded_described = self._describe_detected_source(
                {
                    field: self._normalize_optional_text(embedded_source_list.get(field)) or ""
                    for field in ("id", "title", "issuer", "subject", "version", "description")
                },
                existing_by_id,
            )
            embedded_described.standard_count = rows_without_source
            key = embedded_described.id or embedded_described.title or ""
            if key not in detected:
                detected[key] = embedded_described
                detected_order.append(key)

        file_covers_every_row = rows_without_source == 0 or bool(
            embedded_described and embedded_described.complete
        )
        return StandardImportInspectionModel(
            filename=safe_name,
            total_rows=len(rows),
            rows_with_source=rows_with_source,
            detected_sources=[detected[key] for key in detected_order],
            needs_source_input=not (bool(rows) and file_covers_every_row),
            detected_columns=detected_columns,
        )

    def create_standards_manually(
        self,
        request: CreateStandardsManuallyRequest,
    ) -> StandardImportResponseModel:
        self.ensure_open()
        if not request.standards:
            raise BankWorkspaceError(
                "Add at least one standard row before saving.",
                status_code=422,
            )

        source_lists = self._read_source_standard_lists()
        existing_by_id = {item.id: item for item in source_lists.items}

        # Each row may pick its own source; rows that do not fall back to the
        # source described on the request itself.
        batch_source: SourceStandardListModel | None = None

        def resolve_batch_source() -> SourceStandardListModel:
            nonlocal batch_source
            if batch_source is None:
                requested_id = self._normalize_optional_text(request.source_list_id)
                batch_source = existing_by_id.get(requested_id or "") or self._build_source_standard_list(
                    embedded_source_list=None,
                    source_list_id=request.source_list_id,
                    title=request.title,
                    issuer=request.issuer,
                    subject=request.subject,
                    version=request.version,
                    description=request.description,
                )
            return batch_source

        grouped_sources: dict[str, SourceStandardListModel] = {}
        grouped_rows: dict[str, list[dict[str, object]]] = {}
        group_order: list[str] = []
        for row in request.standards:
            source = self._resolve_manual_row_source(row, existing_by_id) or resolve_batch_source()
            if source.id not in grouped_sources:
                grouped_sources[source.id] = source
                grouped_rows[source.id] = []
                group_order.append(source.id)
            grouped_rows[source.id].append(row.model_dump())

        records = self._read_standard_records()
        claimed_standard_ids = {item.id for item in records.items}
        new_standards: list[StandardRecordModel] = []
        touched_sources: list[SourceStandardListModel] = []
        for source_id in group_order:
            source_list = grouped_sources[source_id]
            group_records = self._build_standard_records(
                source_list=source_list,
                rows=grouped_rows[source_id],
                existing_standard_ids=claimed_standard_ids,
            )
            claimed_standard_ids.update(item.id for item in group_records)
            new_standards.extend(group_records)
            touched_sources.append(source_list)

        added_source_lists = [
            source for source in touched_sources if source.id not in existing_by_id
        ]
        records.items.extend(new_standards)
        records.items.sort(key=lambda item: item.id)
        if added_source_lists:
            source_lists.items.extend(added_source_lists)
            source_lists.items.sort(key=lambda item: item.id)
            self._write_source_standard_lists(source_lists)
        self._write_standard_records(records)

        return StandardImportResponseModel(
            source_list=touched_sources[0],
            source_lists=touched_sources,
            imported_count=len(new_standards),
            imported_path=None,
        )

    def _resolve_manual_row_source(
        self,
        row: ManualStandardRowModel,
        existing_by_id: dict[str, SourceStandardListModel],
    ) -> SourceStandardListModel | None:
        """Resolve the source a hand-entered standard names, if it names one."""
        requested_id = self._normalize_optional_text(row.source_list_id)
        title = self._normalize_optional_text(row.source_title)
        if not requested_id and not title:
            return None

        existing = existing_by_id.get(requested_id or "")
        if existing is not None and not title:
            return existing

        source_id = requested_id or self._slugify_source_id(title or "")
        existing = existing or existing_by_id.get(source_id)
        if existing is not None:
            return existing

        return self._build_source_standard_list(
            embedded_source_list=None,
            source_list_id=source_id,
            title=title,
            issuer=row.source_issuer,
            subject=row.source_subject,
            version=row.source_version,
            description=row.source_description,
        )

    def update_standard_record(
        self,
        current_standard_id: str,
        payload: StandardRecordModel,
    ) -> StandardRecordModel:
        _, workspace_path = self.ensure_open()
        current_standard_id = current_standard_id.strip()
        if not current_standard_id:
            raise BankWorkspaceError("Standard id must not be empty.", status_code=400)

        next_record = StandardRecordModel(
            id=payload.id.strip(),
            source_list_id=payload.source_list_id.strip(),
            code=payload.code.strip(),
            statement=payload.statement.strip(),
            subject=self._normalize_optional_text(payload.subject),
            strand=self._normalize_optional_text(payload.strand),
            grade_band=self._normalize_optional_text(payload.grade_band),
            tags=self._normalize_tags(payload.tags),
        )
        if not next_record.id:
            raise BankWorkspaceError("Standard id must not be empty.", status_code=400)
        if not next_record.source_list_id:
            raise BankWorkspaceError("Source list id must not be empty.", status_code=400)
        if not next_record.code:
            raise BankWorkspaceError("Standard short name must not be empty.", status_code=400)
        if not next_record.statement:
            raise BankWorkspaceError("Standard text must not be empty.", status_code=400)

        if next_record.source_list_id not in {item.id for item in self._read_source_standard_lists().items}:
            raise BankWorkspaceError(
                f"Unknown standards source list: {next_record.source_list_id}",
                status_code=422,
            )

        records = self._read_standard_records()
        existing_index = next(
            (index for index, item in enumerate(records.items) if item.id == current_standard_id),
            None,
        )
        if existing_index is None:
            raise BankWorkspaceError(f"Standard not found: {current_standard_id}", status_code=404)

        if next_record.id != current_standard_id and any(item.id == next_record.id for item in records.items):
            raise BankWorkspaceError(
                f"A standard with id {next_record.id} already exists.",
                status_code=409,
            )

        previous_source_list_id = records.items[existing_index].source_list_id
        records.items[existing_index] = next_record
        records.items.sort(key=lambda item: item.id)
        self._write_standard_records(records)

        # Sources exist to describe standards. Moving the last standard out of a
        # source leaves nothing to describe, so the source goes with it.
        if previous_source_list_id != next_record.source_list_id:
            self._prune_empty_source_lists(records)

        if next_record.id != current_standard_id:
            self._replace_standard_references(
                workspace_path,
                old_standard_id=current_standard_id,
                new_standard_id=next_record.id,
            )

        return next_record

    def create_standard_placeholders(self, standard_ids: list[str]) -> StandardSearchResponseModel:
        source_lists = self._read_source_standard_lists()
        records = self._read_standard_records()
        existing_standard_ids = {item.id for item in records.items}
        requested_standard_ids = sorted(
            {
                standard_id.strip()
                for standard_id in standard_ids
                if isinstance(standard_id, str) and standard_id.strip()
            }
        )
        missing_standard_ids = [
            standard_id for standard_id in requested_standard_ids if standard_id not in existing_standard_ids
        ]
        if not missing_standard_ids:
            return StandardSearchResponseModel(
                items=[item for item in records.items if item.id in requested_standard_ids]
            )

        placeholder_source_id = "unresolved-question-standards"
        if not any(item.id == placeholder_source_id for item in source_lists.items):
            source_lists.items.append(
                SourceStandardListModel(
                    id=placeholder_source_id,
                    title="Unresolved Question Standards",
                    issuer="Nexzam",
                    subject=None,
                    version=None,
                    description=(
                        "Placeholder standards created for question or course references "
                        "that were present in the bank but missing from standards/records.json."
                    ),
                    imported_at=datetime.now(UTC),
                )
            )

        for standard_id in missing_standard_ids:
            records.items.append(
                StandardRecordModel(
                    id=standard_id,
                    source_list_id=placeholder_source_id,
                    code=standard_id,
                    statement=(
                        "Placeholder for an imported or referenced standard. "
                        "Review this record and replace it with the official standard text."
                    ),
                    tags=["placeholder", "needs-review"],
                )
            )

        source_lists.items.sort(key=lambda item: item.id)
        records.items.sort(key=lambda item: item.id)
        self._write_source_standard_lists(source_lists)
        self._write_standard_records(records)
        return StandardSearchResponseModel(
            items=[item for item in records.items if item.id in requested_standard_ids]
        )

    def stage_question_import(self, *, filename: str, content: bytes) -> QuestionImportStageModel:
        _, workspace_path = self.ensure_open()
        safe_name = Path(filename or "").name
        suffix = Path(safe_name).suffix.lower()
        if suffix not in {".json", ".csv"}:
            raise BankWorkspaceError(
                "Question import staging supports JSON and CSV files.",
                status_code=400,
            )

        try:
            raw_text = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise BankWorkspaceError(f"Could not decode import file as UTF-8: {exc}", status_code=400)

        if suffix == ".json":
            imported_rows = [
                (item, item, [])
                for item in self._parse_json_question_import(raw_text)
            ]
        else:
            imported_rows = self._parse_csv_question_import(raw_text)

        import_id = self._build_question_import_id()
        import_dir = workspace_path / "imports" / import_id
        import_dir.mkdir(parents=True, exist_ok=False)

        source_filename = safe_name or "questions.json"
        source_file_path = import_dir / source_filename
        source_file_path.write_bytes(content)
        source_path = f"imports/{import_id}/{source_filename}"

        stage = self._build_question_import_stage(
            import_id=import_id,
            source_filename=source_filename,
            source_path=source_path,
            imported_rows=imported_rows,
        )
        (import_dir / "stage.json").write_text(stage.model_dump_json(indent=2) + "\n")
        return stage

    def list_question_imports(self) -> QuestionImportListResponseModel:
        _, workspace_path = self.ensure_open()
        imports_dir = workspace_path / "imports"
        stages = [
            QuestionImportStageModel.model_validate_json(path.read_text())
            for path in sorted(imports_dir.glob("*/stage.json"))
        ]
        return QuestionImportListResponseModel(items=stages)

    def get_question_import(self, import_id: str) -> QuestionImportStageModel:
        stage_path = self._question_import_stage_path(import_id)
        if not stage_path.exists():
            raise BankWorkspaceError(f"Question import not found: {import_id}", status_code=404)
        return QuestionImportStageModel.model_validate_json(stage_path.read_text())

    def update_question_import_row(
        self,
        import_id: str,
        row_id: str,
        *,
        question: dict[str, object],
        selected: bool | None = None,
    ) -> QuestionImportStageModel:
        if not isinstance(question, dict):
            raise BankWorkspaceError("Staged question row updates require a question object.", status_code=400)

        stage_path = self._question_import_stage_path(import_id)
        if not stage_path.exists():
            raise BankWorkspaceError(f"Question import not found: {import_id}", status_code=404)

        stage = QuestionImportStageModel.model_validate_json(stage_path.read_text())
        row = next((item for item in stage.rows if item.row_id == row_id), None)
        if row is None:
            raise BankWorkspaceError(f"Question import row not found: {row_id}", status_code=404)
        if row.status == "promoted":
            raise BankWorkspaceError("Promoted import rows cannot be edited.", status_code=409)

        row.question = dict(question)
        row.imported_id = self._normalize_optional_text(row.question.get("id"))
        row.promoted_question_id = None
        self._refresh_staged_row_validation(stage, row, selected)
        stage_path.write_text(stage.model_dump_json(indent=2) + "\n")
        return stage

    def promote_question_import_rows(
        self,
        import_id: str,
        *,
        row_ids: list[str] | None = None,
        id_policy: str = "auto",
    ) -> QuestionImportPromoteResponseModel:
        _, workspace_path = self.ensure_open()
        if id_policy not in {"auto", "keep_imported"}:
            raise BankWorkspaceError("Question import id_policy must be auto or keep_imported.", status_code=400)

        stage_path = self._question_import_stage_path(import_id)
        if not stage_path.exists():
            raise BankWorkspaceError(f"Question import not found: {import_id}", status_code=404)

        stage = QuestionImportStageModel.model_validate_json(stage_path.read_text())
        requested_row_ids = set(row_ids) if row_ids is not None else None
        rows_to_promote = [
            row
            for row in stage.rows
            if row.status == "valid"
            and (row.row_id in requested_row_ids if requested_row_ids is not None else row.selected)
        ]

        if requested_row_ids is not None:
            known_row_ids = {row.row_id for row in stage.rows}
            missing = sorted(requested_row_ids - known_row_ids)
            if missing:
                raise BankWorkspaceError(
                    f"Question import rows not found: {', '.join(missing)}",
                    status_code=404,
                )

            blocked = [
                row.row_id
                for row in stage.rows
                if row.row_id in requested_row_ids and row.status != "valid"
            ]
            if blocked:
                raise BankWorkspaceError(
                    f"Only valid staged rows can be promoted: {', '.join(blocked)}",
                    status_code=422,
                )

        if id_policy == "keep_imported":
            self._validate_keep_imported_question_ids(rows_to_promote)

        promoted_question_ids: list[str] = []
        questions_dir = workspace_path / "questions"
        for row in rows_to_promote:
            question_id = self._resolve_promoted_question_id(row, id_policy)
            question_path = questions_dir / f"{question_id}.json"
            if question_path.exists():
                raise BankWorkspaceError(
                    f"A question with id {question_id} already exists.",
                    status_code=409,
                )

            payload = dict(row.question)
            payload["id"] = question_id
            question = QuestionModel.model_validate(payload)
            question_path.write_text(question.model_dump_json(indent=2) + "\n")
            row.status = "promoted"
            row.selected = False
            row.promoted_question_id = question.id
            promoted_question_ids.append(question.id)

        stage_path.write_text(stage.model_dump_json(indent=2) + "\n")
        if promoted_question_ids:
            self._refresh_bank_index()

        return QuestionImportPromoteResponseModel(
            import_id=stage.id,
            promoted_count=len(promoted_question_ids),
            promoted_question_ids=promoted_question_ids,
            stage=stage,
        )

    def list_test_drafts(self) -> TestDraftListResponseModel:
        tests = self._read_tests()
        questions_by_id = {question.id: question for question in self._load_questions()}
        return TestDraftListResponseModel(
            items=[self._build_test_detail(test, questions_by_id) for test in tests.items]
        )

    def get_test_draft(self, test_id: str) -> TestDraftDetailModel:
        tests = self._read_tests()
        test = next((item for item in tests.items if item.id == test_id), None)
        if test is None:
            raise BankWorkspaceError(f"Test draft not found: {test_id}", status_code=404)
        questions_by_id = {question.id: question for question in self._load_questions()}
        return self._build_test_detail(test, questions_by_id)

    def create_test_draft(
        self,
        title: str,
        version: str = "A",
        course_ids: list[str] | None = None,
    ) -> TestDraftDetailModel:
        tests = self._read_tests()
        test = TestDraftModel(
            id=self._next_test_draft_id(),
            title=title,
            version=version,
            course_ids=self._validate_course_ids(course_ids or []),
        )
        tests.items.append(test)
        self._write_tests(tests)
        return self.get_test_draft(test.id)

    def update_test_draft(self, test_id: str, payload: TestDraftModel) -> TestDraftDetailModel:
        tests = self._read_tests()
        existing_index = next((index for index, item in enumerate(tests.items) if item.id == test_id), None)
        if existing_index is None:
            raise BankWorkspaceError(f"Test draft not found: {test_id}", status_code=404)

        if payload.id != test_id and any(item.id == payload.id for item in tests.items):
            raise BankWorkspaceError(
                f"A test draft with id {payload.id} already exists.",
                status_code=409,
            )

        self._validate_test_question_references(payload)
        payload.course_ids = self._validate_course_ids(payload.course_ids)
        tests.items[existing_index] = payload
        tests.items.sort(key=lambda item: item.id)
        self._write_tests(tests)
        return self.get_test_draft(payload.id)

    def copy_test_draft(
        self,
        test_id: str,
        *,
        title: str | None = None,
        version: str | None = None,
        course_ids: list[str] | None = None,
        detach_courses_from_source: bool = False,
        source_restore: TestDraftModel | None = None,
    ) -> TestDraftDetailModel:
        """Fork `test_id` into a new draft that carries its current contents.

        Edits autosave straight into the working copy, so a test shared by two
        courses is already changed for both by the time the teacher decides they
        wanted a separate version. `source_restore` is the snapshot taken when
        the test was opened: pass it to put the original back the way the other
        courses had it while the copy keeps the edits.
        """

        tests = self._read_tests()
        index = next((i for i, item in enumerate(tests.items) if item.id == test_id), None)
        if index is None:
            raise BankWorkspaceError(f"Test draft not found: {test_id}", status_code=404)

        source = tests.items[index]
        copy = source.model_copy(deep=True)
        copy.id = self._next_test_draft_id()
        copy.title = (title or source.title).strip() or source.title
        copy.version = (version or source.version).strip() or source.version
        copy.course_ids = self._validate_course_ids(
            list(source.course_ids) if course_ids is None else course_ids
        )
        # The copy is a new lineage; results recorded against the original
        # administration stay with the original.
        copy.performance_runs = []

        if source_restore is not None:
            self._validate_test_question_references(source_restore)
            restored = source_restore.model_copy(deep=True)
            restored.id = source.id
            restored.course_ids = self._validate_course_ids(restored.course_ids)
            tests.items[index] = restored
            source = restored

        if detach_courses_from_source:
            source.course_ids = [
                item for item in source.course_ids if item not in copy.course_ids
            ]

        tests.items.append(copy)
        tests.items.sort(key=lambda item: item.id)
        self._write_tests(tests)
        return self.get_test_draft(copy.id)

    def add_question_to_test(
        self,
        test_id: str,
        question_id: str,
        *,
        experimental: bool = False,
    ) -> TestDraftDetailModel:
        tests = self._read_tests()
        test = next((item for item in tests.items if item.id == test_id), None)
        if test is None:
            raise BankWorkspaceError(f"Test draft not found: {test_id}", status_code=404)
        self.get_question(question_id)

        test.items.append(
            TestQuestionItemModel(
                question_id=question_id,
                experimental=experimental,
            )
        )
        self._write_tests(tests)
        return self.get_test_draft(test.id)

    def _validate_keep_imported_question_ids(self, rows: list[QuestionImportRowModel]) -> None:
        existing_question_ids = {question.id for question in self._load_questions()}
        imported_ids: dict[str, list[str]] = {}
        missing_row_ids: list[str] = []

        for row in rows:
            if not row.imported_id:
                missing_row_ids.append(row.row_id)
                continue
            imported_ids.setdefault(row.imported_id, []).append(row.row_id)

        if missing_row_ids:
            raise BankWorkspaceError(
                f"Keep Imported IDs requires imported ids for: {', '.join(missing_row_ids)}",
                status_code=422,
            )

        existing_conflicts = sorted(
            imported_id for imported_id in imported_ids if imported_id in existing_question_ids
        )
        if existing_conflicts:
            raise BankWorkspaceError(
                f"Imported ids already exist in this bank: {', '.join(existing_conflicts)}",
                status_code=409,
            )

        duplicate_imported_ids = sorted(
            imported_id for imported_id, row_ids in imported_ids.items() if len(row_ids) > 1
        )
        if duplicate_imported_ids:
            raise BankWorkspaceError(
                f"Imported ids must be unique to keep them: {', '.join(duplicate_imported_ids)}",
                status_code=422,
            )

    def attach_standard_to_course(self, course_id: str, standard_id: str) -> CourseModel:
        course = self._require_course(course_id)
        if standard_id not in {item.id for item in self._read_standard_records().items}:
            raise BankWorkspaceError(f"Unknown standard reference: {standard_id}", status_code=422)
        refs = self._dedupe_standard_refs([*course.standard_refs, StandardReferenceModel(standard_id=standard_id)])
        return self.upsert_course(course.id, course.title, course.description, refs)

    def detach_standard_from_course(self, course_id: str, standard_id: str) -> CourseModel:
        course = self._require_course(course_id)
        refs = [reference for reference in course.standard_refs if reference.standard_id != standard_id]
        return self.upsert_course(course.id, course.title, course.description, refs)

    def list_assets(self) -> AssetListResponseModel:
        _, workspace_path = self.ensure_open()
        questions = self._load_questions()
        referenced_by_path: dict[str, list[str]] = {}
        for question in questions:
            for asset in question.assets:
                referenced_by_path.setdefault(asset.path, []).append(question.id)

        assets_dir = workspace_path / "assets"
        if not assets_dir.exists():
            return AssetListResponseModel(items=[])

        items: list[AssetListItemModel] = []
        for file_path in sorted(path for path in assets_dir.rglob("*") if path.is_file()):
            relative_path = f"assets/{file_path.relative_to(assets_dir).as_posix()}"
            kind = self.ALLOWED_ASSET_EXTENSIONS.get(file_path.suffix.lower(), "file")
            svg_placeholders: list[str] = []
            if kind == "svg":
                svg_placeholders = self.extract_svg_placeholders(file_path.read_text())

            items.append(
                AssetListItemModel(
                    path=relative_path,
                    kind=kind,
                    referenced_by=sorted(referenced_by_path.get(relative_path, [])),
                    svg_placeholders=svg_placeholders,
                )
            )

        return AssetListResponseModel(items=items)

    def list_questions(
        self,
        search: str | None = None,
        topic: str | None = None,
        question_type: str | None = None,
    ) -> QuestionListResponseModel:
        questions = self._load_questions()
        filtered: list[QuestionModel] = []
        lowered_search = (search or "").strip().lower()

        for question in questions:
            if topic and question.topic != topic:
                continue
            if question_type and question.type != question_type:
                continue
            if lowered_search:
                haystack = " ".join(
                    [
                        question.id,
                        question.topic,
                        question.subtopic or "",
                        question.prompt,
                        " ".join(question.tags),
                    ]
                ).lower()
                if lowered_search not in haystack:
                    continue
            filtered.append(question)

        items = [
            QuestionListItemModel(
                id=question.id,
                topic=question.topic,
                type=question.type,
                difficulty=question.difficulty,
                status=question.status,
                prompt=question.prompt,
                choice_preview=self._build_question_choice_preview(question),
                subtopic=question.subtopic,
                standards=question.standards,
            )
            for question in filtered
        ]
        available_topics = sorted({question.topic for question in questions})
        available_types = sorted({question.type for question in questions})
        return QuestionListResponseModel(
            items=items,
            available_topics=available_topics,
            available_types=available_types,
        )

    def get_question(self, question_id: str) -> QuestionModel:
        question_path = self._question_path(question_id)
        if not question_path.exists():
            raise BankWorkspaceError(f"Question not found: {question_id}", status_code=404)
        return QuestionModel.model_validate_json(question_path.read_text())

    def update_question(self, current_id: str, payload: QuestionModel) -> QuestionModel:
        _, workspace_path = self.ensure_open()
        current_path = self._question_path(current_id)
        if not current_path.exists():
            raise BankWorkspaceError(f"Question not found: {current_id}", status_code=404)

        next_path = workspace_path / "questions" / f"{payload.id}.json"
        if payload.id != current_id and next_path.exists():
            raise BankWorkspaceError(
                f"A question with id {payload.id} already exists.",
                status_code=409,
            )

        current_path.write_text(payload.model_dump_json(indent=2) + "\n")

        if payload.id != current_id:
            current_path.rename(next_path)

        self._refresh_bank_index()
        return payload

    def create_question(self, template_question_id: str | None = None) -> QuestionModel:
        _, workspace_path = self.ensure_open()

        if template_question_id:
            template = self.get_question(template_question_id)
            payload = template.model_copy(deep=True)
            payload.id = self._next_duplicate_question_id(template.id)
        else:
            payload = self._build_blank_question()

        question_path = workspace_path / "questions" / f"{payload.id}.json"
        question_path.write_text(payload.model_dump_json(indent=2) + "\n")
        self._refresh_bank_index()
        return payload

    def create_question_from_json(self, payload: dict[str, object]) -> QuestionModel:
        _, workspace_path = self.ensure_open()
        if not isinstance(payload, dict):
            raise BankWorkspaceError("Question JSON must be an object.", status_code=400)

        next_payload = dict(payload)
        next_payload["id"] = self._next_question_id_for_type(next_payload.get("type"))
        question = QuestionModel.model_validate(next_payload)

        question_path = workspace_path / "questions" / f"{question.id}.json"
        question_path.write_text(question.model_dump_json(indent=2) + "\n")
        self._refresh_bank_index()
        return question

    def create_questions_from_json(
        self,
        payloads: list[dict[str, object]],
    ) -> list[QuestionModel]:
        """Create many questions in one pass.

        Ids are assigned across the whole batch before anything is written, and
        nothing is written until every payload validates -- a bad row in a large
        paste should not leave a half-imported bank behind. The bank index is
        refreshed once instead of once per question.
        """
        _, workspace_path = self.ensure_open()
        if not payloads:
            raise BankWorkspaceError(
                "Provide at least one question to create.",
                status_code=422,
            )

        reserved_ids: set[str] = set()
        questions: list[QuestionModel] = []
        for index, payload in enumerate(payloads):
            if not isinstance(payload, dict):
                raise BankWorkspaceError(
                    f"Question {index + 1} must be a JSON object.",
                    status_code=400,
                )

            next_payload = dict(payload)
            next_payload["id"] = self._next_question_id_for_type_with_reserved(
                next_payload.get("type"),
                reserved_ids,
            )
            try:
                question = QuestionModel.model_validate(next_payload)
            except ValidationError as error:
                detail = error.errors()[0].get("msg", "invalid question") if error.errors() else "invalid question"
                raise BankWorkspaceError(
                    f"Question {index + 1} is not valid: {detail}",
                    status_code=422,
                ) from error

            reserved_ids.add(question.id)
            questions.append(question)

        for question in questions:
            question_path = workspace_path / "questions" / f"{question.id}.json"
            question_path.write_text(question.model_dump_json(indent=2) + "\n")

        self._refresh_bank_index()
        return questions

    def next_question_id(self, question_type: QuestionType) -> str:
        self.ensure_open()
        return self._next_question_id_for_type(question_type)

    def delete_question(self, question_id: str) -> None:
        question_path = self._question_path(question_id)
        if not question_path.exists():
            raise BankWorkspaceError(f"Question not found: {question_id}", status_code=404)
        question_path.unlink()
        self._refresh_bank_index()

    def save_bank(self, destination_path: str | None = None) -> str:
        source_path, workspace_path = self.ensure_open()
        target_path = Path(destination_path).expanduser().resolve() if destination_path else source_path
        if target_path.suffix != ".bok":
            raise BankWorkspaceError("Destination path must end with .bok", status_code=400)

        self._refresh_manifest_timestamp()
        self._refresh_bank_index()

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

    def upload_asset(self, filename: str, content: bytes) -> AssetUploadResponseModel:
        _, workspace_path = self.ensure_open()
        safe_name = Path(filename or "").name
        if not safe_name:
            raise BankWorkspaceError("Uploaded asset must include a filename.", status_code=400)

        suffix = Path(safe_name).suffix.lower()
        kind = self.ALLOWED_ASSET_EXTENSIONS.get(suffix)
        if kind is None:
            allowed = ", ".join(sorted(self.ALLOWED_ASSET_EXTENSIONS))
            raise BankWorkspaceError(
                f"Unsupported asset type {suffix or '[no extension]'}. Allowed types: {allowed}",
                status_code=400,
            )

        assets_dir = workspace_path / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        target_name = self._dedupe_asset_name(assets_dir, safe_name)
        target_path = assets_dir / target_name
        target_path.write_bytes(content)

        return AssetUploadResponseModel(path=f"assets/{target_name}", kind=kind)

    def inspect_asset(self, payload: AssetInspectionRequest) -> AssetInspectionResponseModel:
        asset_path = self.resolve_asset_path(payload.path)
        if payload.kind != "svg":
            return AssetInspectionResponseModel(path=payload.path, kind=payload.kind)

        source = asset_path.read_text()
        placeholders = self.extract_svg_placeholders(source)
        rendered_svg = self.render_svg(source, payload.svg_variables)
        return AssetInspectionResponseModel(
            path=payload.path,
            kind=payload.kind,
            svg_placeholders=placeholders,
            rendered_svg=rendered_svg,
        )

    def inspect_assets(
        self,
        payloads: list[AssetInspectionRequest],
    ) -> AssetInspectionBatchResponseModel:
        """Render several assets in one call.

        A printable test can reference many assets, and a templated SVG only
        resolves its {{tokens}} on the server, so the print preview needs the
        rendered markup for all of them before it can lay the page out.
        """
        return AssetInspectionBatchResponseModel(
            items=[self.inspect_asset(payload) for payload in payloads]
        )

    def resolve_asset_path(self, relative_path: str) -> Path:
        _, workspace_path = self.ensure_open()
        workspace_path = workspace_path.resolve()
        if not relative_path.startswith("assets/"):
            raise BankWorkspaceError("Asset path must live under the assets/ directory.", status_code=400)
        asset_path = (workspace_path / relative_path).resolve()
        try:
            asset_path.relative_to(workspace_path)
        except ValueError:
            raise BankWorkspaceError("Asset path must stay inside the open workspace.", status_code=400)
        if not asset_path.exists() or not asset_path.is_file():
            raise BankWorkspaceError(f"Asset not found: {relative_path}", status_code=404)
        return asset_path

    def get_asset_media_type(self, relative_path: str) -> str:
        asset_path = self.resolve_asset_path(relative_path)
        guessed, _ = guess_type(asset_path.name)
        return guessed or "application/octet-stream"

    def _read_manifest(self) -> ManifestModel:
        _, workspace_path = self.ensure_open()
        return ManifestModel.model_validate_json((workspace_path / "manifest.json").read_text())

    def _read_bank_index(self) -> BankIndexModel:
        _, workspace_path = self.ensure_open()
        return BankIndexModel.model_validate_json((workspace_path / "bank.json").read_text())

    def _read_source_standard_lists(self) -> SourceStandardListCollectionModel:
        _, workspace_path = self.ensure_open()
        return SourceStandardListCollectionModel.model_validate_json(
            (workspace_path / "standards" / "source_lists.json").read_text()
        )

    def _read_standard_records(self) -> StandardRecordCollectionModel:
        _, workspace_path = self.ensure_open()
        return StandardRecordCollectionModel.model_validate_json(
            (workspace_path / "standards" / "records.json").read_text()
        )

    def _write_source_standard_lists(self, payload: SourceStandardListCollectionModel) -> None:
        _, workspace_path = self.ensure_open()
        (workspace_path / "standards" / "source_lists.json").write_text(
            payload.model_dump_json(indent=2) + "\n"
        )

    def _write_standard_records(self, payload: StandardRecordCollectionModel) -> None:
        _, workspace_path = self.ensure_open()
        (workspace_path / "standards" / "records.json").write_text(
            payload.model_dump_json(indent=2) + "\n"
        )

    def _read_courses(self) -> CourseCollectionModel:
        _, workspace_path = self.ensure_open()
        return CourseCollectionModel.model_validate_json(
            (workspace_path / "courses" / "courses.json").read_text()
        )

    def _write_courses(self, payload: CourseCollectionModel) -> None:
        _, workspace_path = self.ensure_open()
        (workspace_path / "courses" / "courses.json").write_text(payload.model_dump_json(indent=2) + "\n")

    def _replace_standard_references(
        self,
        workspace_path: Path,
        *,
        old_standard_id: str,
        new_standard_id: str,
    ) -> None:
        courses = self._read_courses()
        courses_changed = False
        for course in courses.items:
            if not any(reference.standard_id == old_standard_id for reference in course.standard_refs):
                continue
            course.standard_refs = self._dedupe_standard_refs(
                [
                    StandardReferenceModel(
                        standard_id=new_standard_id
                        if reference.standard_id == old_standard_id
                        else reference.standard_id
                    )
                    for reference in course.standard_refs
                ]
            )
            courses_changed = True

        if courses_changed:
            self._write_courses(courses)

        questions_dir = workspace_path / "questions"
        for question_path in sorted(questions_dir.glob("*.json")):
            question = QuestionModel.model_validate_json(question_path.read_text())
            if not any(reference.standard_id == old_standard_id for reference in question.standards):
                continue
            question.standards = self._dedupe_standard_refs(
                [
                    StandardReferenceModel(
                        standard_id=new_standard_id
                        if reference.standard_id == old_standard_id
                        else reference.standard_id
                    )
                    for reference in question.standards
                ]
            )
            question_path.write_text(question.model_dump_json(indent=2) + "\n")

    def _read_tests(self) -> TestDraftCollectionModel:
        _, workspace_path = self.ensure_open()
        return TestDraftCollectionModel.model_validate_json(
            (workspace_path / "tests" / "tests.json").read_text()
        )

    def _write_tests(self, payload: TestDraftCollectionModel) -> None:
        _, workspace_path = self.ensure_open()
        (workspace_path / "tests" / "tests.json").write_text(payload.model_dump_json(indent=2) + "\n")

    def _build_test_detail(
        self,
        test: TestDraftModel,
        questions_by_id: dict[str, QuestionModel],
    ) -> TestDraftDetailModel:
        questions = [
            questions_by_id[item.question_id]
            for item in test.items
            if isinstance(item, TestQuestionItemModel) and item.question_id in questions_by_id
        ]
        return TestDraftDetailModel(
            test=test,
            summary=self._build_test_summary(test, questions_by_id),
            questions=questions,
        )

    def _build_question_choice_preview(self, question: QuestionModel) -> list[str]:
        if question.type != "multiple_choice":
            return []
        choices = (question.answer or {}).get("choices")
        if not isinstance(choices, list):
            return []
        return [str(choice) for choice in choices if isinstance(choice, str)]

    def _build_test_summary(
        self,
        test: TestDraftModel,
        questions_by_id: dict[str, QuestionModel],
    ) -> TestDraftSummaryModel:
        question_type_counts: dict[str, int] = {}
        difficulty_counts: dict[str, int] = {}
        standard_ids: set[str] = set()
        total_time_estimate_sec = 0
        difficulties: list[int] = []
        standard_difficulties: dict[str, list[int]] = {}
        standard_times: dict[str, int] = {}
        standard_difficulty_counts: dict[str, dict[str, int]] = {}

        for item in test.items:
            if isinstance(item, TestSectionItemModel):
                continue
            question = questions_by_id.get(item.question_id)
            if question is None:
                continue

            question_type_counts[question.type] = question_type_counts.get(question.type, 0) + 1
            difficulty_key = str(question.difficulty)
            difficulty_counts[difficulty_key] = difficulty_counts.get(difficulty_key, 0) + 1
            difficulties.append(question.difficulty)
            total_time_estimate_sec += question.estimated_time_sec or 0

            for reference in question.standards:
                standard_ids.add(reference.standard_id)
                standard_difficulties.setdefault(reference.standard_id, []).append(question.difficulty)
                standard_times[reference.standard_id] = (
                    standard_times.get(reference.standard_id, 0) + (question.estimated_time_sec or 0)
                )
                counts = standard_difficulty_counts.setdefault(reference.standard_id, {})
                counts[difficulty_key] = counts.get(difficulty_key, 0) + 1

        standard_balance = [
            TestStandardBalanceModel(
                standard_id=standard_id,
                question_count=len(standard_difficulties[standard_id]),
                average_difficulty=round(
                    sum(standard_difficulties[standard_id])
                    / len(standard_difficulties[standard_id]),
                    2,
                ),
                total_time_estimate_sec=standard_times.get(standard_id, 0),
                difficulty_counts=standard_difficulty_counts.get(standard_id, {}),
            )
            for standard_id in sorted(standard_ids)
        ]

        return TestDraftSummaryModel(
            id=test.id,
            title=test.title,
            version=test.version,
            course_ids=list(test.course_ids),
            standard_ids=sorted(standard_ids),
            question_type_counts=dict(sorted(question_type_counts.items())),
            difficulty_counts=dict(sorted(difficulty_counts.items())),
            average_difficulty=round(sum(difficulties) / len(difficulties), 2)
            if difficulties
            else None,
            total_time_estimate_sec=total_time_estimate_sec,
            standard_balance=standard_balance,
        )

    def _validate_test_question_references(self, test: TestDraftModel) -> None:
        question_ids = {question.id for question in self._load_questions()}
        missing_ids = sorted(
            {
                item.question_id
                for item in test.items
                if isinstance(item, TestQuestionItemModel) and item.question_id not in question_ids
            }
        )
        if missing_ids:
            raise BankWorkspaceError(
                f"Test draft references unknown questions: {', '.join(missing_ids)}",
                status_code=422,
            )

    def _load_questions(self) -> list[QuestionModel]:
        _, workspace_path = self.ensure_open()
        questions_dir = workspace_path / "questions"
        questions = [
            QuestionModel.model_validate_json(path.read_text())
            for path in sorted(questions_dir.glob("*.json"))
        ]
        return sorted(questions, key=lambda item: item.id)

    def _refresh_manifest_timestamp(self) -> None:
        _, workspace_path = self.ensure_open()
        manifest = self._read_manifest()
        manifest.updated_at = datetime.now(UTC)
        (workspace_path / "manifest.json").write_text(manifest.model_dump_json(indent=2) + "\n")

    def _refresh_bank_index(self) -> None:
        _, workspace_path = self.ensure_open()
        questions = self._load_questions_from_disk(workspace_path)
        bank = BankIndexModel(
            question_ids=[question.id for question in questions],
            topics=sorted({question.topic for question in questions}),
            updated_at=datetime.now(UTC),
        )
        (workspace_path / "bank.json").write_text(bank.model_dump_json(indent=2) + "\n")

    def _load_questions_from_disk(self, workspace_path: Path) -> list[QuestionModel]:
        return [
            QuestionModel.model_validate_json(path.read_text())
            for path in sorted((workspace_path / "questions").glob("*.json"))
        ]

    def _question_path(self, question_id: str) -> Path:
        _, workspace_path = self.ensure_open()
        return workspace_path / "questions" / f"{question_id}.json"

    def _validate_workspace(self, workspace_path: Path) -> None:
        required_paths = [
            workspace_path / "manifest.json",
            workspace_path / "bank.json",
            workspace_path / "questions",
        ]
        missing = [str(path.name) for path in required_paths if not path.exists()]
        if missing:
            shutil.rmtree(workspace_path, ignore_errors=True)
            raise BankWorkspaceError(
                f"Bank is missing required files or folders: {', '.join(missing)}",
                status_code=400,
            )

        ManifestModel.model_validate_json((workspace_path / "manifest.json").read_text())
        BankIndexModel.model_validate_json((workspace_path / "bank.json").read_text())
        SourceStandardListCollectionModel.model_validate_json(
            (workspace_path / "standards" / "source_lists.json").read_text()
        )
        standards = StandardRecordCollectionModel.model_validate_json(
            (workspace_path / "standards" / "records.json").read_text()
        )
        courses = CourseCollectionModel.model_validate_json(
            (workspace_path / "courses" / "courses.json").read_text()
        )
        TestDraftCollectionModel.model_validate_json(
            (workspace_path / "tests" / "tests.json").read_text()
        )

        standards_by_id = {item.id for item in standards.items}
        for path in sorted((workspace_path / "questions").glob("*.json")):
            question = QuestionModel.model_validate_json(path.read_text())
            for reference in question.standards:
                if reference.standard_id not in standards_by_id:
                    raise BankWorkspaceError(
                        f"Question {question.id} references unknown standard {reference.standard_id}",
                        status_code=422,
                    )

        for course in courses.items:
            for reference in course.standard_refs:
                if reference.standard_id not in standards_by_id:
                    raise BankWorkspaceError(
                        f"Course {course.id} references unknown standard {reference.standard_id}",
                        status_code=422,
                    )

    def _normalize_workspace_root(self, workspace_path: Path) -> Path:
        manifest_path = workspace_path / "manifest.json"
        if manifest_path.exists():
            return workspace_path

        child_dirs = [child for child in workspace_path.iterdir() if child.is_dir()]
        if len(child_dirs) == 1 and (child_dirs[0] / "manifest.json").exists():
            nested_root = child_dirs[0]
            for item in nested_root.iterdir():
                shutil.move(str(item), workspace_path / item.name)
            nested_root.rmdir()
            return workspace_path

        return workspace_path

    def _ensure_support_files(self, workspace_path: Path) -> None:
        standards_dir = workspace_path / "standards"
        courses_dir = workspace_path / "courses"
        imports_dir = workspace_path / "imports"
        tests_dir = workspace_path / "tests"
        standards_dir.mkdir(parents=True, exist_ok=True)
        courses_dir.mkdir(parents=True, exist_ok=True)
        imports_dir.mkdir(parents=True, exist_ok=True)
        tests_dir.mkdir(parents=True, exist_ok=True)

        source_lists_path = standards_dir / "source_lists.json"
        if not source_lists_path.exists():
            source_lists_path.write_text(SourceStandardListCollectionModel().model_dump_json(indent=2) + "\n")

        records_path = standards_dir / "records.json"
        if not records_path.exists():
            records_path.write_text(StandardRecordCollectionModel().model_dump_json(indent=2) + "\n")

        courses_path = courses_dir / "courses.json"
        if not courses_path.exists():
            courses_path.write_text(CourseCollectionModel().model_dump_json(indent=2) + "\n")

        tests_path = tests_dir / "tests.json"
        if not tests_path.exists():
            tests_path.write_text(TestDraftCollectionModel().model_dump_json(indent=2) + "\n")

    def _ensure_referenced_standard_records(self, workspace_path: Path) -> None:
        source_lists_path = workspace_path / "standards" / "source_lists.json"
        records_path = workspace_path / "standards" / "records.json"
        courses_path = workspace_path / "courses" / "courses.json"
        questions_dir = workspace_path / "questions"

        source_lists = SourceStandardListCollectionModel.model_validate_json(
            source_lists_path.read_text()
        )
        records = StandardRecordCollectionModel.model_validate_json(records_path.read_text())
        known_standard_ids = {item.id for item in records.items}
        referenced_standard_ids: set[str] = set()

        for path in sorted(questions_dir.glob("*.json")):
            question = QuestionModel.model_validate_json(path.read_text())
            referenced_standard_ids.update(
                reference.standard_id for reference in question.standards
            )

        courses = CourseCollectionModel.model_validate_json(courses_path.read_text())
        for course in courses.items:
            referenced_standard_ids.update(
                reference.standard_id for reference in course.standard_refs
            )

        missing_standard_ids = sorted(referenced_standard_ids - known_standard_ids)
        if not missing_standard_ids:
            return

        placeholder_source_id = "unresolved-question-standards"
        if not any(item.id == placeholder_source_id for item in source_lists.items):
            source_lists.items.append(
                SourceStandardListModel(
                    id=placeholder_source_id,
                    title="Unresolved Question Standards",
                    issuer="Nexzam",
                    subject=None,
                    version=None,
                    description=(
                        "Placeholder standards created for question or course references "
                        "that were present in the bank but missing from standards/records.json."
                    ),
                    imported_at=datetime.now(UTC),
                )
            )

        for standard_id in missing_standard_ids:
            records.items.append(
                StandardRecordModel(
                    id=standard_id,
                    source_list_id=placeholder_source_id,
                    code=standard_id,
                    statement=(
                        "Placeholder for a standard referenced by a question or course. "
                        "Review this record and replace it with the official standard text."
                    ),
                    tags=["placeholder", "needs-review"],
                )
            )

        source_lists.items.sort(key=lambda item: item.id)
        records.items.sort(key=lambda item: item.id)
        source_lists_path.write_text(source_lists.model_dump_json(indent=2) + "\n")
        records_path.write_text(records.model_dump_json(indent=2) + "\n")

    def _ensure_referenced_course_ids(self, workspace_path: Path) -> None:
        """Drop course references on tests whose course no longer exists.

        A bank whose course was deleted elsewhere should still open, so a stale
        reference is repaired on load rather than treated as a broken bank.
        """
        courses_path = workspace_path / "courses" / "courses.json"
        tests_path = workspace_path / "tests" / "tests.json"

        courses = CourseCollectionModel.model_validate_json(courses_path.read_text())
        known_course_ids = {item.id for item in courses.items}
        tests = TestDraftCollectionModel.model_validate_json(tests_path.read_text())

        changed = False
        for test in tests.items:
            kept = [item for item in test.course_ids if item in known_course_ids]
            if len(kept) != len(test.course_ids):
                test.course_ids = kept
                changed = True

        if changed:
            tests_path.write_text(tests.model_dump_json(indent=2) + "\n")

    def _build_blank_question(self) -> QuestionModel:
        return QuestionModel(
            id=self._next_question_id_for_type("multiple_choice"),
            type="multiple_choice",
            topic="Unsorted",
            difficulty=1,
            prompt="New question prompt",
            subtopic="",
            tags=[],
            standards=[],
            estimated_time_sec=60,
            points=1,
            status="draft",
            teacher_notes="",
            answer={
                "choices": ["", ""],
                "correct_choice_index": 0,
            },
            explanation="",
            rubric=[],
            sample_solution="",
            exemplar_answer="",
            assets=[],
        )

    def _require_course(self, course_id: str) -> CourseModel:
        for course in self._read_courses().items:
            if course.id == course_id:
                return course
        raise BankWorkspaceError(f"Course not found: {course_id}", status_code=404)

    def _dedupe_standard_refs(self, refs: list[StandardReferenceModel]) -> list[StandardReferenceModel]:
        seen: set[str] = set()
        deduped: list[StandardReferenceModel] = []
        for reference in refs:
            if reference.standard_id in seen:
                continue
            seen.add(reference.standard_id)
            deduped.append(reference)
        return deduped

    def _next_duplicate_question_id(self, source_id: str) -> str:
        _, workspace_path = self.ensure_open()
        questions_dir = workspace_path / "questions"
        counter = 1
        while True:
            suffix = "_copy" if counter == 1 else f"_copy_{counter}"
            candidate = f"{source_id}{suffix}"
            if not (questions_dir / f"{candidate}.json").exists():
                return candidate
            counter += 1

    def _next_question_id_for_type(self, question_type: object) -> str:
        _, workspace_path = self.ensure_open()
        questions_dir = workspace_path / "questions"
        prefix = self.QUESTION_ID_PREFIX_BY_TYPE.get(str(question_type), "q")
        pattern = re.compile(rf"^{re.escape(prefix)}_(\d+)$")
        max_serial = 0

        for question_path in questions_dir.glob("*.json"):
            match = pattern.match(question_path.stem)
            if match:
                max_serial = max(max_serial, int(match.group(1)))

        return f"{prefix}_{max_serial + 1:04d}"

    def _next_test_draft_id(self) -> str:
        tests = self._read_tests()
        pattern = re.compile(r"^test_(\d+)$")
        max_serial = 0

        for test in tests.items:
            match = pattern.match(test.id)
            if match:
                max_serial = max(max_serial, int(match.group(1)))

        return f"test_{max_serial + 1:04d}"

    def _dedupe_asset_name(self, assets_dir: Path, filename: str) -> str:
        candidate = filename
        stem = Path(filename).stem
        suffix = Path(filename).suffix
        counter = 1
        while (assets_dir / candidate).exists():
            candidate = f"{stem}-{counter}{suffix}"
            counter += 1
        return candidate

    def _store_import_file(
        self,
        workspace_path: Path,
        source_list_id: str,
        filename: str,
        content: bytes,
    ) -> str:
        imports_dir = workspace_path / "imports"
        imports_dir.mkdir(parents=True, exist_ok=True)
        target_name = self._dedupe_asset_name(imports_dir, f"{source_list_id}-{filename}")
        target_path = imports_dir / target_name
        target_path.write_bytes(content)
        return f"imports/{target_name}"

    def _build_question_import_id(self) -> str:
        return f"question-import-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"

    def _question_import_stage_path(self, import_id: str) -> Path:
        _, workspace_path = self.ensure_open()
        safe_id = Path(import_id).name
        if safe_id != import_id or not safe_id or safe_id in {".", ".."}:
            raise BankWorkspaceError("Invalid question import id.", status_code=400)
        return workspace_path / "imports" / safe_id / "stage.json"

    def _parse_json_question_import(self, raw_text: str) -> list[dict[str, object]]:
        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise BankWorkspaceError(f"Invalid question import JSON: {exc}", status_code=400)

        if isinstance(payload, list):
            items = payload
        elif isinstance(payload, dict):
            if isinstance(payload.get("question"), dict):
                items = [payload["question"]]
            elif "questions" in payload:
                items = payload["questions"]
            elif "items" in payload:
                items = payload["items"]
            else:
                items = [payload]
        else:
            raise BankWorkspaceError("Question import JSON must be an object or array.", status_code=400)

        if not isinstance(items, list):
            raise BankWorkspaceError("Question import JSON items must be an array.", status_code=400)

        normalized_items = []
        for item in items:
            if not isinstance(item, dict):
                raise BankWorkspaceError("Each imported question must be an object.", status_code=400)
            normalized_items.append(item)
        return normalized_items

    def _parse_csv_question_import(self, raw_text: str) -> list[ParsedQuestionImportRow]:
        reader = csv.DictReader(raw_text.splitlines())
        if reader.fieldnames is None:
            raise BankWorkspaceError("Question import CSV is missing a header row.", status_code=400)

        rows: list[ParsedQuestionImportRow] = []
        for row in reader:
            if not any((value or "").strip() for value in row.values()):
                continue

            source = {
                str(key): value or ""
                for key, value in row.items()
                if key is not None
            }
            question, issues = self._normalize_csv_question_row(source)
            rows.append((source, question, issues))

        return rows

    def _normalize_csv_question_row(
        self,
        row: dict[str, object],
    ) -> tuple[dict[str, object], list[QuestionImportValidationIssueModel]]:
        question: dict[str, object] = {}
        issues: list[QuestionImportValidationIssueModel] = []

        for field_name in [
            "id",
            "type",
            "topic",
            "prompt",
            "subtopic",
            "status",
            "teacher_notes",
            "explanation",
            "sample_solution",
            "exemplar_answer",
        ]:
            value = self._normalize_optional_text(row.get(field_name))
            if value is not None:
                question[field_name] = value

        difficulty = self._normalize_optional_text(row.get("difficulty"))
        if difficulty is not None:
            try:
                question["difficulty"] = int(difficulty)
            except ValueError:
                question["difficulty"] = difficulty
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="malformed_number",
                        message="difficulty must be an integer.",
                        location=["difficulty"],
                    )
                )

        estimated_time_sec = self._normalize_optional_text(row.get("estimated_time_sec"))
        if estimated_time_sec is not None:
            try:
                question["estimated_time_sec"] = int(estimated_time_sec)
            except ValueError:
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="malformed_number",
                        message="estimated_time_sec must be an integer.",
                        location=["estimated_time_sec"],
                    )
                )

        points = self._normalize_optional_text(row.get("points"))
        if points is not None:
            try:
                question["points"] = float(points)
            except ValueError:
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="malformed_number",
                        message="points must be a number.",
                        location=["points"],
                    )
                )

        tags = self._normalize_optional_text(row.get("tags"))
        if tags is not None:
            question["tags"] = self._normalize_tags(tags)

        standards = self._normalize_optional_text(row.get("standards"))
        if standards is not None:
            question["standards"] = self._parse_csv_standard_refs(standards, issues)

        for column_name, question_field in [
            ("answer_json", "answer"),
            ("rubric_json", "rubric"),
            ("assets_json", "assets"),
        ]:
            raw_json = self._normalize_optional_text(row.get(column_name))
            if raw_json is None:
                continue
            try:
                question[question_field] = json.loads(raw_json)
            except json.JSONDecodeError as exc:
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="malformed_json",
                        message=f"{column_name} is not valid JSON: {exc}",
                        location=[column_name],
                    )
                )

        return question, issues

    def _parse_csv_standard_refs(
        self,
        raw_value: str,
        issues: list[QuestionImportValidationIssueModel],
    ) -> list[dict[str, str]]:
        stripped = raw_value.strip()
        if stripped.startswith("["):
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError as exc:
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="malformed_json",
                        message=f"standards is not valid JSON: {exc}",
                        location=["standards"],
                    )
                )
                return []

            if not isinstance(payload, list):
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="malformed_standards",
                        message="standards JSON must be an array.",
                        location=["standards"],
                    )
                )
                return []

            refs: list[dict[str, str]] = []
            for index, item in enumerate(payload):
                if isinstance(item, str):
                    refs.append({"standard_id": item})
                elif isinstance(item, dict) and isinstance(item.get("standard_id"), str):
                    refs.append({"standard_id": item["standard_id"]})
                else:
                    issues.append(
                        QuestionImportValidationIssueModel(
                            code="malformed_standards",
                            message="standards entries must be ids or standard reference objects.",
                            location=["standards", index],
                        )
                    )
            return refs

        return [
            {"standard_id": standard_id}
            for standard_id in self._normalize_tags(raw_value)
        ]

    def _build_question_import_stage(
        self,
        *,
        import_id: str,
        source_filename: str,
        source_path: str,
        imported_rows: list[ParsedQuestionImportRow],
    ) -> QuestionImportStageModel:
        existing_question_ids = {question.id for question in self._load_questions()}
        existing_standard_ids = {standard.id for standard in self._read_standard_records().items}
        reserved_ids = set(existing_question_ids)
        imported_id_counts: dict[str, int] = {}
        for _, question, _ in imported_rows:
            imported_id = self._normalize_optional_text(question.get("id"))
            if imported_id:
                imported_id_counts[imported_id] = imported_id_counts.get(imported_id, 0) + 1

        rows: list[QuestionImportRowModel] = []
        for index, (source, question, parse_issues) in enumerate(imported_rows, start=1):
            row_id = f"row-{index:04d}"
            imported_id = self._normalize_optional_text(question.get("id"))
            question_type = self._normalize_optional_text(question.get("type"))
            proposed_id = (
                self._next_question_id_for_type_with_reserved(question_type, reserved_ids)
                if question_type in self.QUESTION_ID_PREFIX_BY_TYPE
                else None
            )
            if proposed_id:
                reserved_ids.add(proposed_id)

            issues = self._validate_staged_question(
                source=question,
                proposed_id=proposed_id,
                existing_standard_ids=existing_standard_ids,
            )
            issues = [*parse_issues, *issues]
            if imported_id in existing_question_ids:
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="duplicate_existing_id",
                        message=f"Imported id {imported_id} already exists in this bank.",
                        location=["id"],
                        severity="warning",
                    )
                )
            if imported_id and imported_id_counts.get(imported_id, 0) > 1:
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="duplicate_import_id",
                        message=f"Imported id {imported_id} appears more than once in this import.",
                        location=["id"],
                        severity="warning",
                    )
                )

            status = "invalid" if self._has_error_issues(issues) else "valid"
            rows.append(
                QuestionImportRowModel(
                    row_id=row_id,
                    source_index=index,
                    source=dict(source),
                    question=dict(question),
                    proposed_id=proposed_id,
                    imported_id=imported_id,
                    status=status,
                    selected=status == "valid",
                    issues=issues,
                )
            )

        return QuestionImportStageModel(
            id=import_id,
            source_filename=source_filename,
            source_path=source_path,
            created_at=datetime.now(UTC),
            rows=rows,
        )

    def _validate_staged_question(
        self,
        *,
        source: dict[str, object],
        proposed_id: str | None,
        existing_standard_ids: set[str],
    ) -> list[QuestionImportValidationIssueModel]:
        payload = dict(source)
        if not self._normalize_optional_text(payload.get("id")) and proposed_id:
            payload["id"] = proposed_id

        issues: list[QuestionImportValidationIssueModel] = []
        try:
            question = QuestionModel.model_validate(payload)
        except ValidationError as exc:
            for error in exc.errors():
                issues.append(
                    QuestionImportValidationIssueModel(
                        code=str(error.get("type") or "validation_error"),
                        message=str(error.get("msg") or "Question validation failed."),
                        location=list(error.get("loc") or []),
                    )
                )
            return issues

        for index, reference in enumerate(question.standards):
            if reference.standard_id not in existing_standard_ids:
                issues.append(
                    QuestionImportValidationIssueModel(
                        code="unknown_standard",
                        message=f"Unknown standard reference: {reference.standard_id}",
                        location=["standards", index, "standard_id"],
                        severity="warning",
                    )
                )

        return issues

    @staticmethod
    def _has_error_issues(issues: list[QuestionImportValidationIssueModel]) -> bool:
        return any(issue.severity == "error" for issue in issues)

    def _refresh_staged_row_validation(
        self,
        stage: QuestionImportStageModel,
        row: QuestionImportRowModel,
        selected: bool | None,
    ) -> None:
        existing_question_ids = {question.id for question in self._load_questions()}
        existing_standard_ids = {standard.id for standard in self._read_standard_records().items}
        reserved_ids = set(existing_question_ids)

        for other_row in stage.rows:
            if other_row.row_id == row.row_id:
                continue
            if other_row.proposed_id:
                reserved_ids.add(other_row.proposed_id)
            if other_row.promoted_question_id:
                reserved_ids.add(other_row.promoted_question_id)

        question_type = self._normalize_optional_text(row.question.get("type"))
        row.proposed_id = (
            self._next_question_id_for_type_with_reserved(question_type, reserved_ids)
            if question_type in self.QUESTION_ID_PREFIX_BY_TYPE
            else None
        )

        issues = self._validate_staged_question(
            source=row.question,
            proposed_id=row.proposed_id,
            existing_standard_ids=existing_standard_ids,
        )

        if row.imported_id in existing_question_ids:
            issues.append(
                QuestionImportValidationIssueModel(
                    code="duplicate_existing_id",
                    message=f"Imported id {row.imported_id} already exists in this bank.",
                    location=["id"],
                    severity="warning",
                )
            )

        duplicate_row_ids = [
            other_row.row_id
            for other_row in stage.rows
            if other_row.row_id != row.row_id
            and other_row.imported_id
            and other_row.imported_id == row.imported_id
        ]
        if row.imported_id and duplicate_row_ids:
            issues.append(
                QuestionImportValidationIssueModel(
                    code="duplicate_import_id",
                    message=f"Imported id {row.imported_id} appears more than once in this import.",
                    location=["id"],
                    severity="warning",
                )
            )

        row.issues = issues
        row.status = "invalid" if self._has_error_issues(issues) else "valid"
        row.selected = selected if selected is not None else row.status == "valid"

    def _resolve_promoted_question_id(self, row: QuestionImportRowModel, id_policy: str) -> str:
        if id_policy == "keep_imported" and row.imported_id:
            return row.imported_id

        if not row.proposed_id:
            raise BankWorkspaceError(
                f"Staged row {row.row_id} does not have a proposed question id.",
                status_code=422,
            )
        return row.proposed_id

    def _next_question_id_for_type_with_reserved(
        self,
        question_type: object,
        reserved_ids: set[str],
    ) -> str:
        _, workspace_path = self.ensure_open()
        prefix = self.QUESTION_ID_PREFIX_BY_TYPE.get(str(question_type), "q")
        pattern = re.compile(rf"^{re.escape(prefix)}_(\d+)$")
        max_serial = 0

        for question_path in (workspace_path / "questions").glob("*.json"):
            match = pattern.match(question_path.stem)
            if match:
                max_serial = max(max_serial, int(match.group(1)))

        for question_id in reserved_ids:
            match = pattern.match(question_id)
            if match:
                max_serial = max(max_serial, int(match.group(1)))

        return f"{prefix}_{max_serial + 1:04d}"

    def _parse_json_standard_import(
        self, raw_text: str
    ) -> tuple[dict[str, object] | None, list[dict[str, object]]]:
        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise BankWorkspaceError(f"Invalid standards JSON: {exc}", status_code=400)

        if isinstance(payload, list):
            items = payload
            source_list = None
        elif isinstance(payload, dict):
            source_list = payload.get("source_list")
            if "standards" in payload:
                items = payload["standards"]
            elif "items" in payload:
                items = payload["items"]
            else:
                raise BankWorkspaceError(
                    "Standards JSON must include an items or standards array.",
                    status_code=400,
                )
        else:
            raise BankWorkspaceError("Standards JSON must be an object or array.", status_code=400)

        if not isinstance(items, list):
            raise BankWorkspaceError("Standards JSON items must be an array.", status_code=400)

        normalized_items = []
        for item in items:
            if not isinstance(item, dict):
                raise BankWorkspaceError("Each imported standard must be an object.", status_code=400)
            normalized_items.append(item)

        if source_list is not None and not isinstance(source_list, dict):
            raise BankWorkspaceError("source_list must be an object when provided.", status_code=400)

        return source_list, normalized_items

    def _parse_csv_standard_import(self, raw_text: str) -> list[dict[str, object]]:
        reader = csv.DictReader(raw_text.splitlines())
        if reader.fieldnames is None:
            raise BankWorkspaceError("Standards CSV is missing a header row.", status_code=400)

        rows: list[dict[str, object]] = []
        for row in reader:
            if not any((value or "").strip() for value in row.values()):
                continue

            # Keep every column so per-standard source columns survive, and
            # normalize the header spelling so "Grade Band" reads the same as
            # "grade_band".
            normalized: dict[str, object] = {
                str(key).strip().lower().replace(" ", "_").replace("-", "_"): value
                for key, value in row.items()
                if key is not None
            }
            normalized.update(
                {
                    "id": normalized.get("id") or normalized.get("standard_id") or "",
                    "code": normalized.get("code") or "",
                    "statement": normalized.get("statement") or "",
                    "subject": normalized.get("subject") or "",
                    "strand": normalized.get("strand") or "",
                    "grade_band": normalized.get("grade_band") or "",
                    "tags": normalized.get("tags") or "",
                }
            )
            rows.append(normalized)
        return rows

    def _read_standard_import_file(
        self,
        filename: str,
        content: bytes,
    ) -> tuple[dict[str, object] | None, list[dict[str, object]], str]:
        safe_name = Path(filename or "").name
        suffix = Path(safe_name).suffix.lower()
        if suffix not in {".json", ".csv"}:
            raise BankWorkspaceError(
                "Standards imports must be JSON or CSV files.",
                status_code=400,
            )

        try:
            raw_text = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise BankWorkspaceError(f"Could not decode import file as UTF-8: {exc}", status_code=400)

        if suffix == ".json":
            embedded_source_list, rows = self._parse_json_standard_import(raw_text)
        else:
            embedded_source_list, rows = None, self._parse_csv_standard_import(raw_text)
        return embedded_source_list, rows, safe_name

    def _extract_row_source(self, row: dict[str, object]) -> dict[str, str] | None:
        """Pull the source information a single imported standard carries.

        Returns None when the row says nothing about where the standard came
        from, which is the signal that the import needs a source supplied for it.
        """
        lowered = {str(key).strip().lower(): value for key, value in row.items()}
        fields: dict[str, str] = {}

        nested = lowered.get("source")
        if isinstance(nested, dict):
            for field in ("id", "title", "issuer", "subject", "version", "description"):
                text = self._normalize_optional_text(nested.get(field))
                if text:
                    fields[field] = text

        for field, aliases in self.SOURCE_ROW_ALIASES.items():
            if field in fields:
                continue
            for alias in aliases:
                value = lowered.get(alias)
                if isinstance(value, (dict, list)):
                    continue
                text = self._normalize_optional_text(value)
                if text:
                    fields[field] = text
                    break

        if not fields:
            return None
        if "id" not in fields and fields.get("title"):
            fields["id"] = self._slugify_source_id(fields["title"])
        return fields

    def _describe_detected_source(
        self,
        fields: dict[str, str],
        existing_by_id: dict[str, SourceStandardListModel],
    ) -> DetectedImportSourceModel:
        title = self._normalize_optional_text(fields.get("title"))
        source_id = self._normalize_optional_text(fields.get("id")) or (
            self._slugify_source_id(title) if title else None
        )
        issuer = self._normalize_optional_text(fields.get("issuer"))
        matches_existing = bool(source_id and source_id in existing_by_id)
        return DetectedImportSourceModel(
            id=source_id,
            title=title,
            issuer=issuer,
            subject=self._normalize_optional_text(fields.get("subject")),
            version=self._normalize_optional_text(fields.get("version")),
            description=self._normalize_optional_text(fields.get("description")),
            standard_count=0,
            matches_existing_source=matches_existing,
            complete=matches_existing or bool(source_id and title and issuer),
        )

    def _resolve_import_source_groups(
        self,
        *,
        rows: list[dict[str, object]],
        embedded_source_list: dict[str, object] | None,
        source_list_id: str | None,
        title: str | None,
        issuer: str | None,
        subject: str | None,
        version: str | None,
        description: str | None,
    ) -> list[tuple[SourceStandardListModel, list[dict[str, object]]]]:
        existing_by_id = {item.id: item for item in self._read_source_standard_lists().items}
        form_issuer = self._normalize_optional_text(issuer)

        sources: dict[str, SourceStandardListModel] = {}
        buckets: dict[str, list[dict[str, object]]] = {}
        group_order: list[str] = []
        rows_without_source: list[dict[str, object]] = []

        for row in rows:
            fields = self._extract_row_source(row)
            if not fields:
                rows_without_source.append(row)
                continue

            source = self._build_row_source_standard_list(fields, existing_by_id, form_issuer)
            if source.id not in sources:
                sources[source.id] = source
                buckets[source.id] = []
                group_order.append(source.id)
            buckets[source.id].append(row)

        if rows_without_source or not rows:
            fallback = self._build_source_standard_list(
                embedded_source_list=embedded_source_list,
                source_list_id=source_list_id,
                title=title,
                issuer=issuer,
                subject=subject,
                version=version,
                description=description,
            )
            fallback = existing_by_id.get(fallback.id, fallback)
            if fallback.id not in sources:
                sources[fallback.id] = fallback
                buckets[fallback.id] = []
                group_order.append(fallback.id)
            buckets[fallback.id].extend(rows_without_source)

        return [(sources[source_id], buckets[source_id]) for source_id in group_order]

    def _build_row_source_standard_list(
        self,
        fields: dict[str, str],
        existing_by_id: dict[str, SourceStandardListModel],
        form_issuer: str | None,
    ) -> SourceStandardListModel:
        source_id = self._normalize_optional_text(fields.get("id"))
        existing = existing_by_id.get(source_id or "")
        if existing is not None:
            # An import never rewrites the metadata of a source already on file.
            return existing

        resolved_title = self._normalize_optional_text(fields.get("title"))
        if not source_id or not resolved_title:
            raise BankWorkspaceError(
                "Each source named in the import file needs a title.",
                status_code=422,
            )

        resolved_issuer = self._normalize_optional_text(fields.get("issuer")) or form_issuer
        if not resolved_issuer:
            raise BankWorkspaceError(
                f'The source "{resolved_title}" named in the import file needs an issuer. '
                "Supply an issuer with the import to apply to every source it names.",
                status_code=422,
            )

        return SourceStandardListModel(
            id=source_id,
            title=resolved_title,
            issuer=resolved_issuer,
            subject=self._normalize_optional_text(fields.get("subject")),
            version=self._normalize_optional_text(fields.get("version")),
            description=self._normalize_optional_text(fields.get("description")),
            imported_at=datetime.now(UTC),
        )

    def _slugify_source_id(self, value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")

    def _prune_empty_source_lists(self, records: StandardRecordCollectionModel) -> None:
        used_source_ids = {item.source_list_id for item in records.items}
        source_lists = self._read_source_standard_lists()
        remaining = [item for item in source_lists.items if item.id in used_source_ids]
        if len(remaining) != len(source_lists.items):
            source_lists.items = remaining
            self._write_source_standard_lists(source_lists)

    def _build_standard_records(
        self,
        *,
        source_list: SourceStandardListModel,
        rows: list[dict[str, object]],
        existing_standard_ids: set[str],
    ) -> list[StandardRecordModel]:
        """Validate incoming standard rows from an upload or from manual entry."""
        seen_standard_ids: set[str] = set()
        standards: list[StandardRecordModel] = []
        for row in rows:
            standard_id = str(row.get("id") or row.get("standard_id") or "").strip()
            code = str(row.get("code") or standard_id).strip()
            statement = str(row.get("statement") or "").strip()
            if not standard_id or not code or not statement:
                raise BankWorkspaceError(
                    "Standards must include id, code, and statement values.",
                    status_code=422,
                )
            if standard_id in existing_standard_ids or standard_id in seen_standard_ids:
                raise BankWorkspaceError(
                    f"Duplicate standard id: {standard_id}",
                    status_code=409,
                )

            seen_standard_ids.add(standard_id)
            standards.append(
                StandardRecordModel(
                    id=standard_id,
                    source_list_id=source_list.id,
                    code=code,
                    statement=statement,
                    subject=self._normalize_optional_text(row.get("subject")) or source_list.subject,
                    strand=self._normalize_optional_text(row.get("strand")),
                    grade_band=self._normalize_optional_text(row.get("grade_band")),
                    tags=self._normalize_tags(row.get("tags")),
                )
            )

        return standards

    def _build_source_standard_list(
        self,
        *,
        embedded_source_list: dict[str, object] | None,
        source_list_id: str | None,
        title: str | None,
        issuer: str | None,
        subject: str | None,
        version: str | None,
        description: str | None,
    ) -> SourceStandardListModel:
        source_list_payload = embedded_source_list or {}
        resolved_id = self._normalize_optional_text(source_list_id) or self._normalize_optional_text(
            source_list_payload.get("id")
        )
        resolved_title = self._normalize_optional_text(title) or self._normalize_optional_text(
            source_list_payload.get("title")
        )
        resolved_issuer = self._normalize_optional_text(issuer) or self._normalize_optional_text(
            source_list_payload.get("issuer")
        )
        resolved_subject = self._normalize_optional_text(subject) or self._normalize_optional_text(
            source_list_payload.get("subject")
        )
        resolved_version = self._normalize_optional_text(version) or self._normalize_optional_text(
            source_list_payload.get("version")
        )
        resolved_description = self._normalize_optional_text(description) or self._normalize_optional_text(
            source_list_payload.get("description")
        )

        if not resolved_id or not resolved_title or not resolved_issuer:
            raise BankWorkspaceError(
                "A standards source list requires an id, a title, and an issuer.",
                status_code=422,
            )

        return SourceStandardListModel(
            id=resolved_id,
            title=resolved_title,
            issuer=resolved_issuer,
            subject=resolved_subject,
            version=resolved_version,
            description=resolved_description,
            imported_at=datetime.now(UTC),
        )

    def _normalize_optional_text(self, value: object) -> str | None:
        text = str(value or "").strip()
        return text or None

    def _normalize_tags(self, value: object) -> list[str]:
        if isinstance(value, list):
            parts = [str(item).strip() for item in value]
        else:
            parts = re.split(r"[;,]", str(value or ""))
        return [part for part in (item.strip() for item in parts) if part]

    def render_svg(self, source: str, variables: dict[str, str]) -> str:
        source = self.SVG_CALC_PATTERN.sub(
            lambda match: self._evaluate_svg_expression(match.group(1), variables),
            source,
        )

        def replace(match: re.Match[str]) -> str:
            key = match.group(1)
            return variables.get(key, "")

        return self.SVG_PLACEHOLDER_PATTERN.sub(replace, source)

    def extract_svg_placeholders(self, source: str) -> list[str]:
        placeholders = set(self.SVG_PLACEHOLDER_PATTERN.findall(source))
        for expression in self.SVG_CALC_PATTERN.findall(source):
            placeholders.update(self.SVG_EXPR_VARIABLE_PATTERN.findall(expression))
        return sorted(placeholders)

    def _evaluate_svg_expression(self, expression: str, variables: dict[str, str]) -> str:
        try:
            parsed = ast.parse(expression, mode="eval")
            value = self._eval_svg_ast(parsed.body, variables)
        except Exception:
            return "0"

        if float(value).is_integer():
            return str(int(value))
        return f"{value:.4f}".rstrip("0").rstrip(".")

    def _eval_svg_ast(self, node: ast.AST, variables: dict[str, str]) -> float:
        if isinstance(node, ast.BinOp):
            left = self._eval_svg_ast(node.left, variables)
            right = self._eval_svg_ast(node.right, variables)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right if right != 0 else 0
            raise ValueError("unsupported binary operator")

        if isinstance(node, ast.UnaryOp):
            value = self._eval_svg_ast(node.operand, variables)
            if isinstance(node.op, ast.UAdd):
                return value
            if isinstance(node.op, ast.USub):
                return -value
            raise ValueError("unsupported unary operator")

        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)

        if isinstance(node, ast.Name):
            raw_value = variables.get(node.id, "0").strip()
            try:
                return float(raw_value)
            except ValueError:
                return 0

        raise ValueError("unsupported expression node")
