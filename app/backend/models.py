from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator


QuestionType = Literal[
    "multiple_choice",
    "numeric_response",
    "short_answer",
    "free_response",
]


class AssetModel(BaseModel):
    path: str
    kind: str
    svg_variables: dict[str, str] = Field(default_factory=dict)


class AssetUploadResponseModel(BaseModel):
    path: str
    kind: str


class AssetInspectionRequest(BaseModel):
    path: str
    kind: str
    svg_variables: dict[str, str] = Field(default_factory=dict)


class AssetInspectionResponseModel(BaseModel):
    path: str
    kind: str
    svg_placeholders: list[str] = Field(default_factory=list)
    rendered_svg: str | None = None


class AssetInspectionBatchRequest(BaseModel):
    assets: list[AssetInspectionRequest] = Field(default_factory=list)


class AssetInspectionBatchResponseModel(BaseModel):
    items: list[AssetInspectionResponseModel] = Field(default_factory=list)


class AssetListItemModel(BaseModel):
    path: str
    kind: str
    referenced_by: list[str] = Field(default_factory=list)
    svg_placeholders: list[str] = Field(default_factory=list)


class AssetListResponseModel(BaseModel):
    items: list[AssetListItemModel] = Field(default_factory=list)


class StandardReferenceModel(BaseModel):
    standard_id: str


class SourceStandardListModel(BaseModel):
    id: str
    title: str
    issuer: str
    subject: str | None = None
    version: str | None = None
    description: str | None = None
    imported_at: datetime


class StandardRecordModel(BaseModel):
    id: str
    source_list_id: str
    code: str
    statement: str
    subject: str | None = None
    strand: str | None = None
    grade_band: str | None = None
    tags: list[str] = Field(default_factory=list)


class SourceStandardListCollectionModel(BaseModel):
    items: list[SourceStandardListModel] = Field(default_factory=list)


class StandardRecordCollectionModel(BaseModel):
    items: list[StandardRecordModel] = Field(default_factory=list)


class CourseModel(BaseModel):
    id: str
    title: str
    description: str | None = None
    standard_refs: list[StandardReferenceModel] = Field(default_factory=list)


class CourseCollectionModel(BaseModel):
    items: list[CourseModel] = Field(default_factory=list)


class CourseStandardCoverageModel(BaseModel):
    """One standard as it appears in a course coverage report.

    `question_count` is how many questions across the course's tests address the
    standard, so a standard covered three times reads differently from one
    covered once. Versions of the same test count once, not once per version.
    """

    standard_id: str
    code: str | None = None
    statement: str | None = None
    source_list_id: str | None = None
    strand: str | None = None
    in_course: bool = True
    question_count: int = 0
    test_count: int = 0
    test_ids: list[str] = Field(default_factory=list)


class CourseTestSummaryModel(BaseModel):
    """One test *lineage* -- every version of a test, reported as a single test.

    Versions exist for test security and retakes, not to add assessment, so
    three versions of a five-question test cover five questions, not fifteen.
    `question_count` is therefore the largest version, never the sum.
    """

    test_id: str
    title: str
    version: str
    # Every version in the lineage, so the UI can match any of them to this row.
    versions: list[str] = Field(default_factory=list)
    test_ids: list[str] = Field(default_factory=list)
    question_count: int = 0
    course_standard_count: int = 0
    extra_standard_count: int = 0


class CourseDetailModel(BaseModel):
    """A course plus everything needed to spot coverage gaps in one view."""

    course: CourseModel
    tests: list[CourseTestSummaryModel] = Field(default_factory=list)
    covered_standards: list[CourseStandardCoverageModel] = Field(default_factory=list)
    uncovered_standards: list[CourseStandardCoverageModel] = Field(default_factory=list)
    extra_standards: list[CourseStandardCoverageModel] = Field(default_factory=list)
    question_count: int = 0


class StandardListResponseModel(BaseModel):
    items: list[SourceStandardListModel] = Field(default_factory=list)


class StandardSearchResponseModel(BaseModel):
    items: list[StandardRecordModel] = Field(default_factory=list)


class CourseListResponseModel(BaseModel):
    items: list[CourseModel] = Field(default_factory=list)


class StandardImportResponseModel(BaseModel):
    # `source_list` stays for callers written against the single-source import.
    # `source_lists` carries every source touched when the file supplied its own
    # per-standard source information.
    source_list: SourceStandardListModel
    source_lists: list[SourceStandardListModel] = Field(default_factory=list)
    imported_count: int
    imported_path: str | None = None


class DetectedImportSourceModel(BaseModel):
    id: str | None = None
    title: str | None = None
    issuer: str | None = None
    subject: str | None = None
    version: str | None = None
    description: str | None = None
    standard_count: int = 0
    matches_existing_source: bool = False
    complete: bool = False


class StandardImportInspectionModel(BaseModel):
    """What a standards file says about where its standards came from.

    The importer reads source information out of the file first. Only when the
    file cannot name a source for every standard does the caller need to supply
    one that applies to the whole import.
    """

    filename: str
    total_rows: int = 0
    rows_with_source: int = 0
    detected_sources: list[DetectedImportSourceModel] = Field(default_factory=list)
    needs_source_input: bool = True
    detected_columns: list[str] = Field(default_factory=list)


class CreateStandardPlaceholdersRequest(BaseModel):
    standard_ids: list[str]


class ManualStandardRowModel(BaseModel):
    id: str
    code: str | None = None
    statement: str
    subject: str | None = None
    strand: str | None = None
    grade_band: str | None = None
    tags: list[str] = Field(default_factory=list)
    # Per-row source. A row either points at an existing source list by id or
    # describes a new one; either way it falls back to the request-level source
    # fields when left blank.
    source_list_id: str | None = None
    source_title: str | None = None
    source_issuer: str | None = None
    source_subject: str | None = None
    source_version: str | None = None
    source_description: str | None = None


class CreateStandardsManuallyRequest(BaseModel):
    source_list_id: str | None = None
    title: str | None = None
    issuer: str | None = None
    subject: str | None = None
    version: str | None = None
    description: str | None = None
    standards: list[ManualStandardRowModel] = Field(default_factory=list)


