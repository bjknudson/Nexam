# Grading (.nxgb) format reference

This is the schema reference for the gradebook package, the way `docs/schema.md` is for a bank.
The design rationale (why a second package, why snapshots are frozen) lives in
`docs/grading-plan.md`; this doc only describes what's actually persisted.

## Why a second package

A `.bok` bank is a file teachers hand to each other. Student names, scans, and scores must never
be capable of riding along inside one -- not "remember not to export that," but structurally
impossible because the data never lives in a bank's package at all. A `.nxgb` gradebook is a
completely separate zipped-JSON package, opened and saved independently of any bank, with its own
`GradebookService` and its own workspace root. **Nothing in `app/backend/service.py`
(`BankWorkspaceService`) reads or writes anything under a gradebook's workspace, and nothing here
reads or writes anything under a bank's.** A regression test
(`app/backend/tests/test_privacy_boundary.py`) pins this down directly: it opens a bank and a
gradebook in the same process, exercises both, and asserts a saved `.bok` contains zero
roster/snapshot/scan/score data.

A gradebook is scoped to one class section/term (its own roster, its own file) -- not 1:1 with a
bank, since one bank may be taught to several sections or years.

## Package-level files

```
manifest.json                                # GradebookManifestModel
roster/students.json                         # StudentCollectionModel
snapshots/<snapshot_id>/snapshot.json        # AdministeredTestSnapshotModel (includes the sheet layout)
snapshots/<snapshot_id>/sheet.pdf            # the rendered response-sheet PDF for that snapshot
batches/<batch_id>.json                      # GradingBatchModel
scans/<batch_id>/<seq>.png                   # normalized (PNG) copies of every ingested scan page
```

All additive, one-collection-file-per-concern, matching a bank's own convention.

## Roster

```json
{
  "items": [
    { "id": "5e9c...", "first_name": "Ada", "last_name": "Lovelace", "external_id": "S-100" }
  ]
}
```

Deliberately minimal: no SIS import, no attendance, no grade history of its own (that's computed
from scan batches, not stored on the student record).

## The hand-off and the frozen snapshot

Printing response sheets for a bank's test (`POST /api/gradebook/administered-tests`) is the
moment a copy crosses the privacy boundary. The route reads the live test from the currently open
bank and writes an **immutable** `AdministeredTestSnapshotModel` into the open gradebook:

```json
{
  "id": "snap_...",
  "source_bank_title": "Physics 1",
  "source_test_id": "test_0001",
  "title": "Unit 1 Mechanics",
  "version": "A",
  "printed_at": "2026-08-20T00:00:00Z",
  "items": [ /* frozen copy of the test's items */ ],
  "questions": [ /* frozen copies of every referenced question */ ],
  "answer_key": { "test_id": "...", "version": "A", "items": [ /* AnswerKeyItemModel */ ], "total_points": 5.0 },
  "layout": { /* SheetLayoutModel -- see below */ }
}
```

**This is never edited in place.** A later re-print creates a new snapshot with a new id and
`printed_at`, so the gradebook always shows what was actually administered on a given date, even
if the bank's test has since changed or been deleted. Every `AnswerKeyItemModel` carries its own
`standard_ids` (copied from the question at hand-off time), so grade reports can roll up by
standard without the bank needing to be open.

`row_kind` is one of `multiple_choice`, `numeric_response`, or `manual_capture` (covering
`short_answer`/`free_response`). All three appear on the same printed sheet; only the first two are
auto-graded.

## Sheet layout: the shared coordinate system

`SheetLayoutModel` is the one geometry both the PDF generator (`grading/pdf.py`) and the detector
(`grading/detect.py`) read from -- generation draws at these coordinates, detection expects marks
at these coordinates after perspective correction, in PDF points (1/72 inch), never pixels/DPI.

- Four corner fiducials per page: three solid squares, one solid circle (bottom-right), giving a
  true 4-point perspective homography and letting a rotated/upside-down scan be told apart from a
  correctly-oriented one.
- A QR code per page encoding `{test_id, version, sheet_id, page_index, student_id}`. `sheet_id` is
  globally unique across every sheet ever printed in a gradebook, and is the sole join key used to
  resolve which snapshot and page a scanned sheet belongs to -- `layout_id`/`snapshot_id` don't
  need to also ride in the QR payload.
