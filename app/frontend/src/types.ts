export type QuestionType =
  | "multiple_choice"
  | "numeric_response"
  | "short_answer"
  | "free_response";

export interface AssetModel {
  path: string;
  kind: string;
  svg_variables: Record<string, string>;
}

export interface AssetUploadResponseModel {
  path: string;
  kind: string;
}

export interface AssetInspectionResponseModel {
  path: string;
  kind: string;
  svg_placeholders: string[];
  rendered_svg?: string | null;
}

export interface AssetInspectionBatchRequestItem {
  path: string;
  kind: string;
  svg_variables: Record<string, string>;
}

export interface AssetInspectionBatchResponseModel {
  items: AssetInspectionResponseModel[];
}

export interface AssetListItemModel {
  path: string;
  kind: string;
  referenced_by: string[];
  svg_placeholders: string[];
}

export interface AssetListResponseModel {
  items: AssetListItemModel[];
}

export interface StandardReferenceModel {
  standard_id: string;
}

export interface SourceStandardListModel {
  id: string;
  title: string;
  issuer: string;
  subject?: string | null;
  version?: string | null;
  description?: string | null;
  imported_at: string;
}

export interface StandardRecordModel {
  id: string;
  source_list_id: string;
  code: string;
  statement: string;
  subject?: string | null;
  strand?: string | null;
  grade_band?: string | null;
  tags: string[];
}

export interface StandardListResponseModel {
  items: SourceStandardListModel[];
}

export interface StandardSearchResponseModel {
  items: StandardRecordModel[];
}

export interface CourseModel {
  id: string;
  title: string;
  description?: string | null;
  standard_refs: StandardReferenceModel[];
}

export interface CourseListResponseModel {
  items: CourseModel[];
}

export interface CourseStandardCoverageModel {
  standard_id: string;
  code?: string | null;
  statement?: string | null;
  source_list_id?: string | null;
  strand?: string | null;
  in_course: boolean;
  question_count: number;
  test_count: number;
  test_ids: string[];
}

/** One test lineage: every version of a test reported as a single test, so
 *  versions made for security or retakes do not multiply coverage. */
export interface CourseTestSummaryModel {
  test_id: string;
  title: string;
  version: string;
  versions: string[];
  test_ids: string[];
  /** The largest version, not the sum across versions. */
  question_count: number;
  course_standard_count: number;
  extra_standard_count: number;
}

export interface CourseDetailModel {
  course: CourseModel;
  tests: CourseTestSummaryModel[];
  covered_standards: CourseStandardCoverageModel[];
  uncovered_standards: CourseStandardCoverageModel[];
  extra_standards: CourseStandardCoverageModel[];
  question_count: number;
}

export interface StandardImportResponseModel {
  source_list: SourceStandardListModel;
  source_lists: SourceStandardListModel[];
  imported_count: number;
  imported_path?: string | null;
}

export interface DetectedImportSourceModel {
  id?: string | null;
  title?: string | null;
  issuer?: string | null;
  subject?: string | null;
  version?: string | null;
  description?: string | null;
  standard_count: number;
  matches_existing_source: boolean;
  complete: boolean;
}

export interface StandardImportInspectionModel {
  filename: string;
  total_rows: number;
  rows_with_source: number;
  detected_sources: DetectedImportSourceModel[];
  needs_source_input: boolean;
  detected_columns: string[];
}

export interface ManualStandardRowModel {
  id: string;
  code?: string | null;
  statement: string;
  subject?: string | null;
  strand?: string | null;
  grade_band?: string | null;
  tags: string[];
  source_list_id?: string | null;
  source_title?: string | null;
  source_issuer?: string | null;
  source_subject?: string | null;
  source_version?: string | null;
  source_description?: string | null;
}

export interface CreateStandardsManuallyRequest {
  source_list_id?: string | null;
  title?: string | null;
  issuer?: string | null;
  subject?: string | null;
  version?: string | null;
  description?: string | null;
  standards: ManualStandardRowModel[];
}

export interface CreateQuestionsFromJsonResponse {
  items: QuestionModel[];
}

export interface RubricRowModel {
  criterion: string;
  points: number;
}