class QuestionImportValidationIssueModel(BaseModel):
    code: str
    message: str
    location: list[str | int] = Field(default_factory=list)
    severity: Literal["error", "warning"] = "error"


class QuestionImportRowModel(BaseModel):
    row_id: str
    source_index: int
    source: dict[str, Any] = Field(default_factory=dict)
    question: dict[str, Any] = Field(default_factory=dict)
    proposed_id: str | None = None
    imported_id: str | None = None
    promoted_question_id: str | None = None
    status: Literal["valid", "invalid", "promoted"]
    selected: bool = False
    issues: list[QuestionImportValidationIssueModel] = Field(default_factory=list)


class QuestionImportStageModel(BaseModel):
    id: str
    source_filename: str
    source_path: str
    created_at: datetime
    rows: list[QuestionImportRowModel] = Field(default_factory=list)


class QuestionImportListResponseModel(BaseModel):
    items: list[QuestionImportStageModel] = Field(default_factory=list)


class QuestionImportPromoteRequest(BaseModel):
    row_ids: list[str] | None = None
    id_policy: Literal["auto", "keep_imported"] = "auto"


class QuestionImportRowUpdateRequest(BaseModel):
    question: dict[str, Any]
    selected: bool | None = None


class QuestionImportPromoteResponseModel(BaseModel):
    import_id: str
    promoted_count: int
    promoted_question_ids: list[str] = Field(default_factory=list)
    stage: QuestionImportStageModel


