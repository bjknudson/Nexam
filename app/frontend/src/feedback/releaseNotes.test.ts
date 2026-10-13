import { describe, expect, it } from "vitest";

import { compareVersions, notesUpTo, RELEASE_NOTES, unseenNotes, type ReleaseNote } from "./releaseNotes";

const notes: ReleaseNote[] = [
  { version: "0.17.0", date: "", highlights: ["a"] },
  { version: "0.18.0", date: "", highlights: ["b"] },
  { version: "0.19.0", date: "", highlights: ["c"] },
];

describe("release notes", () => {
  it("compare versions numerically", () => {
    expect(compareVersions("0.17.10", "0.17.9")).toBe(1);
    expect(compareVersions("0.18.0", "0.18")).toBe(0);
    expect(compareVersions("0.9.0", "0.17.0")).toBe(-1);
  });

  it("show what's newer than the last version seen, newest first, never future ones", () => {
    expect(unseenNotes("0.18.0", "0.17.0", notes).map((note) => note.version)).toEqual(["0.18.0"]);
    expect(unseenNotes("0.19.0", "0.17.0", notes).map((note) => note.version)).toEqual(["0.19.0", "0.18.0"]);
    expect(unseenNotes("0.18.0", "0.18.0", notes)).toEqual([]);
    expect(notesUpTo("0.18.5", notes).map((note) => note.version)).toEqual(["0.18.0", "0.17.0"]);
  });

  it("show just the current version's notes on a first launch", () => {
    expect(unseenNotes("0.19.0", null, notes).map((note) => note.version)).toEqual(["0.19.0"]);
  });

  it("are listed newest first in the source, each with highlights", () => {
    const versions = RELEASE_NOTES.map((note) => note.version);
    expect([...versions].sort((a, b) => compareVersions(b, a))).toEqual(versions);
    expect(RELEASE_NOTES.every((note) => note.highlights.length > 0)).toBe(true);
  });
});
