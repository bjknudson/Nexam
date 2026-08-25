import type {
  AssetInspectionBatchResponseModel,
  AssetInspectionResponseModel,
  AssetListResponseModel,
  AssetModel,
  AssetUploadResponseModel,
  BankSummaryModel,
  CourseDetailModel,
  CourseListResponseModel,
  CourseModel,
  CreateQuestionsFromJsonResponse,
  CreateStandardsManuallyRequest,
  StandardImportInspectionModel,
  QuestionImportListResponseModel,
  QuestionImportPromoteResponseModel,
  QuestionImportStageModel,
  QuestionListResponseModel,
  QuestionModel,
  StandardImportResponseModel,
  StandardListResponseModel,
  StandardRecordModel,
  StandardReferenceModel,
  StandardSearchResponseModel,
  TestDraftDetailModel,
  TestDraftListResponseModel,
  TestDraftModel,
} from "./types";

let apiBaseUrl = "";

export function setApiBaseUrl(nextBaseUrl: string | null) {
  apiBaseUrl = nextBaseUrl ? nextBaseUrl.replace(/\/$/, "") : "";
}

function buildApiUrl(path: string): string {
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: "Request failed." }));
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : JSON.stringify(payload.detail ?? "Request failed.");
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export interface BackendHealthModel {
  status: string;
  version?: string;
  build?: string;
}

export async function getBackendHealth(): Promise<BackendHealthModel> {
  return handleResponse(await fetch(buildApiUrl("/api/health")));
}

export async function openDemoBank(): Promise<BankSummaryModel> {
  return handleResponse(await fetch(buildApiUrl("/api/banks/open-demo"), { method: "POST" }));
}

export async function openBank(path: string): Promise<BankSummaryModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/banks/open"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function getCurrentBank(): Promise<BankSummaryModel> {
  return handleResponse(await fetch(buildApiUrl("/api/banks/current")));
}

export async function createBank(payload: {
  title: string;
  description: string | null;
  destinationPath: string;
}): Promise<BankSummaryModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/banks/create"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: payload.title,
        description: payload.description,
        destination_path: payload.destinationPath,
      }),
    }),
  );
}

export async function updateBankDetails(payload: {
  title: string;
  description: string | null;
}): Promise<BankSummaryModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/banks/current"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: payload.title, description: payload.description }),
    }),
  );
}

export async function listSourceStandardLists(): Promise<StandardListResponseModel> {
  return handleResponse(await fetch(buildApiUrl("/api/standards/source-lists")));
}

export async function listStandards(params?: {
  source_list_id?: string;
  search?: string;
  course_id?: string;
  strand?: string;
  sort?: string;
}): Promise<StandardSearchResponseModel> {
  const searchParams = new URLSearchParams();
  if (params?.source_list_id) searchParams.set("source_list_id", params.source_list_id);
  if (params?.search) searchParams.set("search", params.search);
  if (params?.course_id) searchParams.set("course_id", params.course_id);
  if (params?.strand) searchParams.set("strand", params.strand);
  if (params?.sort) searchParams.set("sort", params.sort);
  return handleResponse(await fetch(buildApiUrl(`/api/standards?${searchParams.toString()}`)));
}

export async function listCourses(): Promise<CourseListResponseModel> {
  return handleResponse(await fetch(buildApiUrl("/api/courses")));
}

export async function getCourseDetail(courseId: string): Promise<CourseDetailModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/courses/${encodeURIComponent(courseId)}`)),
  );
}

export async function deleteCourse(courseId: string): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/courses/${encodeURIComponent(courseId)}`), {
    method: "DELETE",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: "Request failed." }));
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : JSON.stringify(payload.detail ?? "Request failed.");
    throw new Error(detail);
  }
}