- `mode: "blank"` reserves a name box for the student to write in; `mode: "pre_id"` prints the
  roster student's name into that same box and encodes their `student_id` in the QR.
- Per-row geometry by kind: `multiple_choice` gets one bubble per choice; `numeric_response` gets
  one bubble column per digit (stacked 0-9, like a scantron grid-in), plus an optional sign column
  and a decimal-point marker column; `manual_capture` gets a lined capture rectangle with no
  bubbles at all.

## Scan batches and sheets

```
GradingBatchModel { id, snapshot_id, created_at, source_description, sheets: [ScannedSheetModel] }
```

Each `ScannedSheetModel` records `identity_status` (`pre_identified | unresolved |
manually_resolved | qr_unreadable | wrong_snapshot`), `fiducial_confidence`, and one
`DetectedRowResultModel` per row: `flag` (`none | low_confidence | multi_mark | no_mark`) and
`confidence` for auto-graded rows, `needs_manual_grade` for manual rows. `override_*` fields sit
*alongside* the raw detection rather than replacing it, so a re-score after a threshold change (or
just an audit of what the scanner actually saw) never loses information.

`needs_review` is computed by one shared rule (`grading/review_state.py`), used identically right
after ingest and after every later correction: a sheet needs review if its identity isn't resolved,
its fiducials weren't found, or any row is unresolved (flagged with no override, or a manual row
with no score yet).

## Reporting

`GradeReportModel` (`GET /api/gradebook/batches/{batch_id}/report`) is computed on demand, never
persisted, from a batch + its snapshot's frozen answer key + the gradebook's roster --
`grading/scoring.py`. Scoring is all-or-nothing per item (matching how points already work
elsewhere in the app): a chosen answer either exactly matches the key or it doesn't, and a manual
row earns whatever score a teacher entered. Sheets with an unreadable QR or the wrong snapshot are
excluded entirely; sheets with a valid mark but no resolved identity still count toward the
by-item/by-standard aggregates but not toward `student_scores`.

`CombinedGradeReportModel` (`GET /api/gradebook/report/combined?test_title=`) groups every snapshot
in the gradebook sharing a `title.strip().casefold()` lineage and **sums** attempts/full-credit
counts across versions. This is the opposite of how course coverage reports work: coverage takes
the max across versions to avoid double-counting how many times a standard is *taught*, but a score
report is real, distinct student attempts per version, so summing is correct here.

## Page layout

The gradebook window has three pages, matching the three things a gradebook is for: who is in the
class, what they were given, and getting the scores out.

| Page | What it answers |
| --- | --- |
| **Students** | How is this student doing, across everything they have taken. |
| **Tests** | What was printed, what has come back, and how the class did on it. |
| **Export** | Get the scores out of here as a CSV. |

Scanning and reporting were originally pages of their own (see `docs/grading-plan.md`). Both turned
out to be questions about *one test*, and having them as separate pages meant the answer to "how did
Unit 1 go" was spread across three places, each with its own picker for choosing the test again. They
are now **drill-downs inside a test**: pick the test once on the way in, then move between its
Printings, Scan & Review, and Report tabs. Export stays top-level because it is the one task that
genuinely spans every test at once.

`ScanReviewWorkspace` and `GradeReportWorkspace` are therefore scoped components rather than pages —
they take the printings of one test and never show another's. `AdministeredTestsWorkspace` owns the
join: it reads snapshots and scan batches together and hands each drill-down its own slice.

The list itself leads with what is waiting on the teacher. Each test is in one of three states,
derived from its snapshots and its scanned sheets:

| State | Meaning | Primary button |
| --- | --- | --- |
| `needs_review` | Sheets came back and some could not be read without a human. | Review N sheets |
| `awaiting_scans` | Paper was printed; nothing has been scanned back in. | Enter Scans... |
| *(settled)* | Everything scanned has been reviewed. | View Report |

Tests in the first two states are grouped above the rest under "Needs you", and each card's first
button goes straight to the tab that resolves it.

