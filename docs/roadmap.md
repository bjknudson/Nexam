# Nexzam Roadmap

## Phase 0 — Foundation

- Initialize repository shape.
- Add architecture/schema docs and sample bank files.
- Prepare frontend/backend/Tauri directories.

## Phase 1 — Package + Schema

- Implement create/open/save `.bok`.
- Unpack/repack workflow.
- Manifest + question validation.
- Initial question types (MCQ, numeric, short, free response).

## Phase 2 — Browser + Editor — Complete

- Question browser with filters/search.
- Editor with form + raw JSON tabs.
- Edit an existing question directly as raw JSON in the question editor.
- Create or replace a question by pasting entirely new JSON into the question editor.
- Provide explicit question-level Save, Save as New with automatic type-based id assignment, Revert, and JSON formatting actions.
- Make AI-generated question JSON easy to paste, validate, and add as new questions.
- Asset attach/copy workflow.
- Bank asset browser with usage visibility.
- KaTeX preview for question text, answers, sample solutions, explanations, and free-response rubric criteria.
- SVG token replacement preview.

## Current milestone snapshot

- Milestone 2: desktop-native open/edit/save `.bok` flow is in place.
- Milestone 3: authoring basics are in place, including form editing, raw JSON editing, explicit question saves, Save as New, Revert, JSON formatting, type-based new ids, and backend test coverage for core question workflows.
- Milestone 4: asset management is in place for attach/copy, preview, bank-wide browsing, usage visibility, and SVG token replacement preview.
- Phase 2 evaluation: complete for the current browser/editor scope. Remaining work should move into Phase 3 import, Phase 4 print prep, or a later SVG authoring milestone rather than expanding Phase 2.
- Next planning track: JSON/CSV import staging, followed by print-prep test drafts and later native SVG authoring with simple shapes, style controls, placeholders, and reusable teaching elements.

## Phase 3 — Import — Complete

- Question import workspace entry point from the main editor.
- JSON question import staging.
  - Accept one question object, `{ "question": ... }`, an array of questions, `{ "questions": [...] }`, or `{ "items": [...] }`.
  - Validate each staged item with the existing question schema before promotion.
- CSV question import staging.
  - Required columns: `type`, `topic`, `difficulty`, `prompt`.
  - Optional columns: `id`, `tags`, `status`, `points`, `estimated_time_sec`, `standards`, `teacher_notes`, `explanation`, `sample_solution`, `answer_json`, `rubric_json`, `assets_json`.
- Row-level validation results for staged imports.
  - Keep invalid rows visible and editable instead of dropping them.
  - Show schema errors, duplicate id conflicts, unsupported question types, malformed JSON fields, and unknown standard references.
- Proposed id handling for staged rows.
  - Default to type-based Nexzam ids on promotion.
  - Allow keeping imported ids only when they are valid and unique.
  - Never silently rename persisted or imported ids.
- Staging review table with filters for all, valid, invalid, selected, and promoted rows.
- Staged row detail panel with editable raw JSON for correction before promotion.
- Promote selected valid staged rows to real `questions/*.json` files.
- Refresh `bank.json`, question browser filters, and the selected question after promotion.
- Preserve original import files under `imports/` for portability and auditability.
- Backend test coverage for JSON staging, CSV staging, validation failures, promotion, id policy, index refresh, and repack persistence.

## Phase 4 — Print Prep

- Test draft model.
  - Store test drafts in `tests/tests.json` as additive package data.
  - A test draft has `id`, `title`, `version`, ordered question items, print settings, and performance runs.
  - Test items reference bank question ids and can be marked experimental for SAT-style field testing.
  - Preserve question JSON as source-of-truth; do not copy full question bodies into tests unless needed for export snapshots.
- Test summary and balance reporting.
  - Include title, version, standards list, counts by question type, counts by difficulty, average difficulty, and total estimated time.
  - Include standard-by-difficulty and standard-by-time balance data.
  - Treat summary as derived from referenced questions so bank edits remain visible in draft tests.
- Manual test building.
  - Add selected bank questions to a draft test.
  - Reorder, remove, and mark items experimental.
  - Provide easy swap affordances for similar questions by standard, topic, type, and difficulty.
- Question type instruction defaults.
  - `multiple_choice`: "Select the best answer."
  - Multiple-correct choice variants: "Select the two choices." or count-aware text.
  - `numeric_response`, `short_answer`, and `free_response` defaults should be editable per output section.
- Page settings.
  - Save local reusable defaults for typeface, margins, font size, page size, columns, name field, page numbers, response space, and optional cover sheet.
  - Support 1, 2, and 3 column layouts and common page sizes such as Letter, Legal, and A4.
- Printable output builder.
  - Open from the test edit panel as a dedicated preview/editing space.
  - Allow item reorder by controls first; drag ordering can follow once the preview surface is stable.
  - Support automatic organization by standard and increasing difficulty.
  - Use KaTeX previews in the print surface and HTML-to-PDF for the initial export path.
- Performance capture after use.
  - Record administrations with cohort/date notes, attempts, correctness or average score, observed difficulty, tricky flag, and notes.
  - Compare observed performance against item difficulty and standard clusters.
  - Surface standard-level difficulty patterns so teachers can distinguish weak prep/standard coverage from bad questions.
- Digital exports.
  - Keep printable test as the primary output.
  - Add platform export adapters later from the same test draft object.