export async function upsertCourse(
  courseId: string,
  payload: { title: string; description?: string | null; standard_refs: StandardReferenceModel[] },
): Promise<CourseModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/courses/${encodeURIComponent(courseId)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function seedCourseFrom(
  courseId: string,
  payload: {
    source_course_id: string;
    include_standards: boolean;
    include_tests: boolean;
  },
): Promise<CourseDetailModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/courses/${encodeURIComponent(courseId)}/seed`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function attachStandardToCourse(
  courseId: string,
  standardId: string,
): Promise<CourseModel> {
  return handleResponse(
    await fetch(
      buildApiUrl(
        `/api/courses/${encodeURIComponent(courseId)}/standards/${encodeURIComponent(standardId)}`,
      ),
      { method: "POST" },
    ),
  );
}

export async function detachStandardFromCourse(
  courseId: string,
  standardId: string,
): Promise<CourseModel> {
  return handleResponse(
    await fetch(
      buildApiUrl(
        `/api/courses/${encodeURIComponent(courseId)}/standards/${encodeURIComponent(standardId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export async function importStandards(payload: {
  file: File;
  source_list_id?: string;
  title?: string;
  issuer?: string;
  subject?: string;
  version?: string;
  description?: string;
}): Promise<StandardImportResponseModel> {
  const formData = new FormData();
  formData.append("file", payload.file);
  if (payload.source_list_id) formData.append("source_list_id", payload.source_list_id);
  if (payload.title) formData.append("title", payload.title);
  if (payload.issuer) formData.append("issuer", payload.issuer);
  if (payload.subject) formData.append("subject", payload.subject);
  if (payload.version) formData.append("version", payload.version);
  if (payload.description) formData.append("description", payload.description);
  return handleResponse(
    await fetch(buildApiUrl("/api/standards/import"), {
      method: "POST",
      body: formData,
    }),
  );
}

export async function inspectStandardImport(
  file: File,
): Promise<StandardImportInspectionModel> {
  const formData = new FormData();
  formData.append("file", file);
  return handleResponse(
    await fetch(buildApiUrl("/api/standards/import/inspect"), {
      method: "POST",
      body: formData,
    }),
  );
}

export async function createStandardsManually(
  payload: CreateStandardsManuallyRequest,
): Promise<StandardImportResponseModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/standards/manual"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function updateStandard(
  standardId: string,
  payload: StandardRecordModel,
): Promise<StandardRecordModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/standards/${encodeURIComponent(standardId)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function createStandardPlaceholders(standardIds: string[]): Promise<StandardSearchResponseModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/standards/placeholders"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ standard_ids: standardIds }),
    }),
  );
}

export async function listAssets(): Promise<AssetListResponseModel> {
  return handleResponse(await fetch(buildApiUrl("/api/assets")));
}

export async function listQuestions(params: {
  search?: string;
  topic?: string;
  type?: string;
}): Promise<QuestionListResponseModel> {
  const searchParams = new URLSearchParams();
  if (params.search) searchParams.set("search", params.search);
  if (params.topic) searchParams.set("topic", params.topic);
  if (params.type) searchParams.set("type", params.type);
  return handleResponse(await fetch(buildApiUrl(`/api/questions?${searchParams.toString()}`)));
}

export async function stageQuestionImport(file: File): Promise<QuestionImportStageModel> {
  const formData = new FormData();
  formData.append("file", file);
  return handleResponse(
    await fetch(buildApiUrl("/api/question-imports/stage"), {
      method: "POST",
      body: formData,
    }),
  );
}

export async function listQuestionImports(): Promise<QuestionImportListResponseModel> {
  return handleResponse(await fetch(buildApiUrl("/api/question-imports")));
}

export async function getQuestionImport(importId: string): Promise<QuestionImportStageModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/question-imports/${encodeURIComponent(importId)}`)),
  );
}

export async function updateQuestionImportRow(payload: {
  importId: string;
  rowId: string;
  question: Record<string, unknown>;
  selected?: boolean | null;
}): Promise<QuestionImportStageModel> {
  return handleResponse(
    await fetch(
      buildApiUrl(
        `/api/question-imports/${encodeURIComponent(payload.importId)}/rows/${encodeURIComponent(payload.rowId)}`,
      ),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: payload.question,
          selected: payload.selected ?? null,
        }),
      },
    ),
  );
}

export async function promoteQuestionImport(payload: {
  importId: string;
  row_ids?: string[] | null;
  id_policy?: "auto" | "keep_imported";
}): Promise<QuestionImportPromoteResponseModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/question-imports/${encodeURIComponent(payload.importId)}/promote`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        row_ids: payload.row_ids ?? null,
        id_policy: payload.id_policy ?? "auto",
      }),
    }),
  );
}

