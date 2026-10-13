// A beta feedback report as plain text: what the tester wrote, plus
// (optionally) the app version, system and screen, laid out so it reads well
// in an email and pastes cleanly into a GitHub issue.

import type { FeedbackKind } from "./config";

export interface FeedbackDraft {
  kind: FeedbackKind;
  area: string;
  summary: string;
  /** Bug: what happened. Suggestion: the idea. General: the message. */
  details: string;
  /** Bug: what was expected. Suggestion: why it would help. */
  expected: string;
  /** Bug only: how to make it happen. */
  steps: string;
  name: string;
  includeSystem: boolean;
  /** File name of a screenshot the tester chose, to attach by hand. */
  screenshot: string | null;
}

export interface SystemInfo {
  appVersion: string;
  backendVersion: string | null;
  os: string;
  /** Which window it came from, e.g. "main" or "drawing". */
  window: string;
  screen: string;
}

export function emptyDraft(area: string): FeedbackDraft {
  return { kind: "bug", area, summary: "", details: "", expected: "", steps: "", name: "", includeSystem: true, screenshot: null };
}

/** The headings each kind's fields go under. */
export function fieldLabels(kind: FeedbackKind): { details: string; expected: string | null; steps: string | null } {
  if (kind === "bug") return { details: "What happened?", expected: "What did you expect?", steps: "Steps to make it happen (optional)" };
  if (kind === "suggestion") return { details: "What would you like?", expected: "How would it help you? (optional)", steps: null };
  return { details: "Your feedback", expected: null, steps: null };
}

const KIND_TITLE: Record<FeedbackKind, string> = { bug: "Bug", suggestion: "Suggestion", general: "Feedback" };

export function reportSubject(draft: FeedbackDraft, appVersion: string): string {
  const summary = draft.summary.trim() || firstLine(draft.details) || "(no summary)";
  return `[Nexam beta ${appVersion}] ${KIND_TITLE[draft.kind]} · ${draft.area}: ${summary}`;
}

export function reportBody(draft: FeedbackDraft, system: SystemInfo): string {
  const labels = fieldLabels(draft.kind);
  const sections: string[] = [`Type: ${KIND_TITLE[draft.kind]}`, `Area: ${draft.area}`];
  if (draft.summary.trim()) sections.push(`Summary: ${draft.summary.trim()}`);
  const block = (heading: string | null, text: string) => {
    if (heading && text.trim()) sections.push("", `${heading.replace(/ \(optional\)$/, "")}`, text.trim());
  };
  block(labels.details, draft.details);
  block(labels.expected, draft.expected);
  block(labels.steps, draft.steps);
  if (draft.screenshot) sections.push("", `Screenshot: ${draft.screenshot} (attached)`);
  if (draft.name.trim()) sections.push("", `From: ${draft.name.trim()}`);
  if (draft.includeSystem) {
    const backend = system.backendVersion && system.backendVersion !== system.appVersion ? ` (backend ${system.backendVersion})` : "";
    sections.push("", "--", `Nexam ${system.appVersion}${backend} · ${system.os} · ${system.window} window · ${system.screen}`);
  }
  return sections.join("\n");
}

/** Mail apps and Windows cut very long mailto links, so past this length the
 *  link carries a short note and the full report goes on the clipboard. */
export const MAILTO_LIMIT = 1800;

export function mailtoUrl(to: string, subject: string, body: string): { url: string; truncated: boolean } {
  const build = (text: string) => `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  const full = build(body);
  if (full.length <= MAILTO_LIMIT) return { url: full, truncated: false };
  return { url: build("The full report is on your clipboard. Paste it here (⌘V or Ctrl+V), then send.\n"), truncated: true };
}

export function hasContent(draft: FeedbackDraft): boolean {
  return (draft.summary + draft.details + draft.expected + draft.steps).trim() !== "";
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 70 ? `${line.slice(0, 67)}…` : line;
}

/** "macOS", "Windows", "Linux" (and the browser, outside the desktop app). */
export function describeOs(userAgent: string, desktop: boolean): string {
  const os = /Mac OS X|Macintosh/.test(userAgent)
    ? "macOS"
    : /Windows/.test(userAgent)
      ? "Windows"
      : /Linux/.test(userAgent)
        ? "Linux"
        : "Unknown OS";
  if (desktop) return os;
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "a browser";
  return `${os}, ${browser}`;
}
