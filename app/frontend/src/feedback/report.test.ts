import { describe, expect, it } from "vitest";

import { describeOs, emptyDraft, hasContent, mailtoUrl, MAILTO_LIMIT, reportBody, reportSubject, type SystemInfo } from "./report";

const system: SystemInfo = { appVersion: "0.18.0", backendVersion: "0.18.0", os: "macOS", window: "main", screen: "1440×900" };

describe("feedback reports", () => {
  const bug = {
    ...emptyDraft("Drawing tool"),
    summary: "Arc jumps when dragged",
    details: "The end handle jumps to the other side.",
    expected: "It follows the pointer.",
    steps: "1. Draw an arc\n2. Drag its end past 180°",
    name: "Ms. Rivera",
    screenshot: "arc.png",
  };

  it("has a subject that says the version, type, area and summary", () => {
    expect(reportSubject(bug, "0.18.0")).toBe("[Nexam beta 0.18.0] Bug · Drawing tool: Arc jumps when dragged");
    expect(reportSubject({ ...emptyDraft("Other"), kind: "general", details: "Love it\nmore" }, "0.18.0")).toBe(
      "[Nexam beta 0.18.0] Feedback · Other: Love it",
    );
  });

  it("lays out the sections for its kind, then the system line", () => {
    const body = reportBody(bug, system);
    expect(body).toBe(
      [
        "Type: Bug",
        "Area: Drawing tool",
        "Summary: Arc jumps when dragged",
        "",
        "What happened?",
        "The end handle jumps to the other side.",
        "",
        "What did you expect?",
        "It follows the pointer.",
        "",
        "Steps to make it happen",
        "1. Draw an arc\n2. Drag its end past 180°",
        "",
        "Screenshot: arc.png (attached)",
        "",
        "From: Ms. Rivera",
        "",
        "--",
        "Nexam 0.18.0 · macOS · main window · 1440×900",
      ].join("\n"),
    );
  });

  it("leaves out system details when asked, and empty sections", () => {
    const body = reportBody({ ...emptyDraft("Courses"), kind: "suggestion", details: "Copy a course", includeSystem: false }, system);
    expect(body).toBe("Type: Suggestion\nArea: Courses\n\nWhat would you like?\nCopy a course");
    expect(hasContent(emptyDraft("Courses"))).toBe(false);
  });

  it("notes a backend version that differs from the app's", () => {
    expect(reportBody(bug, { ...system, backendVersion: "0.17.1" })).toContain("Nexam 0.18.0 (backend 0.17.1)");
  });

  it("builds a mailto link, and a short one when the report is long", () => {
    const short = mailtoUrl("me@example.com", "Hi & bye", "Line 1\nLine 2");
    expect(short.truncated).toBe(false);
    expect(short.url).toBe("mailto:me%40example.com?subject=Hi%20%26%20bye&body=Line%201%0ALine%202");
    const long = mailtoUrl("me@example.com", "Report", "x".repeat(MAILTO_LIMIT));
    expect(long.truncated).toBe(true);
    expect(long.url.length).toBeLessThan(MAILTO_LIMIT);
    expect(decodeURIComponent(long.url)).toContain("on your clipboard");
  });

  it("names the operating system", () => {
    expect(describeOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", true)).toBe("macOS");
    expect(describeOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120", false)).toBe(
      "Windows, Edge",
    );
  });
});
