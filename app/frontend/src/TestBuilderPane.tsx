import { useEffect, useRef, useState } from "react";

import type {
  CourseModel,
  QuestionModel,
  QuestionType,
  TestDraftDetailModel,
  TestItemModel,
  TestDraftModel,
  TestInstructionSectionOptionsModel,
  TestInstructionSectionModel,
  TestPrintSettingsModel,
  TestTemplateBlockModel,
} from "./types";

interface TestBuilderPaneProps {
  open: boolean;
  hasBank: boolean;
  loading: boolean;
  selectedTestId: string | null;
  tests: TestDraftDetailModel[];
  /** Ids of the tests currently "on the desk". Others stay archived. */
  openTestIds: string[];
  /** Courses this bank knows about, for assigning the open test to some of them. */
  courses: CourseModel[];
  pageMode?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onCreateTest: () => void;
  onCreateNewVersion: (testId: string) => void;
  onSelectTest: (testId: string) => void;
  onOpenTest: (testId: string) => void;
  onArchiveTest: (testId: string) => void;
  onOpenPrintPreview: () => void;
  onOpenResponseSheetPrint: () => void;
  /** Finish the open test (if not already) and open the response sheet pane
   *  scoped to its lineage. Only finished tests are eligible for sheets. */
  onFinishAndCreateResponseSheets: () => void;
  onUpdateTest: (test: TestDraftModel) => void;
  /** Fork the open test into a new draft, optionally reverting the original. */
  onCopyTest: (
    testId: string,
    payload: {
      title: string;
      version: string;
      course_ids: string[];
      detach_courses_from_source: boolean;
      source_restore: TestDraftModel | null;
    },
  ) => void;
  onApplyTestJson: (testId: string, raw: string) => void;
}

type TestJsonMode = "full" | "questions";

function formatMinutes(seconds: number) {
  if (seconds <= 0) return "0 min";
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function isQuestionItem(item: TestItemModel) {
  return (item.item_type ?? "question") === "question";
}

function isSectionItem(item: TestItemModel) {
  return item.item_type === "section";
}

/** Item sorting. Manual-order fields let the teacher say what "first" means
 *  (Mechanics before Waves); the numeric ones only need a direction. */
type SortField = "topic" | "subtopic" | "difficulty" | "type" | "time";

interface SortRule {
  field: SortField;
  direction: "asc" | "desc";
  /** Value order for manual-order fields, most significant first. */
  order: string[];
}

const SORT_FIELDS: SortField[] = ["topic", "subtopic", "difficulty", "type", "time"];

const SORT_FIELD_LABEL: Record<SortField, string> = {
  topic: "Topic",
  subtopic: "Subtopic",
  difficulty: "Difficulty",
  type: "Type",
  time: "Time",
};

const MANUAL_ORDER_FIELDS: SortField[] = ["topic", "subtopic", "type"];

function isManualOrderField(field: SortField) {
  return MANUAL_ORDER_FIELDS.includes(field);
}

const NO_VALUE = "";

function sortValueFor(field: SortField, question: QuestionModel | undefined): string {
  if (!question) return NO_VALUE;
  if (field === "topic") return question.topic ?? NO_VALUE;
  if (field === "subtopic") return question.subtopic ?? NO_VALUE;
  if (field === "type") return question.type;
  return NO_VALUE;
}

function sortNumberFor(field: SortField, question: QuestionModel | undefined): number {
  if (!question) return Number.MAX_SAFE_INTEGER;
  if (field === "difficulty") return question.difficulty ?? 0;
  if (field === "time") return question.estimated_time_sec ?? 0;
  return 0;
}

/** Distinct values for a manual-order field, in the order they appear in the test. */
function distinctSortValues(
  field: SortField,
  items: TestItemModel[],
  questionById: Record<string, QuestionModel>,
): string[] {
  const seen: string[] = [];
  for (const item of items) {
    if (!isQuestionItem(item)) continue;
    const value = sortValueFor(field, item.question_id ? questionById[item.question_id] : undefined);
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
}

/** A rule's stored order, refreshed against what the test actually holds now. */
function effectiveSortOrder(
  rule: SortRule,
  items: TestItemModel[],
  questionById: Record<string, QuestionModel>,
): string[] {
  if (!isManualOrderField(rule.field)) return [];
  const present = distinctSortValues(rule.field, items, questionById);
  const kept = rule.order.filter((value) => present.includes(value));
  const added = present.filter((value) => !kept.includes(value));
  return [...kept, ...added];
}

function compareByRule(
  rule: SortRule,
  order: string[],
  left: TestItemModel,
  right: TestItemModel,
  questionById: Record<string, QuestionModel>,
): number {
  const leftQuestion = left.question_id ? questionById[left.question_id] : undefined;
  const rightQuestion = right.question_id ? questionById[right.question_id] : undefined;

  if (isManualOrderField(rule.field)) {
    const leftIndex = order.indexOf(sortValueFor(rule.field, leftQuestion));
    const rightIndex = order.indexOf(sortValueFor(rule.field, rightQuestion));
    // A value the rule does not mention sorts after the ones it does.
    const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return leftRank - rightRank;
  }

  const difference =
    sortNumberFor(rule.field, leftQuestion) - sortNumberFor(rule.field, rightQuestion);
  return rule.direction === "desc" ? -difference : difference;
}

/** Sort question items inside each section, leaving section headers where they are. */
function sortTestItems(
  items: TestItemModel[],
  rules: SortRule[],
  questionById: Record<string, QuestionModel>,
): TestItemModel[] {
  if (rules.length === 0) return items;

  const orders = rules.map((rule) => effectiveSortOrder(rule, items, questionById));
  const sortRun = (run: TestItemModel[]) =>
    run
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
          const result = compareByRule(
            rules[ruleIndex],
            orders[ruleIndex],
            left.item,
            right.item,
            questionById,
          );
          if (result !== 0) return result;
        }
        // Ties keep the order the teacher already arranged.
        return left.index - right.index;
      })
      .map((entry) => entry.item);

  const sorted: TestItemModel[] = [];
  let run: TestItemModel[] = [];
  const flushRun = () => {
    if (run.length > 0) {
      sorted.push(...sortRun(run));
      run = [];
    }
  };

  for (const item of items) {
    if (isSectionItem(item)) {
      flushRun();
      sorted.push(item);
      continue;
    }
    run.push(item);
  }
  flushRun();

  return sorted;
}

function parseStandardText(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((standard) => standard.trim())
        .filter(Boolean),
    ),
  );
}

