// Which part of Nexam a window shows, so the feedback form starts on it.
// Pop-out windows say so in their URL (?pane=…, ?app=gradebook); the main
// window reports its current page with setFeedbackArea().

const PANE_AREAS: Record<string, string> = {
  questions: "Question editor",
  editor: "Question editor",
  assets: "Bank assets",
  standards: "Library (standards)",
  courses: "Courses",
  tests: "Test builder",
  "test-preview": "Printing / PDF",
  "response-sheet-print": "Printing / PDF",
  import: "Importing questions",
  drawing: "Drawing tool",
};

const PAGE_AREAS: Record<string, string> = {
  questions: "Question editor",
  tests: "Test builder",
  standards: "Library (standards)",
  courses: "Courses",
};

let mainWindowArea: string | null = null;

/** The main window's current page (questions, tests, standards, courses). */
export function setFeedbackArea(page: string): void {
  mainWindowArea = PAGE_AREAS[page] ?? null;
}

/** The window's name for a report ("main", "drawing", "gradebook", …). */
export function windowNameFrom(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get("app") === "gradebook") return "gradebook";
  return params.get("pane") ?? "main";
}

export function areaFor(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get("app") === "gradebook") return "Gradebook";
  const pane = params.get("pane");
  if (pane) return PANE_AREAS[pane] ?? "Other";
  return mainWindowArea ?? "Question editor";
}