export interface ManifestModel {
  schema_version: string;
  bank_id: string;
  title: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
  difficulty_labels: Record<string, string>;
}

export interface BankIndexModel {
  question_ids: string[];
  topics: string[];
  updated_at: string;
}

export interface BankSummaryModel {
  source_path: string;
  workspace_path: string;
  manifest: ManifestModel;
  bank: BankIndexModel;
}

export interface QuestionModel {
  id: string;
  type: QuestionType;
  topic: string;
  difficulty: number;
  prompt: string;
  subtopic?: string | null;
  tags: string[];
  standards: StandardReferenceModel[];
  estimated_time_sec?: number | null;
  points?: number | null;
  status: string;
  teacher_notes?: string | null;
  answer?: Record<string, unknown> | null;
  explanation?: string | null;
  rubric: RubricRowModel[];
  sample_solution?: string | null;
  exemplar_answer?: string | null;
  assets: AssetModel[];
}

export interface QuestionListItemModel {
  id: string;
  topic: string;
  type: QuestionType;
  difficulty: number;
  status: string;
  prompt: string;
  choice_preview: string[];
  subtopic?: string | null;
  standards: StandardReferenceModel[];
}

export interface QuestionListResponseModel {
  items: QuestionListItemModel[];
  available_topics: string[];
  available_types: string[];
}

export interface QuestionImportValidationIssueModel {
  code: string;
  message: string;
  location: Array<string | number>;
  severity?: "error" | "warning";
}

export interface QuestionImportRowModel {
  row_id: string;
  source_index: number;
  source: Record<string, unknown>;
  question: Record<string, unknown>;
  proposed_id?: string | null;
  imported_id?: string | null;
  promoted_question_id?: string | null;
  status: "valid" | "invalid" | "promoted";
  selected: boolean;
  issues: QuestionImportValidationIssueModel[];
}

export interface QuestionImportStageModel {
  id: string;
  source_filename: string;
  source_path: string;
  created_at: string;
  rows: QuestionImportRowModel[];
}

export interface QuestionImportListResponseModel {
  items: QuestionImportStageModel[];
}

export interface QuestionImportPromoteResponseModel {
  import_id: string;
  promoted_count: number;
  promoted_question_ids: string[];
  stage: QuestionImportStageModel;
}

export interface TestItemModel {
  item_type?: "question" | "section";
  question_id?: string | null;
  experimental?: boolean;
  response_space_lines?: number | null;
  teacher_notes?: string | null;
  section_id?: string | null;
  question_type?: QuestionType | null;
  title?: string | null;
  instructions?: string | null;
  header_template?: string | null;
  topic?: string | null;
  standards?: string[];
  suggested_time_mode?: "calculated" | "override";
  suggested_time_sec?: number | null;
}

export interface TestInstructionSectionModel {
  question_type: QuestionType;
  title: string;
  instructions: string;
  header_template?: string | null;
  show_topic: boolean;
  show_standards: boolean;
  show_suggested_time: boolean;
  suggested_time_mode: "calculated" | "override";
  suggested_time_sec?: number | null;
}

export interface TestTemplateBlockModel {
  template: string;
  alignment: "left" | "center" | "right";
  horizontal_line: boolean;
  spacing_after_lines: number;
}

export interface TestInstructionSectionOptionsModel {
  show_topic: boolean;
  show_standards: boolean;
  show_suggested_time: boolean;
  alignment: "left" | "center" | "right";
  horizontal_line: boolean;
  spacing_after_lines: number;
}

export interface TestPrintSettingsModel {
  cover_sheet_enabled: boolean;
  cover_sheet_template?: string | null;
  page_header: TestTemplateBlockModel;
  name_field: TestTemplateBlockModel;
  typeface: string;
  font_size_pt: number;
  margin_in: number;
  page_size: "letter" | "legal" | "a4";
  columns: 1 | 2 | 3;
  name_field_enabled: boolean;
  page_numbers_enabled: boolean;
  default_response_space_lines: number;
  instruction_section_options: TestInstructionSectionOptionsModel;
  instruction_sections: TestInstructionSectionModel[];
}

export interface TestPerformanceItemModel {
  question_id: string;
  attempts: number;
  correct?: number | null;
  average_score?: number | null;
  observed_difficulty?: number | null;
  tricky: boolean;
  notes?: string | null;
}

