import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  attachStandardToCourse,
  deleteCourse,
  detachStandardFromCourse,
  getCourseDetail,
  listCourses,
  listSourceStandardLists,
  listStandards,
  listTestDrafts,
  seedCourseFrom,
  setTestCourses,
  upsertCourse,
} from "./api";
import type {
  CourseDetailModel,
  CourseModel,
  CourseStandardCoverageModel,
  SourceStandardListModel,
  StandardRecordModel,
  TestDraftDetailModel,
} from "./types";

const PANE_SYNC_CHANNEL = "nexzam-pane-sync";

type CourseSection = "standards" | "tests" | "coverage";

const COURSE_SECTIONS: CourseSection[] = ["standards", "tests", "coverage"];
const COURSE_SECTION_LABEL: Record<CourseSection, string> = {
  standards: "Standards",
  tests: "Tests",
  coverage: "Coverage",
};

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface CoursesWorkspaceProps {
  /** Called after any change so the shell can mark the working copy dirty. */
  onChanged?: () => void;
}

/** One standard in a coverage list, with how many questions reach it. */
function CoverageRow({
  coverage,
  sourceLabel,
  children,
}: {
  coverage: CourseStandardCoverageModel;
  sourceLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="course-coverage-row">
      <span className="standards-cell-code">{coverage.code ?? coverage.standard_id}</span>
      <span className="standards-cell-statement">
        {coverage.statement ?? "Standard not found in the library."}
      </span>
      <span className="standards-cell-source">{sourceLabel}</span>
      <span className="standards-cell-strand">{coverage.strand ?? "-"}</span>
      <span
        className={`course-coverage-count ${coverage.question_count === 0 ? "empty" : ""}`}
        title={
          coverage.test_ids.length > 0
            ? `On ${coverage.test_ids.join(", ")}`
            : "Not on any test in this course"
        }
      >
        {coverage.question_count}&times;
        {coverage.test_count > 0 ? (
          <small>
            {" "}
            on {coverage.test_count} {coverage.test_count === 1 ? "test" : "tests"}
          </small>
        ) : null}
      </span>
      <span className="standards-cell-actions">{children}</span>
    </div>
  );
}

function CoverageHead() {
  return (
    <div className="course-coverage-row course-coverage-head">
      <span>Short Name</span>
      <span>Standard Text</span>
      <span>Source</span>
      <span>Strand</span>
      <span>Questions</span>
      <span />
    </div>
  );
}