function updatePrintSettings(
  test: TestDraftModel,
  patch: Partial<TestPrintSettingsModel>,
): TestDraftModel {
  return {
    ...test,
    print_settings: {
      ...test.print_settings,
      ...patch,
    },
  };
}

const QUESTION_TYPE_ORDER: QuestionType[] = [
  "multiple_choice",
  "numeric_response",
  "short_answer",
  "free_response",
];

const DEFAULT_INSTRUCTION_SECTIONS: Record<QuestionType, TestInstructionSectionModel> = {
  multiple_choice: {
    question_type: "multiple_choice",
    title: "Multiple Choice",
    instructions: "Select the best answer.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
  numeric_response: {
    question_type: "numeric_response",
    title: "Numeric Response",
    instructions: "Enter a numeric answer.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
  short_answer: {
    question_type: "short_answer",
    title: "Short Answer",
    instructions: "Write a concise response.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
  free_response: {
    question_type: "free_response",
    title: "Free Response",
    instructions: "Show your work and justify your answer.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
};

const DEFAULT_PAGE_HEADER: TestTemplateBlockModel = {
  template: "{{title}}\nVersion {{version}}    {{date}}",
  alignment: "center",
  horizontal_line: true,
  spacing_after_lines: 1,
};

const DEFAULT_NAME_FIELD: TestTemplateBlockModel = {
  template: "Name: ______________________________",
  alignment: "left",
  horizontal_line: false,
  spacing_after_lines: 1,
};

const DEFAULT_INSTRUCTION_OPTIONS: TestInstructionSectionOptionsModel = {
  show_topic: false,
  show_standards: false,
  show_suggested_time: true,
  alignment: "left",
  horizontal_line: true,
  spacing_after_lines: 1,
};

function getInstructionSections(settings: TestPrintSettingsModel): TestInstructionSectionModel[] {
  const byType = Object.fromEntries(
    (settings.instruction_sections ?? []).map((section) => [section.question_type, section]),
  ) as Partial<Record<QuestionType, TestInstructionSectionModel>>;
  return QUESTION_TYPE_ORDER.map((questionType) => ({
    ...DEFAULT_INSTRUCTION_SECTIONS[questionType],
    ...byType[questionType],
  }));
}

function updateInstructionSection(
  test: TestDraftModel,
  questionType: QuestionType,
  patch: Partial<TestInstructionSectionModel>,
): TestDraftModel {
  const sections = getInstructionSections(test.print_settings).map((section) =>
    section.question_type === questionType ? { ...section, ...patch } : section,
  );
  return updatePrintSettings(test, { instruction_sections: sections });
}

function getPageHeader(settings: TestPrintSettingsModel): TestTemplateBlockModel {
  return { ...DEFAULT_PAGE_HEADER, ...settings.page_header };
}

function getNameField(settings: TestPrintSettingsModel): TestTemplateBlockModel {
  return { ...DEFAULT_NAME_FIELD, ...settings.name_field };
}

function getInstructionOptions(
  settings: TestPrintSettingsModel,
): TestInstructionSectionOptionsModel {
  return {
    ...DEFAULT_INSTRUCTION_OPTIONS,
    ...settings.instruction_section_options,
  };
}

function updatePageHeader(
  test: TestDraftModel,
  patch: Partial<TestTemplateBlockModel>,
): TestDraftModel {
  return updatePrintSettings(test, {
    page_header: {
      ...getPageHeader(test.print_settings),
      ...patch,
    },
  });
}

function updateNameField(
  test: TestDraftModel,
  patch: Partial<TestTemplateBlockModel>,
): TestDraftModel {
  return updatePrintSettings(test, {
    name_field: {
      ...getNameField(test.print_settings),
      ...patch,
    },
  });
}

function updateInstructionOptions(
  test: TestDraftModel,
  patch: Partial<TestInstructionSectionOptionsModel>,
): TestDraftModel {
  return updatePrintSettings(test, {
    instruction_section_options: {
      ...getInstructionOptions(test.print_settings),
      ...patch,
    },
  });
}

function TestBuilderPane({
  open,
  hasBank,
  loading,
  selectedTestId,
  tests,
  openTestIds,
  courses,
  pageMode = false,
  onOpen,
  onClose,
  onCreateTest,
  onCreateNewVersion,
  onSelectTest,
  onOpenTest,
  onArchiveTest,
  onOpenPrintPreview,
  onOpenResponseSheetPrint,
  onFinishAndCreateResponseSheets,
  onUpdateTest,
  onCopyTest,
  onApplyTestJson,
}: TestBuilderPaneProps) {
  const [testSearch, setTestSearch] = useState("");
  const [jsonMode, setJsonMode] = useState<TestJsonMode>("full");
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonDirty, setJsonDirty] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);
  const [courseMenuOpen, setCourseMenuOpen] = useState(false);
  const [sharedNoticeDismissed, setSharedNoticeDismissed] = useState(false);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyTitle, setCopyTitle] = useState("");
  const [copyVersion, setCopyVersion] = useState("");
  const [copyCourseIds, setCopyCourseIds] = useState<string[]>([]);
  const [copyDetachFromSource, setCopyDetachFromSource] = useState(true);
  const [copyRestoreOriginal, setCopyRestoreOriginal] = useState(true);
  const [sortRules, setSortRules] = useState<SortRule[]>([]);
  const [archiveCandidate, setArchiveCandidate] = useState<TestDraftDetailModel | null>(null);
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  // How the open test looked when it was opened, so a shared test can be put
  // back the way the other courses had it after a fork.
  const snapshotRef = useRef<TestDraftModel | null>(null);
  if (!open) {
    return (
      <section className="test-builder-collapsed">
        <button type="button" onClick={onOpen} disabled={!hasBank}>
          Test Builder
        </button>
      </section>
    );
  }

  const openTests = tests.filter((item) => openTestIds.includes(item.test.id));
  // "Archived" is simply not on the desk -- the test is still in the bank, which
  // is what the confirm below explains and the browser below makes reachable.
  const archivedTests = tests.filter((item) => !openTestIds.includes(item.test.id));
  const selectedTest =
    openTests.find((item) => item.test.id === selectedTestId) ?? openTests[0] ?? null;
  const trimmedTestSearch = testSearch.trim().toLowerCase();
  const searchMatches = trimmedTestSearch
    ? tests.filter((item) => {
        const haystack =
          `${item.test.title} ${item.test.version} ${item.test.id}`.toLowerCase();
        return haystack.includes(trimmedTestSearch);
      })
    : [];
  const questionById = Object.fromEntries(
    (selectedTest?.questions ?? []).map((question) => [question.id, question]),
  );

  const jsonForMode = (() => {
    if (!selectedTest) return "";
    if (jsonMode === "questions") {
      return JSON.stringify({ questions: selectedTest.questions }, null, 2);
    }
    return JSON.stringify(
      { test: selectedTest.test, questions: selectedTest.questions },
      null,
      2,
    );
  })();

  useEffect(() => {
    if (jsonDirty) return;
    setJsonDraft(jsonForMode);
  }, [jsonForMode, jsonDirty]);

  useEffect(() => {
    setJsonDirty(false);
    setJsonCopied(false);
  }, [selectedTest?.test.id, jsonMode]);
  const questionItemCount = selectedTest?.test.items.filter(isQuestionItem).length ?? 0;

  // Snapshot the test as opened, and reset the per-test UI that hangs off it.
  useEffect(() => {
    snapshotRef.current = selectedTest ? structuredClone(selectedTest.test) : null;
    setSharedNoticeDismissed(false);
    setCourseMenuOpen(false);
    setCopyDialogOpen(false);
    setSortRules([]);
    // Only when a different test is put on the desk, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTest?.test.id]);

  const assignedCourses = selectedTest
    ? courses.filter((course) => selectedTest.test.course_ids.includes(course.id))
    : [];
  const unassignedCourses = selectedTest
    ? courses.filter((course) => !selectedTest.test.course_ids.includes(course.id))
    : [];

  const toggleCourse = (courseId: string) => {
    if (!selectedTest) return;
    onUpdateTest({
      ...selectedTest.test,
      course_ids: selectedTest.test.course_ids.includes(courseId)
        ? selectedTest.test.course_ids.filter((id) => id !== courseId)
        : [...selectedTest.test.course_ids, courseId],
    });
  };

  // Course membership on its own is not an edit to the test's contents, so it
  // does not raise the shared-test notice.
  const contentsOf = (test: TestDraftModel) =>
    JSON.stringify({ ...test, course_ids: [] });
  const testEdited = Boolean(
    selectedTest &&
      snapshotRef.current &&
      contentsOf(selectedTest.test) !== contentsOf(snapshotRef.current),
  );
  const sharedNotice =
    selectedTest && assignedCourses.length > 1 && testEdited && !sharedNoticeDismissed
      ? assignedCourses.map((course) => course.title).join(" and ")
      : null;

  const openCopyDialog = () => {
    if (!selectedTest) return;
    setCopyTitle(`${selectedTest.test.title} (Copy)`);
    setCopyVersion(selectedTest.test.version);
    setCopyCourseIds([...selectedTest.test.course_ids]);
    setCopyDetachFromSource(selectedTest.test.course_ids.length > 1);
    setCopyRestoreOriginal(testEdited);
    setCopyDialogOpen(true);
  };

  const submitCopy = () => {
    if (!selectedTest) return;
    onCopyTest(selectedTest.test.id, {
      title: copyTitle.trim() || selectedTest.test.title,
      version: copyVersion.trim() || selectedTest.test.version,
      course_ids: copyCourseIds,
      detach_courses_from_source: copyDetachFromSource,
      source_restore: copyRestoreOriginal ? snapshotRef.current : null,
    });
    setCopyDialogOpen(false);
    setSharedNoticeDismissed(true);
  };

  const usedSortFields = sortRules.map((rule) => rule.field);
  const availableSortFields = SORT_FIELDS.filter((field) => !usedSortFields.includes(field));

  const addSortRule = () => {
    const field = availableSortFields[0];
    if (!field) return;
    setSortRules((rules) => [...rules, { field, direction: "asc", order: [] }]);
  };

  const updateSortRule = (index: number, patch: Partial<SortRule>) => {
    setSortRules((rules) =>
      rules.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)),
    );
  };

  const removeSortRule = (index: number) => {
    setSortRules((rules) => rules.filter((_, ruleIndex) => ruleIndex !== index));
  };

  const moveSortValue = (ruleIndex: number, valueIndex: number, direction: -1 | 1) => {
    if (!selectedTest) return;
    const rule = sortRules[ruleIndex];
    const order = effectiveSortOrder(rule, selectedTest.test.items, questionById);
    const nextIndex = valueIndex + direction;
    if (nextIndex < 0 || nextIndex >= order.length) return;
    const reordered = [...order];
    const [value] = reordered.splice(valueIndex, 1);
    reordered.splice(nextIndex, 0, value);
    updateSortRule(ruleIndex, { order: reordered });
  };

  const applySortRules = () => {
    if (!selectedTest || sortRules.length === 0) return;
    onUpdateTest({
      ...selectedTest.test,
      items: sortTestItems(selectedTest.test.items, sortRules, questionById),
    });
  };

  const updateItem = (index: number, patch: Partial<TestDraftModel["items"][number]>) => {
    if (!selectedTest) return;
    onUpdateTest({
      ...selectedTest.test,
      items: selectedTest.test.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    });
  };

  const removeItem = (index: number) => {
    if (!selectedTest) return;
    onUpdateTest({
      ...selectedTest.test,
      items: selectedTest.test.items.filter((_, itemIndex) => itemIndex !== index),
    });
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    if (!selectedTest) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= selectedTest.test.items.length) return;
    const items = [...selectedTest.test.items];
    const [item] = items.splice(index, 1);
    items.splice(nextIndex, 0, item);
    onUpdateTest({ ...selectedTest.test, items });
  };

  const addSectionItem = () => {
    if (!selectedTest) return;
    const nextSectionNumber =
      selectedTest.test.items.filter((item) => item.item_type === "section").length + 1;
    onUpdateTest({
      ...selectedTest.test,
      items: [
        ...selectedTest.test.items,
        {
          item_type: "section",
          section_id: `section_${nextSectionNumber}`,
          title: `Section ${nextSectionNumber}`,
          instructions: "",
          header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
          question_type: null,
          topic: null,
          standards: [],
          suggested_time_mode: "calculated",
          suggested_time_sec: null,
        },
      ],
    });
  };

  return (
    <section className={`test-builder-pane ${pageMode ? "page-mode" : ""}`}>
      <div className="test-builder-header">
        <div>
          {pageMode ? null : <h2>Test Builder</h2>}
          <p>{selectedTest ? `${selectedTest.test.title} ${selectedTest.test.version}` : "No test open"}</p>
        </div>
        <div className="test-builder-actions">
          <button type="button" onClick={onCreateTest} disabled={loading || !hasBank}>
            New Test
          </button>
          <button
            type="button"
            onClick={() => selectedTest && onCreateNewVersion(selectedTest.test.id)}
            disabled={loading || !selectedTest}
            title="Copy this test's settings and items into the next version"
          >
            New Version
          </button>
          <button
            type="button"
            onClick={openCopyDialog}
            disabled={loading || !selectedTest}
            title="Fork this test into a separate draft"
          >
            Save as Copy
          </button>
          {pageMode ? null : (
            <button type="button" onClick={onClose}>
              Hide
            </button>
          )}
        </div>
      </div>

      {!hasBank ? (
        <p className="test-builder-empty">Open a bank to build tests.</p>
      ) : (
        <div className={`test-builder-layout ${selectedTest ? "" : "no-open-test"}`}>
          <aside className="test-builder-list">
            <div className="test-builder-search">
              <input
                value={testSearch}
                onChange={(event) => setTestSearch(event.target.value)}
                placeholder="Search tests to open"
                aria-label="Search tests to open"
              />
              <button
                type="button"
                className="test-archive-browse-button"
                onClick={() => setArchiveBrowserOpen(true)}
                title="Tests not currently on the desk. Archiving never deletes anything."
              >
                Archive ({archivedTests.length})
              </button>
              {trimmedTestSearch ? (
                <div className="test-builder-search-results">
                  {searchMatches.length === 0 ? (
                    <p className="test-builder-search-empty">No tests match.</p>
                  ) : (
                    searchMatches.map((detail) => {
                      const alreadyOpen = openTestIds.includes(detail.test.id);
                      return (
                        <button
                          key={detail.test.id}
                          type="button"
                          className="test-builder-search-result"
                          onClick={() => {
                            onOpenTest(detail.test.id);
                            setTestSearch("");
                          }}
                        >
                          <strong>{detail.test.title}</strong>
                          <span>
                            Version {detail.test.version}
                            {alreadyOpen ? " - already open" : ""}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>

            {openTests.length === 0 ? (
              <p className="test-builder-list-empty">
                No tests are open. Search above to open one, or create a new test.
              </p>
            ) : (
              openTests.map((detail) => (
                <div
                  key={detail.test.id}
                  className={`test-builder-card ${
                    detail.test.id === selectedTest?.test.id ? "selected" : ""
                  }`}
                >
                  <button type="button" onClick={() => onSelectTest(detail.test.id)}>
                    <strong>{detail.test.title}</strong>
                    <span>Version {detail.test.version}</span>
                    <span>{detail.test.items.filter(isQuestionItem).length} questions</span>
                  </button>
                  <button
                    type="button"
                    className="test-builder-card-archive"
                    onClick={() => setArchiveCandidate(detail)}
                    title="Take this test off the desk. It stays in the bank and can be reopened from the archive."
                    aria-label={`Archive ${detail.test.title} version ${detail.test.version}`}
                  >
                    Archive
                  </button>
                </div>
              ))
            )}
          </aside>

          {!selectedTest ? (
            <div className="test-builder-empty-row">
              <p>
                {tests.length === 0
                  ? "No test drafts yet."
                  : "Open a test from the list, or create a new one."}
              </p>
              <button type="button" onClick={onCreateTest} disabled={loading}>
                Create Test Draft
              </button>
            </div>
          ) : (
          <>

          <div className="test-builder-detail">
            <section className="test-builder-meta">
              <label>
                Title
                <input
                  value={selectedTest.test.title}
                  onChange={(event) =>
                    onUpdateTest({ ...selectedTest.test, title: event.target.value })
                  }
                />
              </label>
              <label className="test-version-field">
                Version
                <input
                  value={selectedTest.test.version}
                  onChange={(event) =>
                    onUpdateTest({ ...selectedTest.test, version: event.target.value })
                  }
                />
              </label>
              <label
                className="test-version-note-field"
                title="Why this version exists. Shown wherever a version is chosen, so a note like 'shorter passages for EL' travels with it."
              >
                Version Note
                <input
                  placeholder="e.g. shorter passages for EL"
                  value={selectedTest.test.version_description ?? ""}
                  onChange={(event) =>
                    onUpdateTest({
                      ...selectedTest.test,
                      version_description: event.target.value || null,
                    })
                  }
                />
              </label>
              <button type="button" onClick={addSectionItem} disabled={loading}>
                Add Section
              </button>
              <button
                type="button"
                onClick={onOpenPrintPreview}
                disabled={questionItemCount === 0}
              >
                Preview Print
              </button>
              {selectedTest.test.finished ? (
                <button
                  type="button"
                  onClick={onOpenResponseSheetPrint}
                  disabled={questionItemCount === 0}
                  title="Hand this test off to an open gradebook and print bubble/grid-in response sheets"
                >
                  Create Response Sheets...
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onFinishAndCreateResponseSheets}
                  disabled={questionItemCount === 0 || loading}
                  title="Lock this test's item order and answer key, then hand it off to print response sheets. Further edits that would move a bubble will need a new version."
                >
                  Finish and Create Response Sheets...
                </button>
              )}
              <label
                className="test-builder-toggle test-interchangeable-toggle"
                title={
                  "One response sheet for every version of this test, with the student " +
                  "marking which version they took.\n\n" +
                  "Use it when versions exist for test security or retakes: you can print " +
                  "one stack of sheets and hand them out without matching sheet to paper, " +
                  "and a student who gets the wrong version can still be scored.\n\n" +
                  "It requires every version to share the same sheet shape -- same number " +
                  "of multiple choice, then numeric, then similarly sized written responses " +
                  "-- so leave it off when versions differ on purpose, such as an EL or " +
                  "lower-lexile version that needs different items or more space."
                }
              >
                <input
                  type="checkbox"
                  checked={selectedTest.test.interchangeable_sheets ?? false}
                  onChange={(event) =>
                    onUpdateTest({
                      ...selectedTest.test,
                      interchangeable_sheets: event.target.checked,
                    })
                  }
                  disabled={loading}
                />
                Interchangeable sheets
              </label>
            </section>

            {courses.length > 0 ? (
              <section className="test-course-tags">
                {assignedCourses.map((course) => (
                  <span key={course.id} className="test-course-tag">
                    {course.title}
                    <button
                      type="button"
                      aria-label={`Remove ${course.title}`}
                      title={`Remove ${course.title}`}
                      onClick={() => toggleCourse(course.id)}
                      disabled={loading}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {unassignedCourses.length > 0 ? (
                  <div className="test-course-picker">
                    <button
                      type="button"
                      className="test-course-add"
                      aria-expanded={courseMenuOpen}
                      onClick={() => setCourseMenuOpen((open) => !open)}
                      disabled={loading}
                    >
                      + Course
                    </button>
                    {courseMenuOpen ? (
                      <div className="test-course-menu" role="menu">
                        {unassignedCourses.map((course) => (
                          <button
                            key={course.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              toggleCourse(course.id);
                              setCourseMenuOpen(false);
                            }}
                          >
                            {course.title}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {assignedCourses.length === 0 ? (
                  <span className="test-course-empty">No course assigned</span>
                ) : null}
              </section>
            ) : null}

            {sharedNotice ? (
              <section className="test-shared-notice">
                <p>
                  Edited a test shared with {sharedNotice}. Those courses see this change too.
                </p>
                <div className="test-shared-notice-actions">
                  <button type="button" onClick={openCopyDialog} disabled={loading}>
                    Save as Copy
                  </button>
                  <button
                    type="button"
                    className="test-shared-notice-dismiss"
                    onClick={() => setSharedNoticeDismissed(true)}
                  >
                    Keep Shared
                  </button>
                </div>
              </section>
            ) : null}

            <section className="test-summary-grid">
              <div>
                <span>Questions</span>
                <strong>{questionItemCount}</strong>
              </div>
              <div>
                <span>Avg Difficulty</span>
                <strong>{selectedTest.summary.average_difficulty ?? "n/a"}</strong>
              </div>
              <div>
                <span>Total Time</span>
                <strong>{formatMinutes(selectedTest.summary.total_time_estimate_sec)}</strong>
              </div>
              <div>
                <span>Standards</span>
                <strong>{selectedTest.summary.standard_ids.length}</strong>
              </div>
            </section>

            <details className="test-builder-settings">
              <summary>Page Settings</summary>
              <div className="test-builder-settings-grid">
                <label>
                  Page Size
                  <select
                    value={selectedTest.test.print_settings.page_size}
                    onChange={(event) =>
                      onUpdateTest(
                        updatePrintSettings(selectedTest.test, {
                          page_size: event.target.value as TestPrintSettingsModel["page_size"],
                        }),
                      )
                    }
                  >
                    <option value="letter">Letter</option>
                    <option value="legal">Legal</option>
                    <option value="a4">A4</option>
                  </select>
                </label>
                <label>
                  Columns
                  <select
                    value={selectedTest.test.print_settings.columns}
                    onChange={(event) =>
                      onUpdateTest(
                        updatePrintSettings(selectedTest.test, {
                          columns: Number(event.target.value) as TestPrintSettingsModel["columns"],
                        }),
                      )
                    }
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
                <label>
                  Font Size
                  <input
                    type="number"
                    min={8}
                    max={18}
                    value={selectedTest.test.print_settings.font_size_pt}
                    onChange={(event) =>
                      onUpdateTest(
                        updatePrintSettings(selectedTest.test, {
                          font_size_pt: Number(event.target.value),
                        }),
                      )
                    }
                  />
                </label>
                <label>
                  Margin
                  <input
                    type="number"
                    min={0.25}
                    max={1.5}
                    step={0.25}
                    value={selectedTest.test.print_settings.margin_in}
                    onChange={(event) =>
                      onUpdateTest(
                        updatePrintSettings(selectedTest.test, {
                          margin_in: Number(event.target.value),
                        }),
                      )
                    }
                  />
                </label>
                <label className="test-builder-toggle">
                  <input
                    type="checkbox"
                    checked={selectedTest.test.print_settings.name_field_enabled}
                    onChange={(event) =>
                      onUpdateTest(
                        updatePrintSettings(selectedTest.test, {
                          name_field_enabled: event.target.checked,
                        }),
                      )
                    }
                  />
                  Name field
                </label>
                <label className="test-builder-toggle">
                  <input
                    type="checkbox"
                    checked={selectedTest.test.print_settings.page_numbers_enabled}
                    onChange={(event) =>
                      onUpdateTest(
                        updatePrintSettings(selectedTest.test, {
                          page_numbers_enabled: event.target.checked,
                        }),
                      )
                    }
                  />
                  Page numbers
                </label>
              </div>
              <div className="test-settings-editor-grid">
                <details className="test-template-editor">
                  <summary>Page Topper</summary>
                  <label>
                    Template
                    <textarea
                      value={getPageHeader(selectedTest.test.print_settings).template}
                      onChange={(event) =>
                        onUpdateTest(updatePageHeader(selectedTest.test, { template: event.target.value }))
                      }
                    />
                  </label>
                  <div className="test-template-editor-row">
                    <label>
                      Justification
                      <select
                        value={getPageHeader(selectedTest.test.print_settings).alignment}
                        onChange={(event) =>
                          onUpdateTest(
                            updatePageHeader(selectedTest.test, {
                              alignment: event.target.value as TestTemplateBlockModel["alignment"],
                            }),
                          )
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </label>
                    <label>
                      Space After
                      <input
                        type="number"
                        min={0}
                        max={6}
                        value={getPageHeader(selectedTest.test.print_settings).spacing_after_lines}
                        onChange={(event) =>
                          onUpdateTest(
                            updatePageHeader(selectedTest.test, {
                              spacing_after_lines: Number(event.target.value),
                            }),
                          )
                        }
                      />
                    </label>
                    <label className="test-builder-toggle">
                      <input
                        type="checkbox"
                        checked={getPageHeader(selectedTest.test.print_settings).horizontal_line}
                        onChange={(event) =>
                          onUpdateTest(
                            updatePageHeader(selectedTest.test, {
                              horizontal_line: event.target.checked,
                            }),
                          )
                        }
                      />
                      Horizontal line
                    </label>
                  </div>
                  <p className="test-template-help">
                    Placeholders: {"{{title}}"}, {"{{version}}"}, {"{{date}}"}
                  </p>
                </details>

                <details className="test-template-editor">
                  <summary>Name Field</summary>
                  <label>
                    Template
                    <textarea
                      value={getNameField(selectedTest.test.print_settings).template}
                      onChange={(event) =>
                        onUpdateTest(updateNameField(selectedTest.test, { template: event.target.value }))
                      }
                    />
                  </label>
                  <div className="test-template-editor-row">
                    <label>
                      Justification
                      <select
                        value={getNameField(selectedTest.test.print_settings).alignment}
                        onChange={(event) =>
                          onUpdateTest(
                            updateNameField(selectedTest.test, {
                              alignment: event.target.value as TestTemplateBlockModel["alignment"],
                            }),
                          )
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </label>
                    <label>
                      Space After
                      <input
                        type="number"
                        min={0}
                        max={6}
                        value={getNameField(selectedTest.test.print_settings).spacing_after_lines}
                        onChange={(event) =>
                          onUpdateTest(
                            updateNameField(selectedTest.test, {
                              spacing_after_lines: Number(event.target.value),
                            }),
                          )
                        }
                      />
                    </label>
                    <label className="test-builder-toggle">
                      <input
                        type="checkbox"
                        checked={getNameField(selectedTest.test.print_settings).horizontal_line}
                        onChange={(event) =>
                          onUpdateTest(
                            updateNameField(selectedTest.test, {
                              horizontal_line: event.target.checked,
                            }),
                          )
                        }
                      />
                      Horizontal line
                    </label>
                  </div>
                </details>

                <details className="test-template-editor">
                  <summary>Instruction Display</summary>
                  <div className="test-instruction-section-toggles">
                    <label className="test-builder-toggle">
                      <input
                        type="checkbox"
                        checked={getInstructionOptions(selectedTest.test.print_settings).show_topic}
                        onChange={(event) =>
                          onUpdateTest(
                            updateInstructionOptions(selectedTest.test, {
                              show_topic: event.target.checked,
                            }),
                          )
                        }
                      />
                      Topic
                    </label>
                    <label className="test-builder-toggle">
                      <input
                        type="checkbox"
                        checked={getInstructionOptions(selectedTest.test.print_settings).show_standards}
                        onChange={(event) =>
                          onUpdateTest(
                            updateInstructionOptions(selectedTest.test, {
                              show_standards: event.target.checked,
                            }),
                          )
                        }
                      />
                      Standards
                    </label>
                    <label className="test-builder-toggle">
                      <input
                        type="checkbox"
                        checked={getInstructionOptions(selectedTest.test.print_settings).show_suggested_time}
                        onChange={(event) =>
                          onUpdateTest(
                            updateInstructionOptions(selectedTest.test, {
                              show_suggested_time: event.target.checked,
                            }),
                          )
                        }
                      />
                      Time
                    </label>
                    <label className="test-builder-toggle">
                      <input
                        type="checkbox"
                        checked={getInstructionOptions(selectedTest.test.print_settings).horizontal_line}
                        onChange={(event) =>
                          onUpdateTest(
                            updateInstructionOptions(selectedTest.test, {
                              horizontal_line: event.target.checked,
                            }),
                          )
                        }
                      />
                      Horizontal line
                    </label>
                  </div>
                  <div className="test-template-editor-row">
                    <label>
                      Justification
                      <select
                        value={getInstructionOptions(selectedTest.test.print_settings).alignment}
                        onChange={(event) =>
                          onUpdateTest(
                            updateInstructionOptions(selectedTest.test, {
                              alignment: event.target.value as TestInstructionSectionOptionsModel["alignment"],
                            }),
                          )
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </label>
                    <label>
                      Space After
                      <input
                        type="number"
                        min={0}
                        max={6}
                        value={getInstructionOptions(selectedTest.test.print_settings).spacing_after_lines}
                        onChange={(event) =>
                          onUpdateTest(
                            updateInstructionOptions(selectedTest.test, {
                              spacing_after_lines: Number(event.target.value),
                            }),
                          )
                        }
                      />
                    </label>
                  </div>
                </details>
              </div>
              <div className="test-instruction-section-editor">
                <h3>Instruction Sections</h3>
                {getInstructionSections(selectedTest.test.print_settings).map((section) => (
                  <article key={section.question_type} className="test-instruction-section-card">
                    <div className="test-instruction-section-fields">
                      <label>
                        Style
                        <input value={section.question_type} readOnly />
                      </label>
                      <label>
                        Header
                        <input
                          value={section.title}
                          onChange={(event) =>
                            onUpdateTest(
                              updateInstructionSection(selectedTest.test, section.question_type, {
                                title: event.target.value,
                              }),
                            )
                          }
                        />
                      </label>
                      <label className="test-instruction-text">
                        Instructions
                        <textarea
                          value={section.instructions}
                          onChange={(event) =>
                            onUpdateTest(
                              updateInstructionSection(selectedTest.test, section.question_type, {
                                instructions: event.target.value,
                              }),
                            )
                          }
                        />
                      </label>
                      <label className="test-instruction-text">
                        Header Template
                        <textarea
                          value={
                            section.header_template ??
                            "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}"
                          }
                          onChange={(event) =>
                            onUpdateTest(
                              updateInstructionSection(selectedTest.test, section.question_type, {
                                header_template: event.target.value,
                              }),
                            )
                          }
                        />
                      </label>
                      <label>
                        Suggested Time
                        <select
                          value={section.suggested_time_mode ?? "calculated"}
                          onChange={(event) =>
                            onUpdateTest(
                              updateInstructionSection(selectedTest.test, section.question_type, {
                                suggested_time_mode: event.target.value as "calculated" | "override",
                              }),
                            )
                          }
                        >
                          <option value="calculated">Calculated</option>
                          <option value="override">Override</option>
                        </select>
                      </label>
                      {section.suggested_time_mode === "override" ? (
                        <label>
                          Override Minutes
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={Math.round((section.suggested_time_sec ?? 0) / 60)}
                            onChange={(event) =>
                              onUpdateTest(
                                updateInstructionSection(selectedTest.test, section.question_type, {
                                  suggested_time_sec: Number(event.target.value) * 60 || null,
                                }),
                              )
                            }
                          />
                        </label>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </details>

            <section className="test-balance-panel">
              <h3>Balance</h3>
              <div className="test-balance-columns">
                <div>
                  <strong>Type</strong>
                  {Object.entries(selectedTest.summary.question_type_counts).map(([type, count]) => (
                    <span key={type}>{type}: {count}</span>
                  ))}
                </div>
                <div>
                  <strong>Difficulty</strong>
                  {Object.entries(selectedTest.summary.difficulty_counts).map(([difficulty, count]) => (
                    <span key={difficulty}>D{difficulty}: {count}</span>
                  ))}
                </div>
                <div>
                  <strong>Standards</strong>
                  {selectedTest.summary.standard_balance.map((standard) => (
                    <span key={standard.standard_id}>
                      {standard.standard_id}: {standard.question_count}, {formatMinutes(standard.total_time_estimate_sec)}
                    </span>
                  ))}
                </div>
              </div>
            </section>

            <details className="test-json-panel">
              <summary>Test JSON</summary>
              <div className="test-json-controls">
                <div className="test-json-mode" role="group" aria-label="JSON contents">
                  <button
                    type="button"
                    className={jsonMode === "full" ? "active" : ""}
                    aria-pressed={jsonMode === "full"}
                    onClick={() => setJsonMode("full")}
                  >
                    Test + Questions
                  </button>
                  <button
                    type="button"
                    className={jsonMode === "questions" ? "active" : ""}
                    aria-pressed={jsonMode === "questions"}
                    onClick={() => setJsonMode("questions")}
                  >
                    Questions Only
                  </button>
                </div>
                <div className="test-json-actions">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(jsonDraft).then(
                        () => setJsonCopied(true),
                        () => setJsonCopied(false),
                      );
                    }}
                  >
                    {jsonCopied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setJsonDraft(jsonForMode);
                      setJsonDirty(false);
                    }}
                    disabled={!jsonDirty}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onApplyTestJson(selectedTest.test.id, jsonDraft);
                      setJsonDirty(false);
                    }}
                    disabled={loading || !jsonDirty}
                  >
                    Apply
                  </button>
                </div>
              </div>
              <p className="test-json-help">
                {questionItemCount === 0
                  ? "This test has no questions yet, so pasting a batch of question JSON here creates those questions in the bank and adds them to the test."
                  : "Editing settings here updates the test. Pasted questions are ignored while the test already has questions."}
              </p>
              <textarea
                className="test-json-editor"
                value={jsonDraft}
                spellCheck={false}
                onChange={(event) => {
                  setJsonDraft(event.target.value);
                  setJsonDirty(true);
                  setJsonCopied(false);
                }}
              />
            </details>

            <section className="test-item-list">
              <div className="test-item-list-header">
                <h3>Items</h3>
                <div className="test-sort-actions">
                  <button
                    type="button"
                    onClick={addSortRule}
                    disabled={availableSortFields.length === 0}
                    title={
                      availableSortFields.length === 0
                        ? "Every sort option is already in use"
                        : "Add a sort level"
                    }
                  >
                    Add Sort
                  </button>
                  {sortRules.length > 0 ? (
                    <button
                      type="button"
                      onClick={applySortRules}
                      disabled={loading || questionItemCount === 0}
                    >
                      Apply Sort
                    </button>
                  ) : null}
                </div>
              </div>

              {sortRules.length > 0 ? (
                <div className="test-sort-rules">
                  {sortRules.map((rule, ruleIndex) => {
                    const order = effectiveSortOrder(
                      rule,
                      selectedTest.test.items,
                      questionById,
                    );
                    return (
                      <div key={`${rule.field}-${ruleIndex}`} className="test-sort-rule">
                        <span className="test-sort-rank">{ruleIndex === 0 ? "Sort by" : "then by"}</span>
                        <select
                          value={rule.field}
                          onChange={(event) =>
                            updateSortRule(ruleIndex, {
                              field: event.target.value as SortField,
                              order: [],
                            })
                          }
                        >
                          {SORT_FIELDS.filter(
                            (field) => field === rule.field || availableSortFields.includes(field),
                          ).map((field) => (
                            <option key={field} value={field}>
                              {SORT_FIELD_LABEL[field]}
                            </option>
                          ))}
                        </select>

                        {isManualOrderField(rule.field) ? (
                          <div className="test-sort-manual">
                            {order.length === 0 ? (
                              <span className="test-sort-manual-empty">
                                No values in this test yet
                              </span>
                            ) : (
                              order.map((value, valueIndex) => (
                                <span key={value || "(none)"} className="test-sort-value">
                                  {value || "(none)"}
                                  <button
                                    type="button"
                                    aria-label="Move earlier"
                                    onClick={() => moveSortValue(ruleIndex, valueIndex, -1)}
                                    disabled={valueIndex === 0}
                                  >
                                    &uarr;
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="Move later"
                                    onClick={() => moveSortValue(ruleIndex, valueIndex, 1)}
                                    disabled={valueIndex === order.length - 1}
                                  >
                                    &darr;
                                  </button>
                                </span>
                              ))
                            )}
                          </div>
                        ) : (
                          <select
                            value={rule.direction}
                            onChange={(event) =>
                              updateSortRule(ruleIndex, {
                                direction: event.target.value as "asc" | "desc",
                              })
                            }
                          >
                            <option value="asc">Increasing</option>
                            <option value="desc">Decreasing</option>
                          </select>
                        )}

                        <button
                          type="button"
                          className="test-sort-remove"
                          onClick={() => removeSortRule(ruleIndex)}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                  <p className="test-sort-hint">
                    Apply Sort rewrites the item order. Questions stay inside their section.
                  </p>
                </div>
              ) : null}

              {selectedTest.test.items.length === 0 ? (
                <p className="test-builder-empty">Add questions from the question list.</p>
              ) : (
                selectedTest.test.items.map((item, index) => {
                  if (isSectionItem(item)) {
                    const sectionQuestionType = item.question_type ?? "";
                    return (
                      <article
                        key={`${item.section_id ?? item.title ?? "section"}-${index}`}
                        className="test-item-row test-section-item-row"
                      >
                        <div className="test-section-item-header">
                          <strong>Section</strong>
                          <span>{item.title || "Untitled section"}</span>
                        </div>
                        <div className="test-section-item-fields">
                          <label>
                            Header
                            <input
                              value={item.title ?? ""}
                              onChange={(event) => updateItem(index, { title: event.target.value })}
                            />
                          </label>
                          <label>
                            Style Defaults
                            <select
                              value={sectionQuestionType}
                              onChange={(event) =>
                                updateItem(index, {
                                  question_type: (event.target.value || null) as QuestionType | null,
                                })
                              }
                            >
                              <option value="">Manual</option>
                              {QUESTION_TYPE_ORDER.map((questionType) => (
                                <option key={questionType} value={questionType}>
                                  {questionType}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Topic Text
                            <input
                              value={item.topic ?? ""}
                              onChange={(event) =>
                                updateItem(index, { topic: event.target.value || null })
                              }
                            />
                          </label>
                          <label>
                            Standards Text
                            <input
                              value={(item.standards ?? []).join(", ")}
                              onChange={(event) =>
                                updateItem(index, { standards: parseStandardText(event.target.value) })
                              }
                            />
                          </label>
                          <label className="test-instruction-text">
                            Instructions
                            <textarea
                              value={item.instructions ?? ""}
                              onChange={(event) =>
                                updateItem(index, { instructions: event.target.value })
                              }
                            />
                          </label>
                          <label className="test-instruction-text">
                            Header Template
                            <textarea
                              value={
                                item.header_template ??
                                "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}"
                              }
                              onChange={(event) =>
                                updateItem(index, { header_template: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            Suggested Time
                            <select
                              value={item.suggested_time_mode ?? "calculated"}
                              onChange={(event) =>
                                updateItem(index, {
                                  suggested_time_mode: event.target.value as "calculated" | "override",
                                })
                              }
                            >
                              <option value="calculated">Calculated</option>
                              <option value="override">Override</option>
                            </select>
                          </label>
                          {item.suggested_time_mode === "override" ? (
                            <label>
                              Override Minutes
                              <input
                                type="number"
                                min={0}
                                step={1}
                                value={Math.round((item.suggested_time_sec ?? 0) / 60)}
                                onChange={(event) =>
                                  updateItem(index, {
                                    suggested_time_sec: Number(event.target.value) * 60 || null,
                                  })
                                }
                              />
                            </label>
                          ) : null}
                        </div>
                        <div className="test-item-actions">
                          <button type="button" onClick={() => moveItem(index, -1)} disabled={index === 0}>
                            Up
                          </button>
                          <button
                            type="button"
                            onClick={() => moveItem(index, 1)}
                            disabled={index === selectedTest.test.items.length - 1}
                          >
                            Down
                          </button>
                          <button type="button" onClick={() => removeItem(index)}>
                            Remove
                          </button>
                        </div>
                      </article>
                    );
                  }

                  const question = item.question_id ? questionById[item.question_id] : undefined;
                  return (
                    <article key={`${item.question_id ?? "question"}-${index}`} className="test-item-row">
                      <div>
                        <strong>{index + 1}. {item.question_id}</strong>
                        <span>
                          {question
                            ? `${question.type} / Difficulty ${question.difficulty} / ${question.topic}`
                            : "Question not found"}
                        </span>
                      </div>
                      <label className="test-builder-toggle">
                        <input
                          type="checkbox"
                          checked={item.experimental ?? false}
                          onChange={(event) =>
                            updateItem(index, { experimental: event.target.checked })
                          }
                        />
                        Experimental
                      </label>
                      <div className="test-item-actions">
                        <button type="button" onClick={() => moveItem(index, -1)} disabled={index === 0}>
                          Up
                        </button>
                        <button
                          type="button"
                          onClick={() => moveItem(index, 1)}
                          disabled={index === selectedTest.test.items.length - 1}
                        >
                          Down
                        </button>
                        <button type="button" onClick={() => removeItem(index)}>
                          Remove
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          </div>
          </>
          )}
        </div>
      )}

      {archiveCandidate ? (
        <div
          className="test-copy-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Archive test"
        >
          <div className="test-copy-dialog">
            <h3>Archive this test?</h3>
            <p>
              <strong>{archiveCandidate.test.title}</strong> - Version{" "}
              {archiveCandidate.test.version}
            </p>
            <p>
              Archiving takes it off the desk. Nothing is deleted: the test stays in the bank
              with its questions and settings, and you can put it back any time from Archive
              in the test list.
            </p>
            <div className="test-copy-actions">
              <button type="button" onClick={() => setArchiveCandidate(null)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setArchiveBrowserOpen(true);
                  setArchiveCandidate(null);
                }}
              >
                Browse Archive
              </button>
              <button
                type="button"
                onClick={() => {
                  onArchiveTest(archiveCandidate.test.id);
                  setArchiveCandidate(null);
                }}
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {archiveBrowserOpen ? (
        <div
          className="test-copy-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Test archive"
        >
          <div className="test-copy-dialog test-archive-dialog">
            <h3>Archive</h3>
            <p>
              Tests in this bank that are not on the desk right now. Reopening one puts it back
              exactly as it was.
            </p>
            {archivedTests.length === 0 ? (
              <p className="test-builder-empty">Nothing archived - every test is on the desk.</p>
            ) : (
              <div className="test-archive-list">
                {archivedTests.map((detail) => (
                  <div className="test-archive-row" key={detail.test.id}>
                    <div>
                      <strong>{detail.test.title}</strong>
                      <span>
                        Version {detail.test.version} -{" "}
                        {detail.test.items.filter(isQuestionItem).length} questions
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenTest(detail.test.id);
                        setArchiveBrowserOpen(false);
                      }}
                    >
                      Reopen
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="test-copy-actions">
              <button type="button" onClick={() => setArchiveBrowserOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {copyDialogOpen && selectedTest ? (
        <div className="test-copy-backdrop" role="dialog" aria-modal="true" aria-label="Save test as copy">
          <div className="test-copy-dialog">
            <h3>Save as Copy</h3>
            <p>
              Makes a new test draft from what is on screen now. Use it when a test shared
              with another course needs to change for only one of them.
            </p>

            <label>
              Title
              <input value={copyTitle} onChange={(event) => setCopyTitle(event.target.value)} />
            </label>
            <label className="test-version-field">
              Version
              <input value={copyVersion} onChange={(event) => setCopyVersion(event.target.value)} />
            </label>

            {selectedTest.test.course_ids.length > 0 ? (
              <fieldset className="test-copy-courses">
                <legend>Courses for the copy</legend>
                {assignedCourses.map((course) => (
                  <label key={course.id}>
                    <input
                      type="checkbox"
                      checked={copyCourseIds.includes(course.id)}
                      onChange={() =>
                        setCopyCourseIds((ids) =>
                          ids.includes(course.id)
                            ? ids.filter((id) => id !== course.id)
                            : [...ids, course.id],
                        )
                      }
                    />
                    {course.title}
                  </label>
                ))}
              </fieldset>
            ) : null}

            <label className="test-copy-toggle">
              <input
                type="checkbox"
                checked={copyDetachFromSource}
                onChange={(event) => setCopyDetachFromSource(event.target.checked)}
              />
              Move those courses off the original
            </label>
            <label className="test-copy-toggle">
              <input
                type="checkbox"
                checked={copyRestoreOriginal}
                onChange={(event) => setCopyRestoreOriginal(event.target.checked)}
                disabled={!testEdited}
              />
              Put the original back the way it was when opened
              {testEdited ? null : <span className="test-copy-note"> (no edits yet)</span>}
            </label>

            <div className="test-copy-actions">
              <button type="button" onClick={() => setCopyDialogOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={submitCopy} disabled={loading}>
                Create Copy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default TestBuilderPane;