export interface TestPerformanceRunModel {
  id: string;
  administered_at: string;
  cohort_label?: string | null;
  notes?: string | null;
  item_results: TestPerformanceItemModel[];
}

export interface TestDraftModel {
  id: string;
  title: string;
  version: string;
  course_ids: string[];
  /** One sheet shape across every version, version marked by the student. */
  interchangeable_sheets?: boolean;
  /** Why this version exists -- shown wherever a version is chosen. */
  version_description?: string | null;
  items: TestItemModel[];
  print_settings: TestPrintSettingsModel;
  performance_runs: TestPerformanceRunModel[];
}

export interface TestStandardBalanceModel {
  standard_id: string;
  question_count: number;
  average_difficulty?: number | null;
  total_time_estimate_sec: number;
  difficulty_counts: Record<string, number>;
}

export interface TestDraftSummaryModel {
  id: string;
  title: string;
  version: string;
  course_ids: string[];
  standard_ids: string[];
  question_type_counts: Record<string, number>;
  difficulty_counts: Record<string, number>;
  average_difficulty?: number | null;
  total_time_estimate_sec: number;
  standard_balance: TestStandardBalanceModel[];
}

export interface TestDraftDetailModel {
  test: TestDraftModel;
  summary: TestDraftSummaryModel;
  questions: QuestionModel[];
}

export interface TestDraftListResponseModel {
  items: TestDraftDetailModel[];
}

export interface DesktopContext {
  isDesktop: boolean;
  backendBaseUrl: string | null;
  backendReady: boolean;
  backendError: string | null;
  archiveDirty: boolean;
}

// ---------------------------------------------------------------------------
// Gradebook (.nxgb) -- a separate local package from a bank. See
// docs/grading.md. Student names/scans/scores live only here, never in a
// BankSummaryModel-shaped bank.
// ---------------------------------------------------------------------------