### Phase 4 starting slice

- Added additive `tests/tests.json` support file creation for opened banks.
- Added backend test draft models, summaries, and create/list/update/add-question endpoints.
- Added a React Test Builder panel for creating draft tests, adding the selected question, reviewing balance, editing basic print settings from a collapsed Page Settings submenu, and reordering/removing items.
- Added a printable preview window with cover sheet/name-field support, page size, margins, columns, font size, multiple-choice choices, response lines, and browser print output.
- Added editable instruction sections by question style. Instructions render as section headers only when the question style changes, with shared display controls and per-style header templates using placeholders for instructions, topic, standards, and time.
- Added explicit manually placed section items inside test drafts. Sections can be inserted, reordered with questions, edited inline, linked to a question style for defaults, given manual topic/standard/time text, and printed where placed without repeating the same automatic style header.
- Added template-based page topper and name-field formatting controls with alignment, horizontal line, and spacing options.
- Split the main app workspace into page-level Question Editor and Test Builder views. Both can use the question bank search pane; the Test Builder gets a wider question pane with prompt and multiple-choice choice previews, while the asset pane remains scoped to the Question Editor.
- Remaining Phase 4 work: cover sheet templates, local saved page-setting presets, HTML-to-PDF export, performance-entry UI, swap suggestions, and digital export adapters.

## Phase 5 — Builder

- Auto-builder with constraints.
- Topic/type/difficulty balancing.
- Swap and regenerate suggestions.

## Phase 6 — Grading

Full design in `docs/grading-plan.md`; format reference in `docs/grading.md`.

- A second local package, `.nxgb` (a gradebook), holding roster, printed
  response-sheet layouts, scan batches, and scores -- structurally separate
  from a `.bok` bank so student data can never ride along in a bank shared
  between teachers. One gradebook per class section/term.
- Hand-off: printing response sheets for a test freezes an immutable
  `AdministeredTestSnapshotModel` (the test's items, questions, derived
  answer key, and sheet geometry) into the open gradebook. Editing or
  deleting the bank's test afterward never affects a snapshot already
  printed; re-printing creates a new snapshot rather than mutating the old
  one.
- Response sheets mix all three question shapes on one printed page:
  `multiple_choice` (bubble row) and `numeric_response` (digit grid-in) are
  both auto-graded from the same classical-CV fill-ratio detector;
  `short_answer`/`free_response` get a lined capture box that is always
  scored by hand.
- Detection is classical CV, not ML: four corner fiducials (three squares, one
  circle) give a perspective homography to register a scan against its
  frozen geometry, then each bubble's fill state is read as a pixel-darkness
  ratio that doubles as a confidence score. Ambiguous marks (multi-fill,
  faint fill, blank), unreadable QR codes, and sheets scanned into the wrong
  batch are flagged for review rather than guessed at.
- Review queue: resolve a sheet's identity against the gradebook's roster (or
  a free-text name), correct a flagged row (stored alongside the raw
  detection, never overwriting it), or manually score a short/free-response
  row.
- Reporting: total score, score by standard, and by-item stats (including
  choice distribution) computed straight from a batch and its snapshot's
  answer key -- no bank needs to be open. A combined-lineage report sums
  by-standard stats across every version of a test, unlike course coverage,
  which takes the max to avoid double-counting curriculum reach.
- `record_batch_as_performance_run` is the one explicit, opt-in path back
  into the bank: aggregate per-question stats (attempts, correct count,
  observed difficulty) into `TestDraftModel.performance_runs` -- the same
  model Phase 4's still-open "performance-entry UI" item anticipated, now
  populated automatically from real grading instead of manual entry.
- Backend-complete as of this phase: models, services, and routes for the
  full print -> scan -> detect -> review -> report pipeline, verified without
  a physical printer or scanner via synthetic render/rasterize/fill/detect
  round-trip tests (including perspective skew and noise tolerance).
- Cross-test student performance and CSV export: snapshots carry a
  `lineage_id` (derived from the title, overridable by hand) so a retake links
  to the test it retakes; `grading/aggregate.py` rolls every scored sheet up
  per student across every test, resolving retakes as most-recent / highest /
  average at export time; and `grading/csv_export.py` writes three wide CSV
  shapes -- total per test, percent by standard, and a difficulty-weighted
  mastery estimate per standard that reuses `QuestionModel.difficulty`, frozen
  onto the answer key at hand-off. The roster page is built around a student's
  record rather than their contact fields. See `docs/grading.md`.
- Administered Tests became the centre of the gradebook: scanning and reporting
  are per-test drill-downs inside it rather than top-level tabs, the list groups
  tests that need the teacher (pending review, printed-but-not-scanned) above the
  rest with a one-click route into the tab that resolves them, and each card
  generates response sheets for its own test across every version in one run.
  The gradebook's pages are now Students / Tests / Export. See "Page layout" in
  `docs/grading.md`.
- Remaining Phase 6 work: `ResponseSheetPrintPane.tsx`, `RosterWorkspace.tsx`,
  `ScanReviewWorkspace.tsx`, and `GradeReportWorkspace.tsx` on the frontend;
  the `save_bytes_dialog` Tauri command for exporting a generated PDF; and a
  PyInstaller packaging spike to confirm `opencv-python-headless`/`PyMuPDF`
  bundle correctly in the frozen desktop build.