**Where an unreadable page is filed.** A page whose QR the scanner cannot read names no test, so it
has to be filed somewhere real and flagged — a sheet a teacher cannot find is worse than one filed in
the wrong place. Since scanning now happens inside a test, uploads pass that test as
`fallback_snapshot_id`, and unreadable pages land under the test the teacher is looking at rather
than under whichever test happens to have been printed most recently. A page whose QR *can* be read
still goes to its own test regardless, so scanning a mixed pile from inside one test never misfiles
anything; the upload's status message names where the strays went.

## Test lineages and retakes

Every printing gets its own snapshot, so "the same test" has to be a link rather than an identity.
`AdministeredTestSnapshotModel.lineage_id` is that link, and `grading/lineage.py` owns it:

- The default is **derived from the title** -- `sha1(title.strip().casefold())[:12]`. Derived, not
  assigned at random, so every version of a test groups automatically, and snapshots written before
  the field existed resolve to the same id as new ones with no migration and nothing rewritten on
  disk.
- `PUT /api/gradebook/administered-tests/{snapshot_id}/lineage` overrides it. That is how a retake
  titled "Unit 1 Retake" gets counted as a second attempt at "Unit 1" instead of a separate test
  nobody ever passed. Passing no target clears the override, putting the snapshot back under its
  own title.

Relinking is the **only** edit ever made to a stored snapshot, and it touches nothing that
describes the paper -- not the items, the key, the layout, or `printed_at`. The promise that a
snapshot is a faithful record of what was handed out still holds; only the pile it is filed under
changes.

Attempts themselves are never stored. A student's attempts at a test are every scored sheet of
theirs in that lineage, ordered by `printed_at` (when they sat the paper), with the batch's
`created_at` breaking ties between two piles scanned from one printing.

## Cross-test student performance

`grading/aggregate.py` answers the question batch reporting cannot: not "how did the class do on
this test" but "how is this student doing, across everything they have taken."
`GET /api/gradebook/students/performance` returns it for the whole roster in one pass -- scoring
reads every batch either way, so answering for one student costs the same as answering for all of
them.

Like every other number in the gradebook it is **derived, never persisted**: totals are recomputed
from the sheets on every call, so a scan-review correction or a relinked retake shows up everywhere
at once with no stored score that can go stale.

Two per-standard numbers come out of it, answering different questions:

- `percent_earned` -- points earned over points possible. **How much of the work was right.**
- `mastery` -- a **level**. **How far up the mastery ladder the evidence reaches.** Two students on the same 50% can sit at different levels depending on *which*
  questions they got right, which is the whole reason both are reported.

An item tagged with two standards counts in full toward both, matching how class-level by-standard
reporting already works: the item really is evidence about both, and splitting its points would
understate each. Mastery is computed per standard from that standard's own rows -- a ladder built
from the three questions about one standard says something; a ladder built from the whole paper
does not.

## Mastery levels

`grading/mastery.py`.

### Two words, one numbering

| Term | Means | Where it lives |
| --- | --- | --- |
| **difficulty** | what an author assigns to a question or rubric component | `QuestionModel.difficulty`, `RubricRowModel.difficulty` |
| **level** | a rung on the mastery ladder, which a student reaches | `Evidence.level`, `MasteryResultModel.level` |

**A question's difficulty is the level it gives evidence about.** They share a numbering, which is
why a difficulty-3 question tells you about Level 3 — but they are not the same thing, and only one
of them is a claim about a student. Anything an author sets is a *difficulty*; anything a report
says about a student is a *level*. The phrase "difficulty ladder" is therefore wrong: the ladder is
made of levels.

Mastery is a level, not a percentage: **2.50 means Level 2 cleared and halfway through Level 3.**
Three calculations, because assessments differ in what evidence they carry, and one rounding choice
that applies to all of them.

**The scale is whatever difficulties the bank uses.** Nothing in the calculation assumes a ceiling:
a bank using 1-4 tops out at 4, one using 1-6 at 6. `scale_max` reports the highest level the
evidence actually reached, so a reader is never left guessing what "2.50" is out of, and the CSV
header says `mastery (of 4)` rather than a fixed number.

### Level Ladder

For a test that walks the levels in sequence. A level is mastered at **75%** of its points:

    A_d = points earned at level d / points possible at level d