export interface GradebookManifestModel {
  schema_version: string;
  gradebook_id: string;
  title: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GradebookSummaryModel {
  source_path: string;
  workspace_path: string;
  manifest: GradebookManifestModel;
}

export interface StudentModel {
  id: string;
  first_name: string;
  last_name: string;
  external_id?: string | null;
  /** Class/period, for generating sheets for one section at a time. */
  section?: string | null;
  /** Free grouping: intervention group, accommodation, modified-version cohort. */
  grouping?: string | null;
}

export interface StudentListResponseModel {
  items: StudentModel[];
}

export type SheetRowKind = "multiple_choice" | "numeric_response" | "manual_capture";

export interface AnswerKeyItemModel {
  question_id: string;
  test_item_number: number;
  sheet_item_number: number;
  row_kind: SheetRowKind;
  points: number;
  standard_ids: string[];
  choice_count?: number | null;
  correct_choice_indices?: number[] | null;
  numeric_value?: number | null;
  numeric_tolerance?: number | null;
  grid_digits?: number | null;
  allow_decimal: boolean;
  allow_negative: boolean;
}

export interface AnswerKeyModel {
  test_id: string;
  version: string;
  items: AnswerKeyItemModel[];
  total_points: number;
}

export interface FiducialMarkerModel {
  corner: "top_left" | "top_right" | "bottom_left" | "bottom_right";
  shape: "square" | "circle";
  center_x_pt: number;
  center_y_pt: number;
  size_pt: number;
}

export interface BubbleCellModel {
  value: number;
  center_x_pt: number;
  center_y_pt: number;
  radius_pt: number;
}

export interface CaptureBoxModel {
  x_pt: number;
  y_pt: number;
  width_pt: number;
  height_pt: number;
}

export interface SheetRowModel {
  question_id: string;
  test_item_number: number;
  sheet_item_number: number;
  kind: SheetRowKind;
  label_x_pt: number;
  label_y_pt: number;
  cells: BubbleCellModel[];
  digit_columns?: number | null;
  capture_box?: CaptureBoxModel | null;
}

export interface SheetPageModel {
  page_index: number;
  fiducials: FiducialMarkerModel[];
  qr_box: CaptureBoxModel;
  qr_payload: string;
  name_box?: CaptureBoxModel | null;
  printed_name?: string | null;
  rows: SheetRowModel[];
}

export type SheetPageSize = "letter" | "legal" | "a4" | "half_letter";

export interface SheetLayoutModel {
  id: string;
  mode: "blank" | "pre_id";
  page_size: SheetPageSize;
  page_width_pt: number;
  page_height_pt: number;
  pages: SheetPageModel[];
}

export interface AdministeredTestSnapshotModel {
  id: string;
  source_bank_title?: string | null;
  source_test_id: string;
  title: string;
  version: string;
  printed_at: string;
  items: TestItemModel[];
  questions: QuestionModel[];
  answer_key: AnswerKeyModel;
  layout: SheetLayoutModel;
}

export interface AdministeredTestSnapshotSummaryModel {
  id: string;
  layout_id: string;
  source_bank_title?: string | null;
  source_test_id: string;
  title: string;
  version: string;
  printed_at: string;
  total_points: number;
  page_count: number;
  mode: "blank" | "pre_id";
}

export interface AdministeredTestSnapshotListResponseModel {
  items: AdministeredTestSnapshotSummaryModel[];
}

export type DetectionFlag = "none" | "low_confidence" | "multi_mark" | "no_mark";

export type IdentityStatus =
  | "pre_identified"
  | "unresolved"
  | "manually_resolved"
  | "qr_unreadable"
  | "wrong_snapshot";

export interface DetectedRowResultModel {
  question_id: string;
  sheet_item_number: number;
  kind: SheetRowKind;
  detected_choice_indices: number[];
  detected_digits?: string | null;
  detected_value?: number | null;
  confidence?: number | null;
  /** A human confirmed the student answered nothing here. */
  override_blank?: boolean;
  flag: DetectionFlag;
  needs_manual_grade: boolean;
  manual_score?: number | null;
  manual_score_max?: number | null;
  manual_grader_note?: string | null;
  override_choice_indices?: number[] | null;
  override_value?: number | null;
  override_note?: string | null;
}

export interface ScannedSheetModel {
  id: string;
  snapshot_id?: string | null;
  layout_id?: string | null;
  sheet_id?: string | null;
  source_image_path: string;
  page_index: number;
  student_id?: string | null;
  free_text_name?: string | null;
  identity_status: IdentityStatus;
  fiducial_confidence?: number | null;
  row_results: DetectedRowResultModel[];
  needs_review: boolean;
}

export interface GradingBatchModel {
  id: string;
  snapshot_id: string;
  created_at: string;
  source_description?: string | null;
  sheets: ScannedSheetModel[];
}

export interface GradingBatchListResponseModel {
  items: GradingBatchModel[];
}

export interface ChoiceDistributionEntryModel {
  choice_index: number;
  count: number;
}

export interface GradeReportItemModel {
  question_id: string;
  sheet_item_number: number;
  row_kind: SheetRowKind;
  standard_ids: string[];
  attempts: number;
  full_credit_count: number;
  percent_full_credit: number;
  choice_distribution: ChoiceDistributionEntryModel[];
  flagged_count: number;
}

export interface GradeReportStandardModel {
  standard_id: string;
  code?: string | null;
  statement?: string | null;
  attempts: number;
  full_credit_count: number;
  percent_full_credit: number;
}

export interface StudentScoreModel {
  sheet_id: string;
  student_id?: string | null;
  student_display_name?: string | null;
  points_earned: number;
  points_possible: number;
  percent_correct: number;
  flagged_answer_count: number;
}

export interface GradeReportModel {
  batch_id: string;
  snapshot_id: string;
  test_title: string;
  version: string;
  generated_at: string;
  scored_sheet_count: number;
  excluded_sheet_count: number;
  total_possible_points: number;
  average_percent_correct: number;
  score_histogram: Record<string, number>;
  by_standard: GradeReportStandardModel[];
  by_item: GradeReportItemModel[];
  student_scores: StudentScoreModel[];
  contains_unscored_manual_items: boolean;
}

export interface CombinedGradeReportModel {
  test_title: string;
  snapshot_ids: string[];
  batch_ids: string[];
  scored_sheet_count: number;
  by_standard: GradeReportStandardModel[];
}
