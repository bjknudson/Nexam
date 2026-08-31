# Grading feature: printable response sheets + offline optical autograde

## Context

Nexam builds tests and lets a teacher fork manual "versions" of the same test, but has no way to
score what students turn in — answer keys already live on each `QuestionModel`, but there's no
printable answer sheet, no scan/autograde pipeline, and no scoring report. The goal is a fully
offline grading workflow: print response sheets tied to a specific test version, scan a batch,
autograde what's machine-gradable, flag anything low-confidence for a human to resolve, and report
a score (total, by standard, and a couple of other useful breakdowns) — feeding back into the
existing `performance_runs` concept the app already has.

**A `.bok` bank is a file teachers hand to each other** (`DISTRIBUTION.md`'s whole "send testers
Nexzam.zip" culture). Student names and scores must never be capable of riding along inside it —
not "the teacher should remember not to export that," but structurally impossible because the data
never lives in the bank's package in the first place. That single requirement drives the biggest
decision in this plan: grading data lives in a **second, separate local file** with its own
open/save lifecycle, not inside the bank.

Decisions locked in with the user, reflected throughout:
- **Classical CV only for v1** (fiducial-marker registration + perspective correction + per-bubble
  fill-ratio detection), no ML dependency. The fill-ratio doubles as the confidence score driving
  the manual-review queue. Detection sits behind narrow, swappable interfaces so a future
  ONNX-based detector (for noisier phone-camera capture) can replace just the fill-check later.
- **QR code per sheet** resolving test + version + which physical layout produced it, plus student
  identity when known. Two print modes: pre-ID from a roster (QR carries `student_id`, name is
  printed), or blank name field resolved manually during review.
- **A gradebook is scoped to one class section/term** (its own roster, its own file) — not 1:1 with
  a bank (one bank may be taught to several sections/years) and not an open-ended multi-bank
  container. A teacher creates a new gradebook each term/section; it can pull test snapshots from
  any bank.
- **Scanner-batch capture first**; phone-camera capture is a later addition, but interfaces are
  written so it doesn't require a pipeline rewrite.
- **One response sheet handles all three question shapes**: `multiple_choice` (bubble row,
  auto-graded), `numeric_response` (digit grid-in, auto-graded with the same fill-ratio primitive,
  just a different bubble grid), and `short_answer`/`free_response` (a lined capture box, image
  only, no auto-grade — a teacher enters the score by hand during review).

## Two-package architecture: Bank vs. Gradebook

Today the app has exactly **one bank open at a time** — one backend process, one
`BankWorkspaceService` instance, one `_workspace_path` (`app/backend/service.py:112`). The existing
tabs (Library/Courses/Questions/Test Builder, `App.tsx`'s `WorkspacePage`) — including the ones
that pop out into their own Tauri window via `openPaneWindow` (`desktop.ts`) — are all views over
that *same* open bank. Adding "Grading" as a fifth tab in that bar would send exactly the wrong
signal: it would look like just another view of the bank, which is the opposite of the guarantee
we need.

**A gradebook is its own file and its own space, not a tab.** Concretely:

- A new package format, `.nxgb`, zipped JSON exactly like `.bok` (same unpack-to-workspace /
  repack-on-save shape, for consistency and code reuse — see "shared package plumbing" below).
- A new backend service, `GradebookService` (`app/backend/gradebook_service.py`), with its own
  independent `_workspace_path`, living in the **same backend process** as `BankWorkspaceService`
  (Tauri already runs one backend process per app instance and already serves multiple windows
  from it for pop-out panes, so no second process is needed) — but a fully separate open/create/
  save/close lifecycle. A gradebook can be open with no bank open, a bank open with no gradebook,
  both, or neither.
- A new top-level entry point alongside "Open Bank" / "Create Bank" / "Open Demo Bank": "Open
  Gradebook" / "New Gradebook", opening in its own window. Reuse the existing frontend bundle
  (don't stand up a second frontend app) — branch the root component on which kind of document a
  given window was opened against, the same way `desktop.ts` already distinguishes pane kinds.
- The gradebook window gets its own internal pages, mirroring the bank's `WorkspacePage` pattern
  but scoped to grading: **Roster**, **Administered Tests**, **Scan & Review**, **Reports**.
  *Superseded in build:* scanning and reporting turned out to be questions about one *test*, so
  they became drill-downs inside Administered Tests rather than pages of their own. The shipped
  pages are **Students**, **Tests**, and **Export** — see "Page layout" in `docs/grading.md`.

**Shared package plumbing (recommended, not mandatory for v1):** `BankWorkspaceService`'s
unpack-to-temp-workspace / repack-to-zip logic (`service.py:112-200`) is generic enough to extract
into a small shared base (e.g. `PackageWorkspaceMixin`) used by both services. Sharing well-tested
repack code, rather than writing a second implementation by hand, is itself part of the privacy
guarantee — it's one code path to verify never crosses package boundaries, not two.

### The hand-off

Generating response sheets for a test version is the moment a copy crosses the boundary. The
action lives where the teacher already is — the bank's Test Builder — as "Create Response
Sheets...". It requires a gradebook to be open (prompt to open or create one if not), then:

1. Reads the live test + its questions from the currently open bank (`BankWorkspaceService`).
2. Builds an **immutable** `AdministeredTestSnapshotModel` — a full copy of the test's items,
   referenced questions, and derived answer key, frozen at this instant — and a `SheetLayoutModel`
   + rendered PDF (see the geometry design below).
3. Persists the snapshot, layout, and PDF **only into the open gradebook's package**. Nothing is
   written back into the bank.

The snapshot is never edited in place. Re-printing later (e.g. after the bank's test was edited)
creates a **new** snapshot with a new `printed_at`, so the gradebook always shows exactly what was
actually administered on a given date — "Unit 1 Mechanics — v.A — printed 2026-08-20" and "...—
printed 2026-09-02" both stay visible and distinct, even if the bank's live test changed or was
deleted in between. This directly answers "so the user can see what WAS implemented," and it's why
batches/scans/reports inside the gradebook reference a `snapshot_id`, never a live `test_id`.

### Privacy/safety follow-through

- Roster, scans, and scores exist **only** inside the gradebook file.
- Add a regression test asserting `BankWorkspaceService`'s save/repack path structurally cannot
  include anything from a gradebook's workspace root (they're disjoint temp roots by construction,
  but this is exactly the guarantee worth pinning down with a test, not just an architecture
  diagram).
- Bank Save/Export UI gets a small, true-by-construction affirmation ("This bank contains no
  student names or scores"). The gradebook window/title should visibly read as containing student
  data (distinct icon/extension, a banner on open) so it doesn't get casually shared the way a
  `.bok` is designed to be — this is a naming/UI nudge, not an enforceable technical control, and
  worth a short callout in a new `docs/grading.md` or a section of `DISTRIBUTION.md`.

## Response-sheet geometry: the shared-coordinate design

Everything is expressed in **PDF points**, never pixels/DPI. The generator draws each element at a
known point coordinate; the detector never "finds" bubbles generically — it finds 3–4 fiducial
markers, computes a homography from their pixel positions to their *known* point positions from
the frozen layout, and every other coordinate (every bubble, every capture box) is a table lookup
through that transform.

- **Fiducials:** four corner markers, three solid squares and one solid circle (bottom-right).
  Four points give a true perspective homography (robust to scanner-feeder skew); the one
  asymmetric marker lets the detector recover orientation if a page is fed rotated or upside down.
- **Canonical warp:** after computing the homography, warp the whole page to a fixed 300dpi raster
  so every downstream ROI lookup is one fixed point→pixel multiply, regardless of actual scan DPI.
- **Freeze at print time, never recompute.** The layout, including the answer key it used, is
  captured once, at generation time, as part of the immutable snapshot above — never recomputed
  from a live test draft during scan ingestion. If it were, editing the bank's test after printing
  would silently shift bubble coordinates under sheets already on paper, with no error, just wrong
  grades. The QR encodes `{snapshot_id, layout_id, sheet_id[, student_id]}`; ingestion always loads
  the frozen layout by id, or flags the sheet and stops — detection strictly requires a resolvable
  layout, never guesses at geometry.
- **Mixed item types share the same primitive, differently**, via a `kind` on each sheet row:
  - `multiple_choice` — a row of A/B/C/... bubbles, decoded straight into choice indices.
  - `numeric_response` — a grid-in: one bubble column per digit position, plus optional sign/decimal
    bubbles, decoded by running the same `detect_bubble_fill` primitive per bubble, then composing
    digits into a number compared against `answer.value` ± `answer.tolerance`. Digit count and
    sign/decimal support come from new, optional, additive fields on the question's `answer` dict
    (`grid_digits`, `allow_decimal`, `allow_negative`) — the same place MC already keeps
    `choices`/`correct_choice_index`. No change needed to `answer`'s loose `dict[str, Any]` typing.
  - `short_answer` / `free_response` — a lined capture rectangle sized from the item's existing
    `response_space_lines`. The detector skips fill-detection for this row kind entirely; it exists
    in the layout only so ingestion knows where to crop the region (computed on demand from the
    row's rect + the frozen homography, not stored as a duplicate image) for a teacher to read and
    score by hand against the question's `rubric`/`sample_solution`.
  - Two distinct review-queue lanes follow from this: **low-confidence auto-grade** (bubble/digit
    fills the CV wasn't sure about) and **manual-grade-needed** (every `short_answer`/
    `free_response` row, always).
- **Swappable seams** in `grading/detect.py`: `locate_fiducials(image)` and
  `detect_bubble_fill(roi_image) -> (filled, confidence)`, so a future phone-camera path can swap
  either without touching the rest of the pipeline.

## Module layout

```
app/backend/
  models.py                     # bank models unchanged; append grading/roster/snapshot models
  service.py                     # unchanged (bank stays entirely free of grading concerns)
  gradebook_service.py            # GradebookService: .nxgb open/create/save/close, roster CRUD,
                                   # snapshot/batch/sheet lifecycle, report queries
  grading/
    __init__.py
    layout.py                    # pure geometry: (items, questions, mode, print_settings) -> SheetLayoutModel
    pdf.py                       # reportlab: SheetLayoutModel -> PDF bytes
    detect.py                    # opencv: scanned image + SheetLayoutModel -> raw per-row reads
    scoring.py                   # snapshot answer key + row results + roster -> GradeReportModel
  main.py                        # + bank_service (existing) and gradebook_service singletons,
                                   # + /api/gradebook/* routes, + the one hand-off route that touches both
```

`grading/*` modules are pure/stateless and don't know which package called them — `GradebookService`
owns all persistence and is the only thing that reads/writes the `.nxgb` workspace. The hand-off
route in `main.py` is the one place that legitimately touches both `bank_service` and
`gradebook_service` together; everywhere else they're fully independent.

## Data model additions (`app/backend/models.py`)

House style: `Field(default_factory=...)` collections, validators for shape, docstrings on
non-obvious invariants (matching `CourseStandardCoverageModel`'s style).

**Roster (lives only in `.nxgb`)** — `StudentModel` (`id`, `external_id`, `first_name`,
`last_name`), `StudentCollectionModel`, `UpsertStudentRequest`. Deliberately minimal — no SIS
import, no attendance, no gradebook-of-grades beyond what this feature computes.

**Answer key (derived at snapshot time, then frozen into the snapshot)** —
`AnswerKeyItemModel` (`question_id`, `test_item_number` [position among *all* items, matches the
printed booklet], `sheet_item_number` [position among sheet-eligible items], `row_kind`, MC fields
`choice_count`/`correct_choice_indices`, numeric fields `numeric_value`/`numeric_tolerance`/
`grid_digits`/`allow_decimal`/`allow_negative`, `points`), `AnswerKeyModel` (`test_id`, `version`,
`items`, `total_points`). Derived once, at hand-off time, from `BankWorkspaceService.get_test_draft()`
— the same source `TestPrintPreview.tsx` renders from (`CHOICE_LABELS`, line 25), so backend and
frontend choice-letter/order logic agree by construction. After that moment it lives frozen inside
the snapshot, not re-derived.

**Administered test snapshot (persisted in `.nxgb`, immutable)** —

```python
class AdministeredTestSnapshotModel(BaseModel):
    """A frozen copy of exactly what was printed and handed to students.

    Captured once, at print time, from the bank that was open at that moment.
    Never edited in place -- a later re-print creates a new snapshot with a
    new id and printed_at, so a gradebook can always show what WAS given on
    a given date even if the source bank's test has since changed or is gone.
    """
    id: str
    source_bank_title: str | None = None   # display only, not a live dependency
    source_test_id: str
    title: str
    version: str
    printed_at: datetime
    items: list[TestItemModel]             # frozen copy, not a reference
    questions: list[QuestionModel]         # frozen copies of every referenced question
    answer_key: AnswerKeyModel
    layout: "SheetLayoutModel"
```

**Sheet layout (frozen geometry, embedded in the snapshot)** — `FiducialMarkerModel`,
`BubbleCellModel` (one per choice/digit value), `SheetRowModel` (`kind`, `question_id`, item
numbers, kind-specific geometry: `cells` for bubble/digit rows, `capture_box` rect for manual
rows), `SheetPageModel` (fiducials, QR box, name box or printed name, `rows`), `SheetLayoutModel`
(`id`, `mode`, `pages`).

**Scan batches & sheets (persisted in `.nxgb`)** — `DetectedRowResultModel` (per `SheetRowModel`:
MC/numeric get `detected_choice_indices`/`detected_digits`/`detected_value`, `confidence`,
`flag: none | low_confidence | multi_mark | no_mark`, plus `override_*` fields stored *alongside*
the raw detection so an audit or re-score after a threshold change never loses information; manual
rows get `manual_score`, `manual_score_max`, `manual_grader_note`, `needs_manual_grade: bool`
instead of confidence/flag). `ScannedSheetModel` (`id`, `snapshot_id`, `layout_id`, `sheet_id`,
`source_image_path`, `student_id`/`free_text_name`, `identity_status: pre_identified | unresolved |
manually_resolved | qr_unreadable | wrong_snapshot`, `row_results`, `needs_review` computed from
whether any row is flagged, unscored-manual, or identity is unresolved). `GradingBatchModel` (`id`,
`snapshot_id`, `sheets`). The review queue is `[s for s in batch.sheets if s.needs_review]`,
filtered by lane in the API/UI — not its own persisted model.

**Grade report (derived on demand, never persisted)** — `GradeReportItemModel` (per question:
`row_kind`, `auto_graded`, attempts, correct count, percent correct, choice/digit distribution),
`GradeReportStandardModel` (standard_id, attempts, correct, percent), `StudentScoreModel` (per
sheet: points earned/possible, percent, flagged/unscored count), `GradeReportModel` (batch totals,
histogram, `by_standard`, `by_item`, `student_scores`, `contains_unscored_manual_items: bool` so an
incomplete report is visibly incomplete, not silently wrong). `CombinedGradeReportModel` groups
every batch in the gradebook whose snapshot shares a `title.strip().casefold()` lineage (the same
grouping mechanism as `BankWorkspaceService.get_course_detail()`, `service.py:411`, reused for its
grouping *logic* only — the gradebook has no course/coverage concept of its own) and **sums**
attempts/correct across versions rather than taking the max: coverage avoids double-counting
curriculum reach, but a score report is real, distinct student attempts per version.

## Service methods

**`GradebookService`** (new): `open`/`create`/`save`/`close` (mirrors `BankWorkspaceService`'s
lifecycle); roster CRUD; `create_snapshot_and_sheets(test: TestDraftModel, questions: list[QuestionModel],
mode, print_settings, roster_student_ids=None)` — called from the hand-off route with data the
route already read from the open bank, so `GradebookService` itself never depends on a bank being
open; `get_sheet_pdf_bytes(layout_id)`; `create_scan_batch(snapshot_id)`; `ingest_scan_batch(batch_id,
files)` (PDF pages rasterized via PyMuPDF, images via Pillow; decode QR via `cv2.QRCodeDetector`;
resolve `layout_id` against the snapshot's frozen layout or flag `qr_unreadable` and stop);
`resolve_sheet_identity`; `override_row_result` (MC/numeric override or manual score entry, same
route shape, payload varies by `row_kind`); `get_grade_report`; `get_combined_lineage_report`;
`record_batch_as_performance_run(batch_id)` — builds a `TestPerformanceRunModel` from the report's
`by_item` and calls a new method on the *bank* service, but only when a bank happens to be open and
the user explicitly opts in (this is the one place a completed grading result can flow back to the
bank, and it must be an explicit action, never automatic, given the whole point of the boundary).

**`BankWorkspaceService`** (one new method): `add_performance_run(test_id, run)` — writes into
`tests.json`'s existing `performance_runs`. This is score *aggregate statistics* (attempts,
correct counts, observed difficulty) about questions, not student identities — consistent with what
`performance_runs` already stores today, so it doesn't reopen the privacy boundary.

## Routes (`app/backend/main.py`)

```
# Gradebook document lifecycle
POST /api/gradebook/open | /create | /save | /close

# Roster (gradebook-scoped)
GET/PUT/DELETE /api/gradebook/students[/{id}]

# Hand-off (reads the open bank, writes only into the open gradebook)
POST /api/gradebook/administered-tests     body: {test_id, version, mode, print_settings, roster_student_ids?}
GET  /api/gradebook/administered-tests
GET  /api/gradebook/sheets/{layout_id}/pdf

# Scan batches
POST /api/gradebook/batches                body: {snapshot_id}
GET  /api/gradebook/batches[?snapshot_id=]
POST /api/gradebook/batches/{batch_id}/ingest                       (multipart)
GET  /api/gradebook/batches/{batch_id}/sheets/{sheet_id}/image
PUT  /api/gradebook/batches/{batch_id}/sheets/{sheet_id}/identity
PUT  /api/gradebook/batches/{batch_id}/sheets/{sheet_id}/rows/{question_id}

# Reporting
GET  /api/gradebook/batches/{batch_id}/report
GET  /api/gradebook/report/combined?test_title=
POST /api/gradebook/batches/{batch_id}/record-performance-run       (requires a bank open; touches bank_service)
```

## Frontend additions

Mirror everything into `types.ts`/`api.ts`; add one `handleBinaryResponse` helper for PDF/image
byte responses.

- Launch surface gets "Open Gradebook" / "New Gradebook" alongside "Open Bank" / "Create Bank" /
  "Open Demo Bank". A gradebook window renders the same app bundle with a top-level mode switch,
  not a second frontend build.
- `GradebookApp` root (new, or a mode-branch of the existing root) with its own page tabs:
  `RosterWorkspace.tsx` (modeled on `CoursesWorkspace.tsx`), `AdministeredTestsWorkspace.tsx` (list
  of snapshots — title/version/printed date/source bank — re-download PDF, start a scan batch),
  `ScanReviewWorkspace.tsx` (modeled on `QuestionImportWorkspace.tsx`'s staging-review table: batch
  list → sheet table with status chips → row detail panel; auto-graded rows show the scanned crop
  next to an editable override, manual rows show the cropped capture box next to a score-entry
  field with the question's rubric visible — same table, two visibly distinct row treatments by
  `kind`), `GradeReportWorkspace.tsx` (totals/histogram, by-standard table, by-item table with
  distribution, a visible warning when `contains_unscored_manual_items`, "Record as performance
  run" — enabled only when a matching bank is open). Charts follow the **dataviz** skill.
- Bank side gets one new action in the Test Builder: "Create Response Sheets...", opening a small
  `ResponseSheetPrintPane.tsx` (new `PaneKind`, following `desktop.ts`'s existing pattern) — pick or
  create a gradebook, mode toggle (blank/pre-ID), roster picker (from that gradebook), on-screen
  preview, "Generate" (performs the hand-off) then "Save PDF...".
- **New Tauri command:** today's printing (`desktop.ts:79` → `main.rs:112`) only triggers the OS
  print dialog on live HTML; it never writes a file. Add `save_bytes_dialog(suggested_name, bytes)
  -> Option<String>` (using `rfd`, already a Cargo dependency) plus a `desktop.ts` wrapper. v1 scope
  is "Save PDF..."; the teacher prints from their OS's PDF viewer — no direct-to-printer plumbing.

## New backend dependencies (`app/backend/requirements.txt`)

| Package | Why |
|---|---|
| `reportlab` | Fixed-coordinate PDF drawing — a precise grid, not flowing prose, so a better fit than `weasyprint`/wkhtmltopdf (a whole browser engine to solve a problem reportlab solves directly). |
| `qrcode` | QR generation, pure-Python. |
| `Pillow` | Scanner-output normalization (EXIF/format), already a `qrcode` dependency. |
| `opencv-python-headless` | Fiducial detection, perspective transform, fill-ratio detection, and QR decoding (`cv2.QRCodeDetector`) — one dependency instead of adding `pyzbar` (needs the system `libzbar` shared library) just for QR. This exact registration+fill-ratio approach is extremely well-trodden in OpenCV. |
| `PyMuPDF` (`fitz`) | Rasterizing scanned PDF input — bundles its own MuPDF in the wheel, unlike `pdf2image`, which shells out to an external Poppler binary needing separate PyInstaller bundling. |

**Packaging risk to spike before writing detection code:** `requirements-dev.txt` already has
`pyinstaller-hooks-contrib`, expected to auto-collect `cv2`/`fitz` native binaries in the existing
`--onedir` build — verify with a real local build, don't assume. Also check
`opencv-python-headless`/`PyMuPDF` wheel availability for the local `.venv`'s Python (3.14) against
CI's pinned 3.12 (`release-macos.yml`); pin local dev to 3.12 if wheels lag.

## Persistence shape

`.bok` gains **nothing** — no new folders, no new files, unchanged.

`.nxgb` (new, zipped like `.bok`):

```
manifest.json
roster/students.json
snapshots/<snapshot_id>/snapshot.json      # AdministeredTestSnapshotModel (includes layout)
snapshots/<snapshot_id>/sheet.pdf
batches/<batch_id>.json                    # GradingBatchModel
scans/<batch_id>/<n>.<ext>                 # original captured images, for audit + review UI
```

New docs: `docs/grading.md` describing the `.nxgb` format, the freeze/hand-off invariant, and the
privacy boundary explicitly (why it's a separate file, what must never cross into a `.bok`); a new
**Phase 6 — Grading** section in `docs/roadmap.md` (starting slice + remaining work, like Phase 4),
noting it partially subsumes Phase 4's still-open "performance-entry UI" item; a short note in
`DISTRIBUTION.md` that `.nxgb` files contain student data and should not be shared like a bank.

## Phasing

1. **Two-package plumbing** — extract shared package (unpack/repack) logic if pursuing that
   refactor; build `GradebookService` open/create/save/close for `.nxgb`; roster CRUD; the
   privacy-boundary regression test (bank repack never touches a gradebook workspace). No PDF/CV
   dependencies yet.
2. **Hand-off + response-sheet PDF generation** — add `reportlab`/`qrcode`/`Pillow`;
   `layout.py`/`pdf.py` supporting all three row kinds from the start; the
   `create_snapshot_and_sheets` route touching both services; `ResponseSheetPrintPane.tsx` +
   `save_bytes_dialog`; `AdministeredTestsWorkspace.tsx`. Independently shippable: a teacher can
   hand off a test and print sheets today, before any scanning exists.
3. **Scan ingestion + classical CV detection** — add `opencv-python-headless`/`PyMuPDF`; spike the
   PyInstaller build first; `detect.py` runs the fill-ratio primitive against MC/numeric rows,
   skips manual-capture rows. Verified via synthetic round-trip tests, no UI yet.
4. **Review/correction queue** — identity resolution, per-row override, manual score entry against
   cropped capture boxes; `ScanReviewWorkspace.tsx`.
5. **Grade reporting** — totals/by-standard/by-item, `record_batch_as_performance_run` (bank-open
   opt-in), doc updates.

## Verification

No physical printing/scanning needed — the same synthetic-sheet generator is the core test fixture:

1. Hand off a known-answer test (at least one MC, one numeric, one free-response item) into a test
   gradebook, rasterize the resulting PDF back to an image at a DPI deliberately different from the
   internal canonical 300, programmatically fill the correct bubbles at the layout's known
   coordinates, run detection, assert recovered MC/numeric answers exactly match and the
   manual-capture row is present but unscored.
2. Repeat with a synthetic perspective warp + noise/blur before detection, to prove fiducial
   registration tolerates realistic scanner skew.
3. Draw a ~50%-filled bubble and a two-bubbles-filled case; assert `flag` is `low_confidence`/
   `multi_mark`, never a silently wrong single answer.
4. Black out the QR region; assert `identity_status == "qr_unreadable"` and no row results produced.
5. Hand off a snapshot, then mutate the *live* bank test (reorder items) without re-printing; ingest
   against the still-old snapshot/layout; assert results are unaffected — proves the freeze
   invariant holds in code, not just in a docstring.
6. **Privacy regression test:** open a bank and a gradebook simultaneously in the same test process,
   perform a hand-off, call the bank's `save_bank()`, and assert the resulting `.bok` zip contains
   no roster/snapshot/scan/score data — this is the test that actually enforces the whole premise
   of this plan, not just the CV pipeline.
7. Full API-level test: hand off → create batch → ingest a synthetic distorted sheet → resolve
   identity → override one flagged row → manually score the free-response row → fetch report →
   assert totals, by-standard, and `contains_unscored_manual_items` all update correctly.

## Critical files

- `app/backend/models.py`, `app/backend/service.py` (new `add_performance_run` only), `app/backend/gradebook_service.py` (new), `app/backend/main.py`
- `app/backend/requirements.txt`, `app/backend/tests/` (fixtures/conftest pattern to extend with a `gradebook_client`)
- `app/frontend/src/App.tsx` (mode branch for gradebook windows), `app/frontend/src/TestPrintPreview.tsx` (pattern to mirror, not extend), `app/frontend/src/types.ts`, `app/frontend/src/api.ts`, `app/frontend/src/desktop.ts`
- `src-tauri/src/main.rs`, `src-tauri/Cargo.toml` (`rfd` already present)
- `docs/schema.md`, `docs/roadmap.md`, `docs/grading.md` (new), `DISTRIBUTION.md`
- `scripts/build_backend_binary.sh` (PyInstaller spike)
