/// <reference types="vite/client" />
// Beta feedback settings. The address reports are emailed to comes from the
// build (VITE_FEEDBACK_EMAIL), so it isn't written into the repository; a
// build without it still lets testers copy a report and send it themselves.
// See docs/beta-feedback.md.

export const FEEDBACK_EMAIL = ((import.meta.env.VITE_FEEDBACK_EMAIL as string | undefined) ?? "").trim();

/** Feedback types, in the order the form offers them. */
export const FEEDBACK_KINDS = [
  { id: "bug", label: "Bug", hint: "Something doesn't work as expected." },
  { id: "suggestion", label: "Suggestion", hint: "Something is missing, confusing, or could work better." },
  { id: "general", label: "General", hint: "Anything else: a question, a first impression, praise." },
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]["id"];

/** Parts of Nexam a report can be about. The form starts on the one the tester is using. */
export const FEEDBACK_AREAS = [
  "Question editor",
  "Test builder",
  "Library (standards)",
  "Courses",
  "Bank assets",
  "Drawing tool",
  "Importing questions",
  "Printing / PDF",
  "Gradebook",
  "Installing / updating",
  "Other",
];