export default function CoursesWorkspace({ onChanged }: CoursesWorkspaceProps) {
  const [courses, setCourses] = useState<CourseModel[]>([]);
  const [detail, setDetail] = useState<CourseDetailModel | null>(null);
  const [standards, setStandards] = useState<StandardRecordModel[]>([]);
  const [sourceLists, setSourceLists] = useState<SourceStandardListModel[]>([]);
  const [tests, setTests] = useState<TestDraftDetailModel[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [section, setSection] = useState<CourseSection>("standards");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [creatingCourse, setCreatingCourse] = useState(false);
  // "Start from" seeding for a brand-new course. Standards are copied; tests are
  // associated, so one test can report coverage for the old course and the new.
  const [seedSourceCourseId, setSeedSourceCourseId] = useState("");
  const [seedStandards, setSeedStandards] = useState(true);
  const [seedTests, setSeedTests] = useState(true);
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySourceId, setLibrarySourceId] = useState("");
  const [libraryStrand, setLibraryStrand] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    channelRef.current = new BroadcastChannel(PANE_SYNC_CHANNEL);
    return () => {
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, []);

  const refreshLists = useCallback(async () => {
    setLoading(true);
    try {
      const [courseResponse, standardsResponse, sourceResponse, testResponse] = await Promise.all([
        listCourses(),
        listStandards(),
        listSourceStandardLists(),
        listTestDrafts(),
      ]);
      setCourses(courseResponse.items);
      setStandards(standardsResponse.items);
      setSourceLists(sourceResponse.items);
      setTests(testResponse.items);
      setErrorMessage("");
      return courseResponse.items;
    } catch (error) {
      setErrorMessage((error as Error).message);
      return [] as CourseModel[];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (courseId: string) => {
    if (!courseId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await getCourseDetail(courseId));
      setErrorMessage("");
    } catch (error) {
      setDetail(null);
      setErrorMessage((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const items = await refreshLists();
      if (items.length > 0) setSelectedCourseId((current) => current || items[0].id);
    })();
  }, [refreshLists]);

  useEffect(() => {
    void refreshDetail(selectedCourseId);
  }, [refreshDetail, selectedCourseId]);

  useEffect(() => {
    if (creatingCourse) return;
    const course = courses.find((item) => item.id === selectedCourseId);
    setDraftTitle(course?.title ?? "");
    setDraftDescription(course?.description ?? "");
  }, [courses, creatingCourse, selectedCourseId]);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const sourceTitleById = useMemo(
    () => Object.fromEntries(sourceLists.map((item) => [item.id, item.title])),
    [sourceLists],
  );

  function sourceLabelFor(sourceListId?: string | null): string {
    if (!sourceListId) return "-";
    return sourceTitleById[sourceListId] ?? sourceListId;
  }

  const availableStrands = useMemo(() => {
    const found = new Set<string>();
    for (const standard of standards) {
      const strand = (standard.strand ?? "").trim();
      if (strand) found.add(strand);
    }
    return Array.from(found).sort((left, right) => left.localeCompare(right));
  }, [standards]);

  const courseStandardIds = useMemo(
    () => new Set(detail?.course.standard_refs.map((reference) => reference.standard_id) ?? []),
    [detail],
  );

  /** The library, filtered for picking standards into the current course. */
  const libraryResults = useMemo(() => {
    const needle = librarySearch.trim().toLowerCase();
    return standards.filter((standard) => {
      if (librarySourceId && standard.source_list_id !== librarySourceId) return false;
      if (libraryStrand && (standard.strand ?? "").trim() !== libraryStrand) return false;
      if (!needle) return true;
      const haystack = [
        standard.id,
        standard.code,
        standard.statement,
        standard.subject ?? "",
        standard.strand ?? "",
        standard.grade_band ?? "",
        standard.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [libraryStrand, librarySearch, librarySourceId, standards]);

  // A lineage row names its primary version in `test_id`, so membership has to
  // come from `test_ids` -- otherwise every version but the first reads as
  // unattached.
  const attachedTestIds = useMemo(
    () => new Set(detail?.tests.flatMap((item) => item.test_ids) ?? []),
    [detail],
  );

  async function runMutation(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setErrorMessage("");
      onChanged?.();
      // Keeps the main window's dirty state and course list honest when this
      // view is running in its own window.
      channelRef.current?.postMessage({ type: "courses-data-changed" });
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleStartNewCourse() {
    setCreatingCourse(true);
    setSelectedCourseId("");
    setDetail(null);
    setDraftTitle("");
    setDraftDescription("");
    setSeedSourceCourseId("");
    setSeedStandards(true);
    setSeedTests(true);
    setErrorMessage("");
  }

  async function handleSaveCourse() {
    const title = draftTitle.trim();
    if (!title) {
      setErrorMessage("Course name is required.");
      return;
    }

    const courseId = selectedCourseId || normalizeId(title);
    if (!courseId) {
      setErrorMessage("Course name must produce a valid course id.");
      return;
    }
    if (!selectedCourseId && courses.some((course) => course.id === courseId)) {
      setErrorMessage(`A course named ${title} already exists.`);
      return;
    }

    const seedSource = creatingCourse
      ? courses.find((course) => course.id === seedSourceCourseId)
      : undefined;
    const seeding = Boolean(seedSource) && (seedStandards || seedTests);

    await runMutation(async () => {
      const saved = await upsertCourse(courseId, {
        title,
        description: draftDescription.trim() || null,
        standard_refs: detail?.course.standard_refs ?? [],
      });

      if (seeding && seedSource) {
        await seedCourseFrom(saved.id, {
          source_course_id: seedSource.id,
          include_standards: seedStandards,
          include_tests: seedTests,
        });
      }

      setCreatingCourse(false);
      setSeedSourceCourseId("");
      await refreshLists();
      setSelectedCourseId(saved.id);
      await refreshDetail(saved.id);
      setStatusMessage(
        seeding && seedSource
          ? `Created ${saved.title} from ${seedSource.title}.`
          : `Saved ${saved.title}.`,
      );
    });
  }

  async function handleDeleteCourse() {
    if (!detail) return;
    const confirmed = window.confirm(
      `Delete ${detail.course.title}? Its standards stay in the library, and its tests stay in the bank.`,
    );
    if (!confirmed) return;

    await runMutation(async () => {
      await deleteCourse(detail.course.id);
      const remaining = await refreshLists();
      const nextId = remaining[0]?.id ?? "";
      setSelectedCourseId(nextId);
      await refreshDetail(nextId);
      setStatusMessage(`Deleted ${detail.course.title}.`);
    });
  }

  async function handleToggleStandard(standardId: string) {
    if (!detail) return;
    const courseId = detail.course.id;

    await runMutation(async () => {
      if (courseStandardIds.has(standardId)) {
        await detachStandardFromCourse(courseId, standardId);
        setStatusMessage(`Removed ${standardId} from ${detail.course.title}.`);
      } else {
        await attachStandardToCourse(courseId, standardId);
        setStatusMessage(`Added ${standardId} to ${detail.course.title}.`);
      }
      await refreshLists();
      await refreshDetail(courseId);
    });
  }

  async function handleToggleTest(test: TestDraftDetailModel) {
    if (!detail) return;
    const courseId = detail.course.id;
    const alreadyAttached = test.test.course_ids.includes(courseId);
    const nextCourseIds = alreadyAttached
      ? test.test.course_ids.filter((item) => item !== courseId)
      : [...test.test.course_ids, courseId];

    await runMutation(async () => {
      await setTestCourses(test.test.id, nextCourseIds);
      setStatusMessage(
        alreadyAttached
          ? `Removed ${test.test.title} from ${detail.course.title}.`
          : `Added ${test.test.title} to ${detail.course.title}.`,
      );
      await refreshLists();
      await refreshDetail(courseId);
    });
  }

  const standardCount = detail?.course.standard_refs.length ?? 0;
  const coveredCount = detail?.covered_standards.length ?? 0;
  const blindSpotCount = detail?.uncovered_standards.length ?? 0;

  return (
    <div className="courses-workspace">
      <header className="standards-header">
        <div>
          <h1>Courses</h1>
          <p>
            A course is a named set of standards you actually teach, plus the tests that assess
            them. Use it to see what your tests cover and what they miss.
          </p>
          <div className="standards-header-summary">
            <span className="bank-assets-count">
              {courses.length} {courses.length === 1 ? "course" : "courses"}
            </span>
            {detail ? (
              <>
                <span className="bank-assets-count">{standardCount} standards</span>
                <span className="bank-assets-count">
                  {detail.tests.length} {detail.tests.length === 1 ? "test" : "tests"}
                </span>
                <span className={`bank-assets-count ${blindSpotCount > 0 ? "warning" : ""}`}>
                  {blindSpotCount} not covered
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="standards-header-actions">
          <button type="button" onClick={() => void refreshLists()} disabled={loading || busy}>
            Refresh
          </button>
          <button type="button" onClick={handleStartNewCourse} disabled={busy}>
            New Course
          </button>
          {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
          {errorMessage ? <span className="status-pill error">{errorMessage}</span> : null}
        </div>
      </header>

      <div className="courses-layout">
        <aside className="standards-panel courses-list-panel">
          <div className="standards-panel-header">
            <h2>All Courses</h2>
            <span className="bank-assets-count">{courses.length}</span>
          </div>
          {courses.length === 0 ? (
            <div className="standards-library-empty">
              <strong>No courses yet</strong>
              <p>
                Choose New Course, give it a name, then pull standards in from the library and
                attach the tests that assess them.
              </p>
            </div>
          ) : null}
          <div className="standards-source-list">
            {courses.map((course) => {
              // Count test lineages, not drafts: three versions of one exam is
              // one test here, the same way coverage counts it.
              const testCount = new Set(
                tests
                  .filter((item) => item.test.course_ids.includes(course.id))
                  .map((item) => item.test.title.trim().toLowerCase()),
              ).size;
              return (
                <button
                  key={course.id}
                  type="button"
                  className={`standards-list-row ${
                    selectedCourseId === course.id ? "selected" : ""
                  }`}
                  onClick={() => {
                    setCreatingCourse(false);
                    setSelectedCourseId(course.id);
                  }}
                >
                  <strong>{course.title}</strong>
                  <span>{course.standard_refs.length} standards</span>
                  <span>
                    {testCount} {testCount === 1 ? "test" : "tests"}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="standards-panel courses-detail-panel">
          <div className="standards-panel-header">
            <div>
              <h2>{creatingCourse ? "New Course" : detail?.course.title ?? "No course selected"}</h2>
              <p>
                {creatingCourse
                  ? "Name the course, then build it up \u2014 from scratch, or starting from a course you already teach."
                  : detail
                    ? `${coveredCount} of ${standardCount} standards covered by ${detail.tests.length} ${
                        detail.tests.length === 1 ? "test" : "tests"
                      }.`
                    : "Pick a course on the left, or create a new one."}
              </p>
            </div>
          </div>

          {creatingCourse || detail ? (
            <div className="courses-detail-form">
              <label>
                Course Name
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="Physics 1"
                />
              </label>
              <label className="courses-detail-description">
                Description
                <textarea
                  className="standards-description-input"
                  value={draftDescription}
                  onChange={(event) => setDraftDescription(event.target.value)}
                  placeholder="What this course covers"
                />
              </label>
              {creatingCourse && courses.length > 0 ? (
                <section className="course-seed-block">
                  <label className="course-seed-source">
                    Start From
                    <select
                      value={seedSourceCourseId}
                      onChange={(event) => setSeedSourceCourseId(event.target.value)}
                    >
                      <option value="">Empty course</option>
                      {courses.map((course) => (
                        <option key={course.id} value={course.id}>
                          {course.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {seedSourceCourseId ? (
                    <>
                      <div className="course-seed-options">
                        <label>
                          <input
                            type="checkbox"
                            checked={seedStandards}
                            onChange={(event) => setSeedStandards(event.target.checked)}
                          />
                          Standards
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={seedTests}
                            onChange={(event) => setSeedTests(event.target.checked)}
                          />
                          Tests
                        </label>
                      </div>
                      <p className="course-seed-hint">
                        Tests are shared, not copied, so one test reports coverage for both
                        courses. Editing a shared test offers to save it as a separate copy.
                      </p>
                    </>
                  ) : null}
                </section>
              ) : null}

              <div className="standards-course-actions">
                {detail ? (
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void handleDeleteCourse()}
                    disabled={busy}
                  >
                    Delete
                  </button>
                ) : null}
                <button type="button" onClick={() => void handleSaveCourse()} disabled={busy}>
                  {busy ? "Saving..." : creatingCourse ? "Create Course" : "Save"}
                </button>
              </div>
            </div>
          ) : null}

          {detail ? (
            <>
              <div className="courses-section-tabs" role="tablist" aria-label="Course detail">
                {COURSE_SECTIONS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={section === key}
                    className={section === key ? "active" : ""}
                    onClick={() => setSection(key)}
                  >
                    {COURSE_SECTION_LABEL[key]}
                  </button>
                ))}
              </div>

              {section === "standards" ? (
                <>
                  <div className="standards-panel-header">
                    <div>
                      <h2>Course Standards</h2>
                      <p>The standards this course teaches, with how often its tests reach them.</p>
                    </div>
                    <span className="bank-assets-count">{standardCount}</span>
                  </div>
                  <div className="course-coverage-table">
                    <CoverageHead />
                    {[...detail.covered_standards, ...detail.uncovered_standards].map(
                      (coverage) => (
                        <CoverageRow
                          key={coverage.standard_id}
                          coverage={coverage}
                          sourceLabel={sourceLabelFor(coverage.source_list_id)}
                        >
                          <button
                            type="button"
                            onClick={() => void handleToggleStandard(coverage.standard_id)}
                            disabled={busy}
                          >
                            Remove
                          </button>
                        </CoverageRow>
                      ),
                    )}
                    {standardCount === 0 ? (
                      <p className="asset-empty">
                        No standards yet. Browse the library below and add the ones this course
                        teaches.
                      </p>
                    ) : null}
                  </div>

                  <div className="standards-panel-header">
                    <div>
                      <h2>Add From The Library</h2>
                      <p>Every standard in the bank. Adding one references it, never copies it.</p>
                    </div>
                    <span className="bank-assets-count">{libraryResults.length}</span>
                  </div>
                  <div className="standards-filter-row library">
                    <input
                      value={librarySearch}
                      onChange={(event) => setLibrarySearch(event.target.value)}
                      placeholder="Search the library"
                    />
                    <select
                      value={librarySourceId}
                      onChange={(event) => setLibrarySourceId(event.target.value)}
                      aria-label="Filter by source"
                    >
                      <option value="">All sources</option>
                      {sourceLists.map((sourceList) => (
                        <option key={sourceList.id} value={sourceList.id}>
                          {sourceList.title}
                        </option>
                      ))}
                    </select>
                    <select
                      value={libraryStrand}
                      onChange={(event) => setLibraryStrand(event.target.value)}
                      aria-label="Filter by strand"
                    >
                      <option value="">All strands</option>
                      {availableStrands.map((strand) => (
                        <option key={strand} value={strand}>
                          {strand}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="course-coverage-table course-library-picker">
                    {libraryResults.map((standard) => (
                      <div className="course-coverage-row" key={standard.id}>
                        <span className="standards-cell-code">{standard.code}</span>
                        <span className="standards-cell-statement">{standard.statement}</span>
                        <span className="standards-cell-source">
                          {sourceLabelFor(standard.source_list_id)}
                        </span>
                        <span className="standards-cell-strand">{standard.strand ?? "-"}</span>
                        <span className="standards-cell-muted">{standard.grade_band ?? "-"}</span>
                        <span className="standards-cell-actions">
                          <button
                            type="button"
                            onClick={() => void handleToggleStandard(standard.id)}
                            disabled={busy}
                          >
                            {courseStandardIds.has(standard.id) ? "Remove" : "Add"}
                          </button>
                        </span>
                      </div>
                    ))}
                    {libraryResults.length === 0 ? (
                      <p className="asset-empty">
                        Nothing in the library matches these filters.
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {section === "tests" ? (
                <>
                  <div className="standards-panel-header">
                    <div>
                      <h2>Course Tests</h2>
                      <p>
                        Tests assessing this course. A test can belong to more than one course, so
                        reusing one when a course is retaught does not take it away from anywhere
                        else. Versions of the same test count as one test toward coverage.
                      </p>
                    </div>
                    <span className="bank-assets-count">{detail.tests.length}</span>
                  </div>
                  <div className="course-test-list">
                    {tests.map((item) => {
                      const attached = attachedTestIds.has(item.test.id);
                      // Any version matches its lineage row, so a version that is
                      // not the primary still reports the lineage's coverage.
                      const summary = detail.tests.find((entry) =>
                        entry.test_ids.includes(item.test.id),
                      );
                      const siblingVersions = summary
                        ? summary.versions.filter((version) => version !== item.test.version)
                        : [];
                      return (
                        <div
                          key={item.test.id}
                          className={`course-test-row ${attached ? "attached" : ""}`}
                        >
                          <div>
                            <strong>
                              {item.test.title} <small>version {item.test.version}</small>
                              {siblingVersions.length > 0 ? (
                                <span
                                  className="course-test-version-tag"
                                  title={`Counted once with version${
                                    siblingVersions.length === 1 ? "" : "s"
                                  } ${siblingVersions.join(", ")}`}
                                >
                                  {summary?.versions.length} versions
                                </span>
                              ) : null}
                            </strong>
                            <span>
                              {summary
                                ? `${summary.question_count} questions${
                                    siblingVersions.length > 0 ? " (largest version)" : ""
                                  } - covers ${summary.course_standard_count} course standards, ${summary.extra_standard_count} beyond the course`
                                : `${item.summary.standard_ids.length} standards addressed`}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleToggleTest(item)}
                            disabled={busy}
                          >
                            {attached ? "Remove" : "Add To Course"}
                          </button>
                        </div>
                      );
                    })}
                    {tests.length === 0 ? (
                      <p className="asset-empty">
                        No tests in this bank yet. New tests can be assigned to a course as they
                        are created.
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {section === "coverage" ? (
                <>
                  <div className="courses-coverage-summary">
                    <div className="courses-stat">
                      <strong>{coveredCount}</strong>
                      <span>covered</span>
                    </div>
                    <div className={`courses-stat ${blindSpotCount > 0 ? "warning" : ""}`}>
                      <strong>{blindSpotCount}</strong>
                      <span>blind spots</span>
                    </div>
                    <div className="courses-stat">
                      <strong>{detail.extra_standards.length}</strong>
                      <span>beyond the course</span>
                    </div>
                    <div className="courses-stat">
                      <strong>{detail.question_count}</strong>
                      <span>questions on course tests</span>
                    </div>
                  </div>

                  <div className="standards-panel-header">
                    <div>
                      <h2>Blind Spots</h2>
                      <p>Course standards no question on a course test addresses yet.</p>
                    </div>
                    <span className={`bank-assets-count ${blindSpotCount > 0 ? "warning" : ""}`}>
                      {blindSpotCount}
                    </span>
                  </div>
                  <div className="course-coverage-table">
                    <CoverageHead />
                    {detail.uncovered_standards.map((coverage) => (
                      <CoverageRow
                        key={coverage.standard_id}
                        coverage={coverage}
                        sourceLabel={sourceLabelFor(coverage.source_list_id)}
                      />
                    ))}
                    {blindSpotCount === 0 ? (
                      <p className="asset-empty">
                        {standardCount === 0
                          ? "Add standards to this course to track coverage."
                          : "Every standard in this course is covered by at least one question."}
                      </p>
                    ) : null}
                  </div>

                  <div className="standards-panel-header">
                    <div>
                      <h2>Covered Standards</h2>
                      <p>Ordered by how many questions reach each one.</p>
                    </div>
                    <span className="bank-assets-count">{coveredCount}</span>
                  </div>
                  <div className="course-coverage-table">
                    <CoverageHead />
                    {detail.covered_standards.map((coverage) => (
                      <CoverageRow
                        key={coverage.standard_id}
                        coverage={coverage}
                        sourceLabel={sourceLabelFor(coverage.source_list_id)}
                      />
                    ))}
                    {coveredCount === 0 ? (
                      <p className="asset-empty">Nothing covered yet.</p>
                    ) : null}
                  </div>

                  <div className="standards-panel-header">
                    <div>
                      <h2>Beyond The Course</h2>
                      <p>
                        Standards these tests address that this course does not list. Reading and
                        writing standards often turn up here.
                      </p>
                    </div>
                    <span className="bank-assets-count">{detail.extra_standards.length}</span>
                  </div>
                  <div className="course-coverage-table">
                    <CoverageHead />
                    {detail.extra_standards.map((coverage) => (
                      <CoverageRow
                        key={coverage.standard_id}
                        coverage={coverage}
                        sourceLabel={sourceLabelFor(coverage.source_list_id)}
                      >
                        <button
                          type="button"
                          onClick={() => void handleToggleStandard(coverage.standard_id)}
                          disabled={busy}
                        >
                          Add To Course
                        </button>
                      </CoverageRow>
                    ))}
                    {detail.extra_standards.length === 0 ? (
                      <p className="asset-empty">
                        These tests stay inside the standards this course lists.
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
