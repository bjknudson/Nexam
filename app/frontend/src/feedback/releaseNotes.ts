// What's new in each beta, newest first. Shown once after an update (and
// from Help ▸ What's New), so testers know what changed and what to retest.
// Add an entry with each release; `retest` lists what to try again.

export interface ReleaseNote {
  version: string;
  date: string;
  highlights: string[];
  /** Workflows worth trying again in this version. */
  retest?: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.17.2",
    date: "2026-10",
    highlights: [
      "Send Feedback: report a bug, suggest a feature or tell us anything, from the Help menu or the Feedback button.",
      "What's New: this window, after each update.",
    ],
    retest: ["Send a test report from Help ▸ Send Feedback… so we know it reaches us."],
  },
  {
    version: "0.17.0",
    date: "2026-10",
    highlights: [
      "Drawing tool: draw diagrams for questions, with variable arrows, bars and arcs that change with each question's values.",
      "Stamp library: physics and math stamps, stamp packs from a zip, search, resize, rotate and flip.",
      "Labels that follow shapes, symbols and math in text, alignment and layers.",
      "Bank Assets redesigned: thumbnails with real values, search inside drawings, topics and tags.",
    ],
    retest: ["Draw a free-body diagram and attach it to a question.", "Edit a drawing that more than one question uses."],
  },
];

/** -1, 0 or 1, comparing dotted versions numerically ("0.17.10" > "0.17.9"). */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Notes for versions up to `current`, newest first. */
export function notesUpTo(current: string, notes: ReleaseNote[] = RELEASE_NOTES): ReleaseNote[] {
  return notes.filter((note) => compareVersions(note.version, current) <= 0).sort((a, b) => compareVersions(b.version, a.version));
}

/** Notes to show on launch: those newer than the last version this tester
 *  saw (just the current one on a first launch); empty when nothing is new. */
export function unseenNotes(current: string, lastSeen: string | null, notes: ReleaseNote[] = RELEASE_NOTES): ReleaseNote[] {
  const upTo = notesUpTo(current, notes);
  if (lastSeen === null) return upTo.slice(0, 1);
  return upTo.filter((note) => compareVersions(note.version, lastSeen) > 0);
}
