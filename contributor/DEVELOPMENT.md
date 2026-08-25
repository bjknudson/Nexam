# Nexzam — Developer Reference

Quick reference for building and running Nexzam from source. For the
product-level description of what Nexzam does, see the root
[README.md](../README.md). For the contribution process (issue/PR
conventions, code style, etc.), see [CONTRIBUTOR.md](CONTRIBUTOR.md)
(in progress).

## Core stack

- **Tauri 2** desktop shell (Rust)
- **React + TypeScript + Vite** frontend
- **Python + FastAPI + Pydantic** backend
- **`.bok`** zip package as the source-of-truth file format

## Repo layout

```text
nexzam/
├── README.md                # user-facing help doc
├── AGENTS.md                # instructions for AI coding agents
├── DISTRIBUTION.md           # building/sharing a beta .app with testers
├── contributor/
│   ├── DEVELOPMENT.md        # this file
│   └── CONTRIBUTOR.md        # contribution process (WIP)
├── docs/
│   ├── architecture.md
│   ├── decisions.md
│   ├── roadmap.md
│   ├── schema.md             # full `.bok` field-level schema reference
│   └── svg-editor-plan.md
├── app/
│   ├── backend/
│   │   ├── main.py           # FastAPI routes
│   │   ├── models.py         # Pydantic models
│   │   ├── service.py        # bank/question/test/asset workspace logic
│   │   ├── bundle_entrypoint.py  # PyInstaller entrypoint for release builds
│   │   ├── requirements.txt
│   │   ├── requirements-dev.txt
│   │   └── tests/
│   └── frontend/
│       ├── package.json
│       ├── src/
│       │   ├── App.tsx                  # top-level shell, question editor pane
│       │   ├── BankPropertiesDialog.tsx # new/edit bank title+description
│       │   ├── QuestionImportWorkspace.tsx # bulk JSON/CSV question staging
│       │   ├── StandardsWorkspace.tsx   # standards library: browse, import, manual entry
│       │   ├── CoursesWorkspace.tsx     # courses: standards, tests, coverage gaps
│       │   ├── TestBuilderPane.tsx      # test draft assembly
│       │   ├── TestPrintPreview.tsx     # print/PDF preview
│       │   ├── MathPreview.tsx          # KaTeX rendering helpers
│       │   ├── Settings.tsx
│       │   ├── api.ts
│       │   ├── desktop.ts               # Tauri bridge / browser-mode fallbacks
│       │   └── types.ts
│       └── vite.config.ts
├── src-tauri/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs           # menu, windows, update check
│   │   └── backend.rs        # spawns/health-checks the Python backend
│   └── tauri.conf.json
├── samples/
│   ├── demo-bank/
│   ├── demo-bank.bok
│   ├── sample-import.csv            # bulk question import example
│   └── sample-standards-import.csv  # standards import with per-standard sources
└── scripts/
    ├── build_backend_binary.sh
    └── build_demo_bok.py
```

## `.bok` package layout

`.bok` files are zip packages with this internal structure:

```text
mybank.bok
├── manifest.json
├── bank.json
├── standards/
│   ├── source_lists.json
│   └── records.json
├── courses/
│   └── courses.json
├── questions/
│   ├── q_mc_0001.json
│   ├── q_num_0001.json
│   ├── q_sa_0001.json
│   └── q_fr_0001.json
├── tests/
│   └── tests.json
├── assets/
│   └── *.svg / *.jpg / *.png
├── imports/
│   └── source files kept alongside staged imports
└── meta/
    └── audit_log.json
```

See [docs/schema.md](../docs/schema.md) for the full field-level schema
(question types, standards collections, asset metadata, test draft
shape, validation principles).

## Backend setup

Install backend dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r app/backend/requirements.txt
```

For test development, also install the dev requirements:

```bash
python3 -m pip install -r app/backend/requirements-dev.txt
```

Run the API standalone from the repo root:

```bash
python3 -m uvicorn app.backend.main:app --reload
```

## Frontend setup

Prerequisites: Node.js 20+, npm 10+.

```bash
cd app/frontend
npm install
npm run dev
```

The Vite dev server runs on `http://127.0.0.1:5173` and proxies `/api`
to the backend on port `8000` in browser-only dev.

## Browser dev flow

Run the frontend in a browser without Tauri:

1. Start the backend: `python3 -m uvicorn app.backend.main:app --reload --port 8000`
2. Start the frontend: `cd app/frontend && npm install && npm run dev`
3. Open `http://localhost:5173`

Native open/save dialogs aren't available outside the Tauri shell.
Toggle "Show full paths" in Settings to reveal a manual archive-path
field as a fallback.

## Tauri dev shell

Prerequisites: Rust toolchain, Tauri CLI, Xcode command line tools on
macOS.

Recommended local setup:

- repo-root virtualenv at `.venv` with backend requirements installed
- frontend dependencies installed in `app/frontend`