Climbing stops at the first level not mastered; mastery is the last level cleared plus progress
into that one. Levels 1 and 2 at 100% with Level 3 at 50% gives `2 + 0.50 = 2.50`; 50% at Level 2
after clearing Level 1 gives `1.50`.

Stopping matters: a student who fails Level 2 but aces Level 3 is *not* carried up the ladder,
because the ladder's whole claim is that levels are cleared in order. That higher performance is
reported as `inconsistent_evidence` rather than discarded — in practice it usually means the level
labels need revisiting, not the student.

`has_level_gaps` says the levels present skip a rung or do not start at 1. The ladder assumes a
complete sequence; without one, "cleared Level 2" may only mean "was never asked a Level 2
question", and Difficulty Weighted is the better mode for that test.

### Difficulty Weighted

For a test with hard questions but no complete ladder of them:

    mastery = sum(difficulty × points earned) / sum(points possible)

One 15-point Level 4 question worth 5 earned points reads as `(4 × 5) / 15 = 1.33` — evidence of
Level 1 with a third of Level 2, **not** of Level 3.33. Full marks on it reads as exactly `4.0`, so
the question's own level is still the ceiling. This lets a difficult question supply evidence of
lower-level mastery without assuming every level beneath it was cleared.

### Rubric Levels

For multipart tasks whose rubric was written around mastery levels. Each component carries its own
difficulty (`RubricRowModel.difficulty`), and the **Level Ladder is applied to the components**
rather than to whole questions.