export async function listTestDrafts(): Promise<TestDraftListResponseModel> {
  return handleResponse(await fetch(buildApiUrl("/api/tests")));
}

export async function createTestDraft(payload: {
  title: string;
  version?: string;
  course_ids?: string[];
}): Promise<TestDraftDetailModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/tests"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: payload.title,
        version: payload.version || "A",
        course_ids: payload.course_ids ?? [],
      }),
    }),
  );
}

export async function setTestCourses(
  testId: string,
  courseIds: string[],
): Promise<TestDraftDetailModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/tests/${encodeURIComponent(testId)}/courses`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ course_ids: courseIds }),
    }),
  );
}

export async function copyTestDraft(
  testId: string,
  payload: {
    title?: string;
    version?: string;
    course_ids?: string[];
    detach_courses_from_source?: boolean;
    /** Pre-edit snapshot to write back over the original, if it should revert. */
    source_restore?: TestDraftModel | null;
  },
): Promise<TestDraftDetailModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/tests/${encodeURIComponent(testId)}/copy`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function updateTestDraft(
  testId: string,
  test: TestDraftModel,
): Promise<TestDraftDetailModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/tests/${encodeURIComponent(testId)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(test),
    }),
  );
}

export async function addQuestionToTest(payload: {
  testId: string;
  question_id: string;
  experimental?: boolean;
}): Promise<TestDraftDetailModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/tests/${encodeURIComponent(payload.testId)}/items`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question_id: payload.question_id,
        experimental: payload.experimental ?? false,
      }),
    }),
  );
}

export async function getQuestion(id: string): Promise<QuestionModel> {
  return handleResponse(await fetch(buildApiUrl(`/api/questions/${id}`)));
}

export async function updateQuestion(
  id: string,
  question: QuestionModel | Record<string, unknown>,
): Promise<QuestionModel> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/questions/${id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(question),
    }),
  );
}

export async function createQuestion(templateQuestionId?: string): Promise<QuestionModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/questions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_question_id: templateQuestionId || null }),
    }),
  );
}

export async function createQuestionFromJson(
  question: Record<string, unknown>,
): Promise<QuestionModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/questions/from-json"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(question),
    }),
  );
}

export async function getNextQuestionId(questionType: string): Promise<{ id: string }> {
  return handleResponse(
    await fetch(buildApiUrl(`/api/questions/next-id?type=${encodeURIComponent(questionType)}`)),
  );
}

export async function deleteQuestion(id: string): Promise<void> {
  const response = await fetch(buildApiUrl(`/api/questions/${id}`), {
    method: "DELETE",
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: "Request failed." }));
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : JSON.stringify(payload.detail ?? "Request failed.");
    throw new Error(detail);
  }
}

export async function saveBank(destinationPath?: string): Promise<{ saved_to: string }> {
  return handleResponse(
    await fetch(buildApiUrl("/api/banks/save"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination_path: destinationPath || null }),
    }),
  );
}

export async function uploadAsset(file: File): Promise<AssetUploadResponseModel> {
  const formData = new FormData();
  formData.append("file", file);
  return handleResponse(
    await fetch(buildApiUrl("/api/assets/upload"), {
      method: "POST",
      body: formData,
    }),
  );
}

export async function inspectAsset(asset: AssetModel): Promise<AssetInspectionResponseModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/assets/inspect"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(asset),
    }),
  );
}

export async function inspectAssets(
  assets: AssetModel[],
): Promise<AssetInspectionBatchResponseModel> {
  return handleResponse(
    await fetch(buildApiUrl("/api/assets/inspect-batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assets }),
    }),
  );
}

export async function createQuestionsFromJson(
  questions: Record<string, unknown>[],
): Promise<CreateQuestionsFromJsonResponse> {
  return handleResponse(
    await fetch(buildApiUrl("/api/questions/from-json-batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions }),
    }),
  );
}

export function getAssetFileUrl(path: string): string {
  return buildApiUrl(`/api/assets/file?path=${encodeURIComponent(path)}`);
}