Then, from `app/frontend`:

```bash
npm install
npm run tauri:dev
```

The `tauri:dev` script enters `src-tauri/` before invoking the Tauri
CLI, so the CLI, config, and build hooks all resolve paths from the
same place.

What the desktop shell does ([src-tauri/src/backend.rs](../src-tauri/src/backend.rs)):

- in dev builds, launches the backend with repo-root `.venv/bin/python3`
  (falling back to `python3` on PATH)
- in release builds, launches a PyInstaller-frozen backend bundled as
  an app resource — no Python install required (see below)
- waits for the backend health check before enabling the UI
- exposes the backend base URL to the frontend
- opens native macOS open/save dialogs for `.bok`
- warns on close if the working copy has unsaved changes
- checks GitHub releases for updates on launch and from the Help menu

## Building a distributable bundle

```bash
source .venv/bin/activate
./scripts/package_release.sh
```

This freezes the backend with PyInstaller, builds the frontend, bundles the
`.app`, **re-signs it** (`codesign --force --deep --sign -`), and zips it.
The re-sign step is required, not optional: `tauri build`'s own ad-hoc
signature doesn't reliably seal `Contents/Resources` once the frozen backend
is bundled in, which passes locally but gets Gatekeeper-rejected as
"damaged" (not just "unidentified developer") once a copy is downloaded and
carries the `com.apple.quarantine` flag. See [DISTRIBUTION.md](../DISTRIBUTION.md)
for the full explanation and for sharing a beta build with testers.

## API endpoints

```text
GET    /health
GET    /api/health

POST   /api/banks/open
POST   /api/banks/open-demo
GET    /api/banks/current
POST   /api/banks/create
PUT    /api/banks/current
POST   /api/banks/save

GET    /api/questions
GET    /api/questions/next-id?type={question_type}
GET    /api/questions/{question_id}
POST   /api/questions
POST   /api/questions/from-json
PUT    /api/questions/{question_id}
DELETE /api/questions/{question_id}

GET    /api/question-imports
POST   /api/question-imports/stage
GET    /api/question-imports/{import_id}
PUT    /api/question-imports/{import_id}/rows/{row_id}
POST   /api/question-imports/{import_id}/promote

GET    /api/standards/source-lists
GET    /api/standards
POST   /api/standards/import
POST   /api/standards/import/inspect
POST   /api/standards/manual
PUT    /api/standards/{standard_id}
POST   /api/standards/placeholders

GET    /api/courses
GET    /api/courses/{course_id}
PUT    /api/courses/{course_id}
DELETE /api/courses/{course_id}
POST   /api/courses/{course_id}/seed
POST   /api/courses/{course_id}/standards/{standard_id}
DELETE /api/courses/{course_id}/standards/{standard_id}

GET    /api/tests
POST   /api/tests
GET    /api/tests/{test_id}
PUT    /api/tests/{test_id}
PUT    /api/tests/{test_id}/courses
POST   /api/tests/{test_id}/copy
POST   /api/tests/{test_id}/items

GET    /api/assets
POST   /api/assets/upload
POST   /api/assets/inspect
GET    /api/assets/file
```

## Save model

Nexzam distinguishes two save layers:

- **Working copy**: unpacked files in a managed workspace directory.
  Form edits autosave here; raw JSON edits save here only when
  explicitly requested (`Save`, `Save as New`).
- **Archive**: the `.bok` zip file on disk. `Save Bank` (or `Save As`)
  writes this layer from the working copy.

The top bar's status pills reflect both layers independently, so it's
possible to have an up-to-date working copy with an archive that still
needs `Save Bank`.

## Testing

```bash
source .venv/bin/activate
python3 -m pytest
```

Broader local verification:

```bash
python3 -m compileall app/backend/main.py app/backend/models.py app/backend/service.py
cd app/frontend && npx tsc -p tsconfig.json --noEmit && npm run build
cd ../../src-tauri && cargo check
cargo test wait_for_healthcheck
```

## Unfinished edges

- No automated `.bok` migration layer yet; validation is strict
  against the current schema (`manifest.json`'s `schema_version`).
- Browser-only dev still relies on the manual archive-path fallback
  because native open/save dialogs are wired through Tauri commands.
- The app isn't code-signed yet, so release builds show a Gatekeeper
  warning on first launch (see [DISTRIBUTION.md](../DISTRIBUTION.md)).
- No auto-update installer yet — "Check for Updates" links out to the
  GitHub releases page rather than installing in place.

## Related docs

- [docs/architecture.md](../docs/architecture.md)
- [docs/decisions.md](../docs/decisions.md)
- [docs/roadmap.md](../docs/roadmap.md)
- [docs/schema.md](../docs/schema.md)
- [docs/svg-editor-plan.md](../docs/svg-editor-plan.md)
- [DISTRIBUTION.md](../DISTRIBUTION.md)
