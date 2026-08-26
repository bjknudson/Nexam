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

## Recording a performance run

`POST /api/gradebook/batches/{batch_id}/record-performance-run` is the **only** place a grading
result flows back into a bank, and only when the user explicitly asks for it (never automatic,
never triggered by scoring itself). It builds a `TestPerformanceRunModel` from the report's
per-item stats and calls `BankWorkspaceService.add_performance_run(test_id, run)` -- the one new
method on the bank service the whole grading feature needed, appending to
`TestDraftModel.performance_runs`. Only aggregate statistics (attempts, correct count, observed
difficulty) cross back over; student identities never do.