class TestQuestionItemModel(BaseModel):
    question_id: str
    experimental: bool = False
    response_space_lines: int | None = None
    teacher_notes: str | None = None

    @field_validator("question_id")
    @classmethod
    def validate_question_id(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("question test items require question_id")
        return text


class TestSectionItemModel(BaseModel):
    item_type: Literal["section"] = "section"
    section_id: str | None = None
    question_type: QuestionType | None = None
    title: str
    instructions: str = ""
    header_template: str | None = None
    topic: str | None = None
    standards: list[str] = Field(default_factory=list)
    suggested_time_mode: Literal["calculated", "override"] = "calculated"
    suggested_time_sec: int | None = None

    @model_validator(mode="after")
    def validate_section_shape(self) -> "TestSectionItemModel":
        if not (self.title or "").strip():
            raise ValueError("section test items require title")
        self.section_id = (self.section_id or self.title).strip()
        self.instructions = self.instructions or ""
        self.header_template = self.header_template if self.header_template is not None else None
        self.topic = self.topic if self.topic and self.topic.strip() else None
        self.standards = [standard.strip() for standard in self.standards if standard.strip()]
        return self


TestItemModel = TestQuestionItemModel | TestSectionItemModel


class TestInstructionSectionModel(BaseModel):
    question_type: QuestionType
    title: str
    instructions: str
    header_template: str | None = None
    show_topic: bool = False
    show_standards: bool = False
    show_suggested_time: bool = True
    suggested_time_mode: Literal["calculated", "override"] = "calculated"
    suggested_time_sec: int | None = None


class TestTemplateBlockModel(BaseModel):
    template: str
    alignment: Literal["left", "center", "right"] = "left"
    horizontal_line: bool = False
    spacing_after_lines: int = 1


class TestInstructionSectionOptionsModel(BaseModel):
    show_topic: bool = False
    show_standards: bool = False
    show_suggested_time: bool = True
    alignment: Literal["left", "center", "right"] = "left"
    horizontal_line: bool = True
    spacing_after_lines: int = 1


def default_test_instruction_sections() -> list[TestInstructionSectionModel]:
    return [
        TestInstructionSectionModel(
            question_type="multiple_choice",
            title="Multiple Choice",
            instructions="Select the best answer.",
            header_template="{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
        ),
        TestInstructionSectionModel(
            question_type="numeric_response",
            title="Numeric Response",
            instructions="Enter a numeric answer.",
            header_template="{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
        ),
        TestInstructionSectionModel(
            question_type="short_answer",
            title="Short Answer",
            instructions="Write a concise response.",
            header_template="{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
        ),
        TestInstructionSectionModel(
            question_type="free_response",
            title="Free Response",
            instructions="Show your work and justify your answer.",
            header_template="{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
        ),
    ]


def default_test_page_header() -> TestTemplateBlockModel:
    return TestTemplateBlockModel(
        template="{{title}}\nVersion {{version}}    {{date}}",
        alignment="center",
        horizontal_line=True,
        spacing_after_lines=1,
    )


def default_test_name_field() -> TestTemplateBlockModel:
    return TestTemplateBlockModel(
        template="Name: ______________________________",
        alignment="left",
        horizontal_line=False,
        spacing_after_lines=1,
    )


class TestPrintSettingsModel(BaseModel):
    cover_sheet_enabled: bool = True
    cover_sheet_template: str | None = None
    page_header: TestTemplateBlockModel = Field(default_factory=default_test_page_header)
    name_field: TestTemplateBlockModel = Field(default_factory=default_test_name_field)
    typeface: str = "system"
    font_size_pt: int = 11
    margin_in: float = 0.75
    page_size: Literal["letter", "legal", "a4"] = "letter"
    columns: Literal[1, 2, 3] = 1
    name_field_enabled: bool = True
    page_numbers_enabled: bool = True
    default_response_space_lines: int = 0
    instruction_section_options: TestInstructionSectionOptionsModel = Field(
        default_factory=TestInstructionSectionOptionsModel
    )
    instruction_sections: list[TestInstructionSectionModel] = Field(
        default_factory=default_test_instruction_sections
    )


class TestPerformanceItemModel(BaseModel):
    question_id: str
    attempts: int = 0
    correct: int | None = None
    average_score: float | None = None
    observed_difficulty: float | None = None
    tricky: bool = False
    notes: str | None = None


class TestPerformanceRunModel(BaseModel):
    id: str
    administered_at: datetime
    cohort_label: str | None = None
    notes: str | None = None
    item_results: list[TestPerformanceItemModel] = Field(default_factory=list)


class TestDraftModel(BaseModel):
    id: str
    title: str
    version: str = "A"
    # A test can serve more than one course: the same midterm may be reused when
    # a course is retaught, or shared between two courses that overlap.
    course_ids: list[str] = Field(default_factory=list)
    # When set, every version of this test is written to the same response-sheet
    # shape so one stack of sheets serves any version, with the student marking
    # which version they took. Off by default: it constrains item writing, which
    # is the wrong trade for versions that differ on purpose (EL, lower lexile).
    interchangeable_sheets: bool = False
    # Why this version exists -- "shorter passages for EL", "retake". Shown
    # wherever a version is chosen, so the reason travels with the version
    # instead of living in the teacher's head.
    version_description: str | None = None
    items: list[TestItemModel] = Field(default_factory=list)
    print_settings: TestPrintSettingsModel = Field(default_factory=TestPrintSettingsModel)
    performance_runs: list[TestPerformanceRunModel] = Field(default_factory=list)
    # Only finished tests are eligible as response-sheet siblings, so an
    # abandoned same-titled draft can never leak into another version's bubble
    # sheet. Toggling this is never a key-breaking edit.
    finished: bool = False
    # Set once response sheets have actually been generated for this version.
    # From then on, edits that would change the printed answer key/bubble
    # layout (item order/count, correct answers, point values) must fork a new
    # version instead of editing in place.
    has_generated_sheets: bool = False

    @field_validator("course_ids")
    @classmethod
    def normalize_course_ids(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(item.strip() for item in value if item.strip()))

    @field_validator("id", "title", "version")
    @classmethod
    def validate_required_text(cls, value: str, info: ValidationInfo) -> str:
        if not value.strip():
            raise ValueError("field must not be empty")
        return value.strip() if info.field_name == "id" else value


class TestDraftCollectionModel(BaseModel):
    items: list[TestDraftModel] = Field(default_factory=list)


class CreateTestDraftRequest(BaseModel):
    title: str
    version: str = "A"
    course_ids: list[str] = Field(default_factory=list)


class SetTestCoursesRequest(BaseModel):
    course_ids: list[str] = Field(default_factory=list)


class CopyTestDraftRequest(BaseModel):
    """Fork a test draft into a new one.

    Used when a test shared by several courses is edited and the teacher wants
    the other courses to keep the version they actually gave. `source_restore`
    carries the pre-edit snapshot to write back over the original; the copy
    keeps the edits.
    """

    title: str | None = None
    version: str | None = None
    course_ids: list[str] | None = None
    detach_courses_from_source: bool = False
    source_restore: TestDraftModel | None = None


class AddQuestionToTestRequest(BaseModel):
    question_id: str
    experimental: bool = False


class TestStandardBalanceModel(BaseModel):
    standard_id: str
    question_count: int
    average_difficulty: float | None = None
    total_time_estimate_sec: int
    difficulty_counts: dict[str, int] = Field(default_factory=dict)


class TestDraftSummaryModel(BaseModel):
    id: str
    title: str
    version: str
    course_ids: list[str] = Field(default_factory=list)
    standard_ids: list[str] = Field(default_factory=list)
    question_type_counts: dict[str, int] = Field(default_factory=dict)
    difficulty_counts: dict[str, int] = Field(default_factory=dict)
    average_difficulty: float | None = None
    total_time_estimate_sec: int = 0
    standard_balance: list[TestStandardBalanceModel] = Field(default_factory=list)


class TestDraftDetailModel(BaseModel):
    test: TestDraftModel
    summary: TestDraftSummaryModel
    questions: list["QuestionModel"] = Field(default_factory=list)


class TestDraftListResponseModel(BaseModel):
    items: list[TestDraftDetailModel] = Field(default_factory=list)


class UpsertCourseRequest(BaseModel):
    title: str
    description: str | None = None
    standard_refs: list[StandardReferenceModel] = Field(default_factory=list)


class SeedCourseRequest(BaseModel):
    """Pull another course's standards and/or tests into this one.

    Seeding associates rather than copies: an imported test gains the new course
    in its `course_ids`, so one test can report coverage for both the course it
    was written for and the course reusing it.
    """

    source_course_id: str
    include_standards: bool = True
    include_tests: bool = True


class RubricRowModel(BaseModel):
    criterion: str
    points: float
    # This component's own difficulty, named and numbered exactly like
    # QuestionModel.difficulty -- a multipart task's parts are rarely all as hard
    # as each other. Optional, and left null by everything that does not use
    # Rubric Levels: a rubric that was never given difficulties grades exactly as
    # it always did. See grading/mastery.py.
    difficulty: int | None = None

    @field_validator("difficulty")
    @classmethod
    def validate_difficulty(cls, value: int | None) -> int | None:
        # No upper bound: the scale is the bank's to choose, and the mastery
        # calculations take their ceiling from the difficulties actually present.
        if value is not None and value < 1:
            raise ValueError("difficulty must be 1 or greater")
        return value


class ManifestModel(BaseModel):
    schema_version: str
    bank_id: str
    title: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime
    difficulty_labels: dict[str, str] = Field(default_factory=dict)


class BankIndexModel(BaseModel):
    question_ids: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    updated_at: datetime


class QuestionModel(BaseModel):
    id: str
    type: QuestionType
    topic: str
    difficulty: int
    prompt: str
    subtopic: str | None = None
    tags: list[str] = Field(default_factory=list)
    standards: list[StandardReferenceModel] = Field(default_factory=list)
    estimated_time_sec: int | None = None
    points: float | None = None
    status: str = "draft"
    teacher_notes: str | None = None
    answer: dict[str, Any] | None = None
    explanation: str | None = None
    rubric: list[RubricRowModel] = Field(default_factory=list)
    sample_solution: str | None = None
    exemplar_answer: str | None = None
    assets: list[AssetModel] = Field(default_factory=list)

    @field_validator("difficulty")
    @classmethod
    def validate_difficulty(cls, value: int) -> int:
        if value < 1 or value > 5:
            raise ValueError("difficulty must be between 1 and 5")
        return value

    @field_validator("id", "topic", "prompt", "status")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("field must not be empty")
        return text

    @field_validator("standards", mode="before")
    @classmethod
    def normalize_standard_references(cls, value: Any) -> list[dict[str, str]]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("standards must be a list")

        normalized: list[dict[str, str]] = []
        for item in value:
            if isinstance(item, str):
                normalized.append({"standard_id": item})
            elif isinstance(item, dict) and isinstance(item.get("standard_id"), str):
                normalized.append({"standard_id": item["standard_id"]})
            else:
                raise ValueError("standards entries must be standard references")
        return normalized

    @model_validator(mode="after")
    def validate_question_shape(self) -> "QuestionModel":
        if self.type == "multiple_choice":
            answer = dict(self.answer or {})
            choices = answer.get("choices")
            if not isinstance(choices, list) or len(choices) < 2:
                raise ValueError("multiple_choice questions need at least two choices")
            correct_indices = answer.get("correct_choice_indices")
            correct_index = answer.get("correct_choice_index")
            if correct_indices is not None:
                if not isinstance(correct_indices, list) or not all(
                    type(index) is int for index in correct_indices
                ):
                    raise ValueError(
                        "multiple_choice correct_choice_indices must be a list of integers"
                    )
                if any(index < 0 or index >= len(choices) for index in correct_indices):
                    raise ValueError("multiple_choice correct_choice_indices must reference choices")

                # A repeated index carries no extra meaning, and a single index is
                # just a single-answer question written the long way. Normalize both
                # so question JSON written by another tool imports cleanly, matching
                # what the question form already does when it builds an answer.
                unique_indices = sorted(dict.fromkeys(correct_indices))
                if not unique_indices:
                    raise ValueError(
                        "multiple_choice correct_choice_indices must reference at least one choice"
                    )

                answer.pop("correct_choice_index", None)
                answer.pop("correct_choice_indices", None)
                if len(unique_indices) == 1:
                    answer["correct_choice_index"] = unique_indices[0]
                else:
                    answer["correct_choice_indices"] = unique_indices
            elif type(correct_index) is not int:
                raise ValueError(
                    "multiple_choice questions need a correct_choice_index or correct_choice_indices"
                )
            elif correct_index < 0 or correct_index >= len(choices):
                raise ValueError("multiple_choice correct_choice_index must reference a choice")

            choice_assets = answer.get("choice_assets")
            normalized_choice_assets: dict[str, dict[str, Any]] = {}
            if choice_assets is not None:
                if not isinstance(choice_assets, dict):
                    raise ValueError(
                        "multiple_choice choice_assets must be a mapping of choice index to asset"
                    )
                for key, value in choice_assets.items():
                    if not isinstance(key, str) or not key.isdigit():
                        raise ValueError(
                            "multiple_choice choice_assets keys must be numeric choice indices"
                        )
                    index = int(key)
                    if index < 0 or index >= len(choices):
                        raise ValueError("multiple_choice choice_assets must reference a choice")
                    normalized_choice_assets[key] = AssetModel.model_validate(value).model_dump()

            # A choice needs something to show a student: either its own text or
            # an attached image. Neither is required on top of the other, since
            # forcing a text label on an image-only choice (e.g. one of several
            # diagram options) is pure authoring overhead with nothing to show for it.
            for index, choice in enumerate(choices):
                has_text = isinstance(choice, str) and choice.strip() != ""
                has_image = str(index) in normalized_choice_assets
                if not has_text and not has_image:
                    raise ValueError(f"choice {index + 1} needs text or an image")

            if normalized_choice_assets:
                answer["choice_assets"] = normalized_choice_assets
            else:
                answer.pop("choice_assets", None)
            self.answer = answer
        elif self.type == "numeric_response":
            answer = self.answer or {}
            if "value" not in answer:
                raise ValueError("numeric_response questions need an answer value")
            if "tolerance" not in answer:
                raise ValueError("numeric_response questions need an answer tolerance")
        elif self.type == "short_answer":
            if not (self.sample_solution or "").strip():
                raise ValueError("short_answer questions need a sample_solution")
        elif self.type == "free_response":
            if not self.rubric:
                raise ValueError("free_response questions need at least one rubric row")
        return self


class OpenBankRequest(BaseModel):
    path: str


class SaveBankRequest(BaseModel):
    destination_path: str | None = None


class CreateBankRequest(BaseModel):
    title: str
    description: str | None = None
    destination_path: str


class UpdateBankDetailsRequest(BaseModel):
    title: str
    description: str | None = None


class CreateQuestionRequest(BaseModel):
    template_question_id: str | None = None


class CreateQuestionsFromJsonRequest(BaseModel):
    questions: list[dict[str, Any]] = Field(default_factory=list)


class CreateQuestionsFromJsonResponse(BaseModel):
    items: list["QuestionModel"] = Field(default_factory=list)


class NextQuestionIdResponse(BaseModel):
    id: str


class BankSummaryModel(BaseModel):
    source_path: str
    workspace_path: str
    manifest: ManifestModel
    bank: BankIndexModel


class QuestionListItemModel(BaseModel):
    id: str
    topic: str
    type: QuestionType
    difficulty: int
    status: str
    prompt: str
    choice_preview: list[str] = Field(default_factory=list)
    subtopic: str | None = None
    standards: list[StandardReferenceModel] = Field(default_factory=list)


class QuestionListResponseModel(BaseModel):
    items: list[QuestionListItemModel]
    available_topics: list[str]
    available_types: list[str]


# ---------------------------------------------------------------------------
# Gradebook (.nxgb) models
#
# A gradebook is a separate local package from a bank (.bok): it holds roster
# and, in later phases, scan/score data that must never ride along inside a
# bank shared between teachers. See docs/grading-plan.md.
# ---------------------------------------------------------------------------


class GradebookManifestModel(BaseModel):
    schema_version: str
    gradebook_id: str
    title: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime


class GradebookSummaryModel(BaseModel):
    source_path: str
    workspace_path: str
    manifest: GradebookManifestModel


class OpenGradebookRequest(BaseModel):
    path: str


class CreateGradebookRequest(BaseModel):
    title: str
    description: str | None = None
    destination_path: str


class SaveGradebookRequest(BaseModel):
    destination_path: str | None = None


class UpdateGradebookDetailsRequest(BaseModel):
    title: str
    description: str | None = None


class StudentModel(BaseModel):
    """A roster entry. Lives only inside a gradebook, never inside a bank.

    Deliberately minimal -- no SIS import, no attendance, no grade history of
    its own. Grade history is computed from scan batches, not stored here.
    """

    id: str
    first_name: str
    last_name: str
    external_id: str | None = None
    # Which class this student is in -- used to generate response sheets for one
    # section without pulling in every other section on the roster.
    section: str | None = None
    # A free grouping: intervention group, accommodation, whichever version of a
    # modified test this student should get. Filterable the same way.
    grouping: str | None = None

    @field_validator("id", "first_name", "last_name")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("field must not be empty")
        return text


class StudentCollectionModel(BaseModel):
    items: list[StudentModel] = Field(default_factory=list)


class UpsertStudentRequest(BaseModel):
    first_name: str
    last_name: str
    external_id: str | None = None
    section: str | None = None
    grouping: str | None = None


class StudentListResponseModel(BaseModel):
    items: list[StudentModel] = Field(default_factory=list)


SheetRowKind = Literal["multiple_choice", "numeric_response", "manual_capture"]


class AnswerKeyItemModel(BaseModel):
    """One question item's grading key, derived at hand-off time.

    `test_item_number` counts every question item in printed order (matches
    the booklet's question numbering); `sheet_item_number` counts every
    question item that gets a row on the response sheet. All three row kinds
    get a sheet row today, so the two counters currently agree, but they are
    kept distinct in case a future question type is excluded from the sheet.
    """

    question_id: str
    test_item_number: int
    sheet_item_number: int
    row_kind: SheetRowKind
    points: float
    # Carried on the frozen key itself (not looked up from the bank later) so
    # by-standard reporting works even if the bank isn't open anymore.
    standard_ids: list[str] = Field(default_factory=list)
    # QuestionModel.difficulty, 1 (easy) to 5 (hard), frozen here for the same
    # reason as standard_ids: the difficulty-weighted mastery estimate has to be
    # computable from the snapshot alone, and an alternate version's key carries
    # no questions of its own to look it up from. None on keys frozen before
    # this field existed -- see grading/aggregate.py for the fallback.
    difficulty: int | None = None
    # The question's rubric, frozen with its levels, so a Rubric Levels report
    # ladders the components as they were written at hand-off. Empty for
    # auto-graded rows and for questions with no rubric.
    rubric_components: list[RubricRowModel] = Field(default_factory=list)
    choice_count: int | None = None
    correct_choice_indices: list[int] | None = None
    numeric_value: float | None = None
    numeric_tolerance: float | None = None
    grid_digits: int | None = None
    allow_decimal: bool = False
    allow_negative: bool = False


class AnswerKeyModel(BaseModel):
    test_id: str
    version: str
    items: list[AnswerKeyItemModel] = Field(default_factory=list)
    total_points: float


class FiducialMarkerModel(BaseModel):
    corner: Literal["top_left", "top_right", "bottom_left", "bottom_right"]
    shape: Literal["square", "circle"]
    center_x_pt: float
    center_y_pt: float
    size_pt: float


class BubbleCellModel(BaseModel):
    """One fillable bubble. `value` is a choice index for multiple_choice rows,
    or a digit 0-9 (or -1/-2 for a sign/decimal-point bubble) for numeric_response rows."""

    value: int
    center_x_pt: float
    center_y_pt: float
    radius_pt: float


class CaptureBoxModel(BaseModel):
    x_pt: float
    y_pt: float
    width_pt: float
    height_pt: float


class SheetRowModel(BaseModel):
    question_id: str
    test_item_number: int
    sheet_item_number: int
    kind: SheetRowKind
    label_x_pt: float
    label_y_pt: float
    # multiple_choice: one cell per choice. numeric_response: one column of
    # cells (values 0-9, plus -1 for a sign bubble / -2 for a decimal point)
    # per digit position, columns laid out left to right.
    cells: list[BubbleCellModel] = Field(default_factory=list)
    digit_columns: int | None = None
    # manual_capture only.
    capture_box: CaptureBoxModel | None = None


class SheetPageModel(BaseModel):
    page_index: int
    fiducials: list[FiducialMarkerModel] = Field(default_factory=list)
    qr_box: CaptureBoxModel
    qr_payload: str
    # name_box is always present; printed_name is set only in "pre_id" mode.
    # A renderer draws a blank line in name_box when printed_name is absent,
    # or centers printed_name inside that same box when it's present.
    name_box: CaptureBoxModel | None = None
    printed_name: str | None = None
    # Who this copy was printed for, in "pre_id" mode. Kept here rather than in
    # the QR: the sheet is paper that leaves the building, and the roster id it
    # would have carried is the same one an export keys on.
    student_id: str | None = None
    # Present only on interchangeable sheets, and only on the first page: one
    # bubble per version, filled by the student to say which paper they got.
    version_row: SheetRowModel | None = None
    rows: list[SheetRowModel] = Field(default_factory=list)


class SheetLayoutModel(BaseModel):
    """One frozen geometry template, in PDF points, for one printed sheet.

    Generation and detection both read this same object -- generation draws
    at these coordinates, detection expects marks at these coordinates after
    perspective correction. It is captured at hand-off time and embedded in
    an AdministeredTestSnapshotModel, never recomputed from a live test
    draft, so a bank edit after printing cannot silently misalign a sheet
    that is already on paper.
    """

    id: str
    mode: Literal["blank", "pre_id"]
    page_size: Literal["letter", "legal", "a4", "half_letter"]
    page_width_pt: float
    page_height_pt: float
    # Printed at the top of every page. Response sheets are often handed out
    # separately from the test paper, and a sheet filled against the wrong
    # version scores as wrong answers rather than as an obvious mistake, so the
    # sheet says which test and version it belongs to. Frozen with the rest of
    # the layout: it describes the paper that was actually handed out.
    header_label: str | None = None
    # Version labels in bubble order, matching version_row's cell values. Empty
    # on a version-specific sheet, which needs no bubble.
    version_labels: list[str] = Field(default_factory=list)
    pages: list[SheetPageModel] = Field(default_factory=list)


class AdministeredTestSnapshotModel(BaseModel):
    """A frozen copy of exactly what was printed and handed to students.

    Captured once, at hand-off time, from the bank that was open at that
    moment. Never edited in place -- a later re-print creates a new snapshot
    with a new id and printed_at, so a gradebook can always show what WAS
    given on a given date even if the source bank's test has since changed
    or is gone.
    """

    id: str
    source_bank_title: str | None = None
    source_test_id: str
    title: str
    version: str
    printed_at: datetime
    items: list[TestItemModel]
    questions: list["QuestionModel"]
    # Frozen alongside items/questions so the test paper itself -- not just the
    # bubble sheet -- can be printed from the gradebook later without needing
    # the source bank open.
    print_settings: TestPrintSettingsModel
    answer_key: AnswerKeyModel
    # Keys for the other versions of this test, present only for interchangeable
    # sheets. Scoring picks by the version the student bubbled; `answer_key`
    # stays the version this paper was printed from.
    alternate_answer_keys: list[AnswerKeyModel] = Field(default_factory=list)
    layout: SheetLayoutModel
    # Shared by every version's snapshot produced from one version-assignment
    # generation run, so they can be grouped/printed together. None for
    # snapshots created before this existed, or via the single-version path.
    generation_batch_id: str | None = None
    # Which test lineage this printing belongs to -- the link that makes two
    # snapshots count as first attempt and retake of the same test rather than
    # two unrelated tests. Defaulted from the title (see grading/lineage.py) so
    # snapshots created before this field existed, and versions of one test,
    # group together with no teacher action. Set explicitly to link a retake
    # that was titled differently, or to split one that shouldn't be linked.
    lineage_id: str | None = None


class AdministeredTestSnapshotCollectionModel(BaseModel):
    items: list[AdministeredTestSnapshotModel] = Field(default_factory=list)


class AdministeredTestSnapshotSummaryModel(BaseModel):
    """A lightweight listing row -- omits the frozen items/questions payload."""

    id: str
    layout_id: str
    source_bank_title: str | None = None
    source_test_id: str
    title: str
    version: str
    printed_at: datetime
    total_points: float
    page_count: int
    mode: Literal["blank", "pre_id"]
    # Always resolved, never None: falls back to the title-derived id for
    # snapshots that carry no explicit link. See grading/lineage.py.
    lineage_id: str = ""


class AdministeredTestSnapshotListResponseModel(BaseModel):
    items: list[AdministeredTestSnapshotSummaryModel] = Field(default_factory=list)


class CreateAdministeredTestRequest(BaseModel):
    test_id: str
    mode: Literal["blank", "pre_id"] = "blank"
    page_size: Literal["letter", "legal", "a4", "half_letter"] = "letter"
    blank_count: int | None = None
    student_ids: list[str] | None = None


class ResponseSheetVersionAssignmentModel(BaseModel):
    """One version's share of a batch-generation call.

    In `pre_id` mode, `student_ids` names who takes this version -- a partial
    roster is fine, since a teacher may only be printing for the students
    present today. In `blank` mode, `blank_count` is how many unnamed copies
    of this version to print instead.
    """

    version: str
    student_ids: list[str] = Field(default_factory=list)
    blank_count: int | None = None


class CreateResponseSheetBatchRequest(BaseModel):
    """Generate response sheets across several versions of one lineage at once.

    Each assignment gets its own dedicated (non-interchangeable) sheet -- the
    teacher already knows which version each student is taking, so there's no
    need for the "mark your version" generic sheet `interchangeable_sheets`
    produces for the single-version endpoint.
    """

    mode: Literal["blank", "pre_id"] = "pre_id"
    page_size: Literal["letter", "legal", "a4", "half_letter"] = "letter"
    assignments: list[ResponseSheetVersionAssignmentModel]


DetectionFlag = Literal["none", "low_confidence", "multi_mark", "no_mark"]

IdentityStatus = Literal[
    "pre_identified", "unresolved", "manually_resolved", "qr_unreadable", "wrong_snapshot"
]


class DetectedRowResultModel(BaseModel):
    """One row's read result. multiple_choice/numeric_response rows get a
    confidence score and flag from the fill-ratio detector; manual_capture
    rows never get an automated read -- they always need a human score.

    `override_*` sits alongside the raw detection rather than replacing it,
    so an audit or a re-score after a threshold change never loses the
    detector's original reading.
    """

    question_id: str
    sheet_item_number: int
    kind: SheetRowKind

    detected_choice_indices: list[int] = Field(default_factory=list)
    detected_digits: str | None = None
    detected_value: float | None = None
    confidence: float | None = None
    flag: DetectionFlag = "none"
    # Set when a human confirms the student answered nothing here. Students
    # skip questions, so an empty row is a valid reading that should clear
    # review -- distinct from a row nobody has looked at yet, which is what an
    # absent override means.
    override_blank: bool = False

    needs_manual_grade: bool = False
    manual_score: float | None = None
    manual_score_max: float | None = None
    manual_grader_note: str | None = None
    # One score per frozen rubric component, in the key's order. Set only when a
    # grader scored the parts separately; `manual_score` stays the row's total
    # either way, so every existing report keeps working whether or not the
    # parts were broken out. Rubric Levels is the one report that needs them.
    component_scores: list[float] | None = None

    override_choice_indices: list[int] | None = None
    override_value: float | None = None
    override_note: str | None = None


class ScannedSheetModel(BaseModel):
    id: str
    snapshot_id: str | None = None
    layout_id: str | None = None
    sheet_id: str | None = None
    source_image_path: str
    page_index: int = 0
    student_id: str | None = None
    free_text_name: str | None = None
    identity_status: IdentityStatus
    fiducial_confidence: float | None = None
    # Which version the student marked, on an interchangeable sheet.
    detected_version: str | None = None
    row_results: list[DetectedRowResultModel] = Field(default_factory=list)
    needs_review: bool = False


class GradingBatchModel(BaseModel):
    id: str
    snapshot_id: str
    created_at: datetime
    source_description: str | None = None
    sheets: list[ScannedSheetModel] = Field(default_factory=list)


class GradingBatchCollectionModel(BaseModel):
    items: list[GradingBatchModel] = Field(default_factory=list)


class CreateScanBatchRequest(BaseModel):
    snapshot_id: str
    source_description: str | None = None


class GradingBatchListResponseModel(BaseModel):
    items: list[GradingBatchModel] = Field(default_factory=list)


class ReassignSheetRequest(BaseModel):
    """Match a scan to a printing by hand when its QR could not be read."""

    snapshot_id: str
    page_index: int = 0


class ResolveSheetIdentityRequest(BaseModel):
    student_id: str | None = None
    free_text_name: str | None = None


class OverrideRowResultRequest(BaseModel):
    """MC/numeric rows take override_choice_indices or override_value;
    manual_capture rows take manual_score. A caller sends only the fields
    that apply to the row's kind -- the rest stay None."""

    override_choice_indices: list[int] | None = None
    override_value: float | None = None
    override_blank: bool | None = None
    override_note: str | None = None
    manual_score: float | None = None
    manual_score_max: float | None = None
    manual_grader_note: str | None = None
    component_scores: list[float] | None = None


class ChoiceDistributionEntryModel(BaseModel):
    choice_index: int
    count: int


class GradeReportItemModel(BaseModel):
    question_id: str
    sheet_item_number: int
    row_kind: SheetRowKind
    standard_ids: list[str] = Field(default_factory=list)
    attempts: int
    full_credit_count: int
    percent_full_credit: float
    choice_distribution: list[ChoiceDistributionEntryModel] = Field(default_factory=list)
    flagged_count: int = 0


class GradeReportStandardModel(BaseModel):
    """`code`/`statement` are left blank -- the snapshot only carries
    standard ids, not the bank's descriptive text, so a report stays
    computable even when the source bank isn't open."""

    standard_id: str
    code: str | None = None
    statement: str | None = None
    attempts: int
    full_credit_count: int
    percent_full_credit: float


class StudentScoreModel(BaseModel):
    sheet_id: str
    student_id: str | None = None
    student_display_name: str | None = None
    points_earned: float
    points_possible: float
    percent_correct: float
    flagged_answer_count: int


class ExcludedSheetModel(BaseModel):
    """A sheet the report could not score, and why.

    A bare count told the teacher something was wrong without telling them what,
    and the reasons are not always visible on the sheet itself -- resolving an
    identity, for instance, overwrites the status that said the QR was never
    read. These are derived from the sheet's own fields so they stay true no
    matter what has been edited since.
    """

    sheet_id: str
    student_display_name: str | None = None
    reasons: list[str] = Field(default_factory=list)


class GradeReportModel(BaseModel):
    batch_id: str
    snapshot_id: str
    test_title: str
    version: str
    generated_at: datetime
    scored_sheet_count: int
    excluded_sheet_count: int
    excluded_sheets: list[ExcludedSheetModel] = Field(default_factory=list)
    total_possible_points: float
    average_percent_correct: float
    score_histogram: dict[str, int] = Field(default_factory=dict)
    by_standard: list[GradeReportStandardModel] = Field(default_factory=list)
    by_item: list[GradeReportItemModel] = Field(default_factory=list)
    student_scores: list[StudentScoreModel] = Field(default_factory=list)
    contains_unscored_manual_items: bool = False


class CombinedGradeReportModel(BaseModel):
    """One test lineage's score-by-standard, combined across every version's
    batches in this gradebook.

    Sums attempts/full_credit_count across versions rather than taking the max:
    course coverage avoids double-counting how many times a standard is
    *taught*, but a score report is real, distinct student attempts per version,
    so summing is the correct aggregation here.

    Grouped by `lineage_id` when the caller names one, which is what makes a
    retake linked in under a different title count toward the test it retakes.
    Grouping by title is still supported for callers that only know the title.
    """

    test_title: str
    lineage_id: str = ""
    snapshot_ids: list[str] = Field(default_factory=list)
    batch_ids: list[str] = Field(default_factory=list)
    scored_sheet_count: int
    by_standard: list[GradeReportStandardModel] = Field(default_factory=list)


class RecordPerformanceRunRequest(BaseModel):
    cohort_label: str | None = None


# ---------------------------------------------------------------------------
# Mastery levels
#
# Two words, one numbering, used consistently throughout:
#
#   difficulty  what an author assigns to a question or rubric component
#   level       a rung on the mastery ladder, which a student reaches
#
# A question's difficulty is the level it gives evidence about, so the two share
# a scale -- but they are not the same thing, and only one of them is a claim
# about a student.
#
# Mastery is reported as a *level*, not a percentage. "2.50" means the student
# has shown Level 2 and is halfway through Level 3 -- a different quantity from
# "50% correct", and the one a standards-based gradebook actually reports.
#
# Three calculations, one rounding choice, chosen per gradebook and overridable
# per test. See grading/mastery.py for the formulas and docs/grading.md.
# ---------------------------------------------------------------------------


MasteryCalculation = Literal["level_ladder", "difficulty_weighted", "rubric_levels"]

MasteryReporting = Literal["exact", "half_steps"]


class MasterySettingsModel(BaseModel):
    """Level Ladder + Half Steps is the default: the ladder is what a
    standards-based report means by mastery, and half steps stop a 1.33 from
    reading as more precision than one test's worth of evidence supports."""

    calculation: MasteryCalculation = "level_ladder"
    reporting: MasteryReporting = "half_steps"


class GradebookMasteryConfigModel(BaseModel):
    """The gradebook's default, plus per-test overrides keyed by lineage id.

    Per *lineage*, not per printing: every version of a test, and any retake
    linked to it, is the same assessment and must be scored the same way.
    """

    default: MasterySettingsModel = Field(default_factory=MasterySettingsModel)
    by_lineage: dict[str, MasterySettingsModel] = Field(default_factory=dict)

    def for_lineage(self, lineage_id: str | None) -> MasterySettingsModel:
        if lineage_id and lineage_id in self.by_lineage:
            return self.by_lineage[lineage_id]
        return self.default


class UpdateMasterySettingsRequest(BaseModel):
    """A null field means "leave that half alone"; a null body on the per-test
    route means "drop the override and follow the gradebook default"."""

    calculation: MasteryCalculation | None = None
    reporting: MasteryReporting | None = None


class MasteryLevelBreakdownModel(BaseModel):
    """One level's worth of evidence, and whether it was mastered."""

    level: int
    points_earned: float
    points_possible: float
    accuracy: float
    mastered: bool


class MasteryResultModel(BaseModel):
    """`level` is what to display -- already rounded by the reporting mode.
    `level_exact` is the raw calculation, kept so an export can ask for full
    precision without recomputing, and so rounding is visible rather than
    baked in."""

    calculation: MasteryCalculation
    reporting: MasteryReporting
    level: float
    level_exact: float
    # The highest level the evidence actually reaches, so "2.5" can be shown as
    # "2.5 of 4" rather than leaving the reader to guess the ceiling.
    scale_max: int
    levels: list[MasteryLevelBreakdownModel] = Field(default_factory=list)
    # A level above the first unmastered one was nonetheless mastered. Not
    # discarded -- surfaced, because it usually means the level labels are
    # wrong rather than that the student is.
    inconsistent_evidence: bool = False
    # The levels present skip a rung (or do not start at 1), so the ladder is
    # standing on incomplete evidence. Difficulty Weighted is the better mode
    # for such a test.
    has_level_gaps: bool = False
    # Rubric Levels was asked for but no component carried a level, so this fell
    # back to laddering whole questions.
    components_unavailable: bool = False


# ---------------------------------------------------------------------------
# Cross-test student performance and CSV export
#
# Everything below is *derived*: nothing here is persisted. A gradebook stores
# snapshots and scan batches; scores are recomputed from them on demand, so a
# review correction or a re-linked retake shows up everywhere at once with no
# stored total to go stale. See docs/grading.md.
# ---------------------------------------------------------------------------


RetakeResolution = Literal["most_recent", "highest", "average"]

ScoreExportMethod = Literal["total", "by_standard", "mastery"]


class StudentStandardScoreModel(BaseModel):
    """One standard's worth of one student's work.

    Two different questions, answered separately. `percent_earned` is plain
    points earned over points possible -- how much of the work was right.
    `mastery` is a *level* -- how far up the mastery ladder the evidence
    reaches. A student can score 50% and be at Level 1.5 or at Level 3.2
    depending on which questions they got right, which is the whole reason both
    are reported. See grading/mastery.py.
    """

    standard_id: str
    items_attempted: int
    items_full_credit: int
    points_earned: float
    points_possible: float
    percent_earned: float
    average_difficulty: float
    mastery: MasteryResultModel


class StudentAttemptModel(BaseModel):
    """One student's one sitting of one test -- a single scored sheet.

    `attempt_number` counts within (student, lineage) in the order the papers
    were printed, so the second time a student sits the same test it reads as
    attempt 2 whether or not anyone called it a retake.
    """

    lineage_id: str
    test_title: str
    version: str
    snapshot_id: str
    batch_id: str
    sheet_id: str
    attempt_number: int
    printed_at: datetime
    scanned_at: datetime
    points_earned: float
    points_possible: float
    percent_correct: float
    flagged_answer_count: int
    contains_unscored_manual_items: bool
    by_standard: list[StudentStandardScoreModel] = Field(default_factory=list)


class ResolvedLineageScoreModel(BaseModel):
    """The one score a lineage contributes once retakes are resolved.

    `most_recent` and `highest` pick a real attempt and carry its numbers
    through unchanged. `average` synthesises one: the mean of the attempts'
    percentages (not pooled points -- a teacher who says "average the retakes"
    means the average of the scores, regardless of how many points each paper
    was out of).
    """

    resolution: RetakeResolution
    attempt_count: int
    # Which attempt(s) the numbers came from: one entry for most_recent/highest,
    # every attempt for average.
    source_attempt_numbers: list[int] = Field(default_factory=list)
    points_earned: float
    points_possible: float
    percent_correct: float
    by_standard: list[StudentStandardScoreModel] = Field(default_factory=list)


class StudentLineagePerformanceModel(BaseModel):
    lineage_id: str
    test_title: str
    attempts: list[StudentAttemptModel] = Field(default_factory=list)
    resolved: ResolvedLineageScoreModel


class StudentPerformanceModel(BaseModel):
    """Everything one student has taken in this gradebook, in one object.

    `by_standard` pools the *resolved* per-lineage standard entries, so a
    retake counts once under whichever rule was asked for rather than dragging
    the student's standard history down with a superseded first try.
    """

    student: StudentModel
    tests_taken: int
    attempt_count: int
    points_earned: float
    points_possible: float
    percent_correct: float
    unscored_manual_attempt_count: int
    by_standard: list[StudentStandardScoreModel] = Field(default_factory=list)
    lineages: list[StudentLineagePerformanceModel] = Field(default_factory=list)


class StudentPerformanceListResponseModel(BaseModel):
    generated_at: datetime
    retake_resolution: RetakeResolution
    # The gradebook default. Individual tests may override it, in which case
    # each lineage's own entries carry the mode they were scored under.
    mastery: MasterySettingsModel = Field(default_factory=MasterySettingsModel)
    items: list[StudentPerformanceModel] = Field(default_factory=list)
    # Scored sheets that could not be attached to anyone on the roster (a
    # hand-written name that was never resolved to a student). They are absent
    # from every total above, so the caller can say so rather than quietly
    # under-reporting.
    unlinked_sheet_count: int = 0


class RelinkSnapshotLineageRequest(BaseModel):
    """Move a printing into another lineage, or back to its title's default.

    Passing another snapshot's id is the usual way in: "this retake is the same
    test as that one." Passing null clears the explicit link so the title
    decides again.
    """

    lineage_of_snapshot_id: str | None = None
    lineage_id: str | None = None