It needs both halves: a rubric whose components each have a difficulty, *and* a grader who scored
the parts separately rather than entering one total (`DetectedRowResultModel.component_scores`; the
row's `manual_score` is kept in step with the parts so every other report still agrees). A rubric
where only some components have one is left alone rather than half-laddered. Missing either half,
the mode falls back to laddering whole questions and says so via `components_unavailable` — a
fallback the report admits to rather than quietly reporting a different mode's number.

The whole feature is **off by default**: the per-component difficulty field is hidden and Rubric
Levels is not offered until *Mastery levels on rubrics* is switched on in Settings (a local
preference, `nexam:rubric-mastery-levels`). Giving a rubric's parts difficulties is an authoring
commitment, and the other two calculations work without it. The setting only controls what is
*shown*: difficulties already set stay in the bank and keep working, and a test already using
Rubric Levels keeps the option visible.

### Reporting

| Mode | Result |
| --- | --- |
| `exact` | Two decimals: 1.33, 2.67, 3.80 |
| `half_steps` | Nearest 0.5, halves up: 1.24 → 1.0, 1.25 → 1.5, 1.74 → 1.5, 1.75 → 2.0 |

`floor(mastery × 2 + 0.5) / 2`. Rounding never touches the calculation — `level_exact` carries the
raw figure alongside the rounded `level`, so the rounding stays visible rather than baked in.

### Choosing a mode

The default is **Level Ladder + Half Steps**: the ladder is what a standards-based report means by
mastery, and half steps stop a 1.33 from reading as more precision than one test's worth of
evidence supports. Difficulty Weighted is the fallback when an assessment carries only
high-difficulty questions.

Settings live in `mastery.json` inside the gradebook: a `default`, plus `by_lineage` overrides.
Per *lineage*, not per printing — every version of a test, and any retake linked to it, is the same
assessment and must be scored the same way. Changing the default deliberately leaves overridden
tests alone; a test set apart was set apart on purpose.

Where a student's standard entries are pooled across several tests, the levels are averaged weighted
by items attempted, and the per-level breakdown is dropped: a ladder is only meaningful inside the
assessment that built it. The pooled entry is labelled with the mode its inputs share, or with the
gradebook default when they disagree.

### Where difficulty comes from

`difficulty` is frozen onto `AnswerKeyItemModel` at hand-off, for the same reason `standard_ids`
already was: mastery has to be computable from the snapshot alone, and an alternate version's key
carries no questions of its own to look it up from. The rubric's component difficulties are
frozen alongside it.

`QuestionModel.difficulty` is required, so an item without one only arises in a snapshot frozen
before the field was carried onto keys. Such an item is credited at the **lowest** level its
neighbours record, never higher (`mastery.fallback_level`): a mastery report that guesses upward
claims a rung nobody has evidence for, and that is the one direction this must not err in. With
nothing to go on at all, the bottom of the scale.

## Backwards compatibility

Every field the mastery work added to a persisted file is optional with a default, so a `.bok` or
`.nxgb` written before it opens and reports with no migration step:

| Added to | Field | Old file reads as |
| --- | --- | --- |
| `RubricRowModel` (.bok) | `difficulty` | `None` -- read by nothing except Rubric Levels |
| `AnswerKeyItemModel` (.nxgb) | `difficulty`, `rubric_components` | `None` / empty |
| `DetectedRowResultModel` (.nxgb) | `component_scores` | `None`; `manual_score` still the total |
| `AdministeredTestSnapshotModel` (.nxgb) | `lineage_id` | `None`, resolved from the title |
| gradebook package | `mastery.json` | absent -- the defaults are used and the file is written on next save |

`test_backwards_compatibility.py` builds a current gradebook, strips every one of those keys back
out of the saved `.nxgb`, reopens it, and puts it through scoring, reporting, and all three CSV
exports. Old and new data coexist in one file: a re-print into an aged gradebook records the new
fields while the existing snapshots stay exactly as they were.

The one number that cannot survive the round trip is difficulty, because an old key never stored it.
Percentages are unaffected; mastery falls to the bottom of the scale rather than inventing a rung,
and `scale_max` of 1 is the tell.

**What did change meaning:** the CSV's `mastery` column. It used to be a difficulty-weighted
percentage (0-100) and is now a level (0-`scale_max`). The header states the scale and the filename
names the calculation, but an existing import mapping that column as a percentage will need
revisiting.

## Retake resolution

When a student has more than one attempt at a lineage, exactly one score counts, chosen at export
time rather than stored on the attempts:

| Resolution | What it does |
| --- | --- |
| `most_recent` | The last sitting replaces the earlier ones. |
| `highest` | The best sitting counts. |
| `average` | The mean of the attempts' *percentages*. |

`most_recent` and `highest` pick a real attempt and carry its numbers and its standard breakdown
through unchanged, so the exported number is one a teacher can point at a specific paper for.
`average` synthesises one instead: the mean of the percentages, not pooled points, because a
teacher who says "average the retakes" means the average of the scores regardless of what each
paper was out of. Per standard, `average` averages only over the attempts that actually tested that
standard, so a standard that appeared only on the retake is reported from the retake rather than
diluted by tests that never asked about it.

## CSV export

`GET /api/gradebook/export/scores.csv?method=&resolution=&section=` -- `grading/csv_export.py`.
All three shapes are **wide** (one row per student, one column per test or per standard), which is
what a gradebook or SIS import expects and what a teacher can read without pivoting anything:

| `method` | Columns |
| --- | --- |
| `total` | Points and % per test, plus an overall % |
| `by_standard` | One % column per standard |
| `mastery` | One column per standard, as a mastery *level* (see above), not a percentage |

Every export runs through the chosen retake resolution, so a cell is the one score that test
contributes for that student -- never a first attempt and a retake fighting over one column. A
mastery export names its calculation in the filename: the same students score differently under
Level Ladder and Difficulty Weighted, and two such files are otherwise indistinguishable.
Test columns are keyed by lineage, not title, and the title is disambiguated only when two
unlinked tests would otherwise collide.

Students with no scored sheets are still exported, with empty cells: a roster that silently drops
the absentees is worse than one that shows them blank. Scored sheets never matched to anyone on the
roster count toward nobody, and are reported as `unlinked_sheet_count` so the UI can say so rather
than quietly under-reporting.

Standard **codes** live only in a bank, so they label the columns when one happens to be open and
standard ids stand in when it is not. The export never requires a bank -- a gradebook has to stay
exportable on its own.

## Recording a performance run

`POST /api/gradebook/batches/{batch_id}/record-performance-run` is the **only** place a grading
result flows back into a bank, and only when the user explicitly asks for it (never automatic,
never triggered by scoring itself). It builds a `TestPerformanceRunModel` from the report's
per-item stats and calls `BankWorkspaceService.add_performance_run(test_id, run)` -- the one new
method on the bank service the whole grading feature needed, appending to
`TestDraftModel.performance_runs`. Only aggregate statistics (attempts, correct count, observed
difficulty) cross back over; student identities never do.
