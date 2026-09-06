# Nexam Architecture (Milestone 1 Draft)

## Design goals

- Local-first desktop app for macOS.
- Single-user workflow.
- Explicit file-based storage using `.bok` zip packages.

## High-level components

1. **Tauri shell**
   - Hosts and packages the frontend.
   - Launches and supervises a local Python backend process.

2. **Frontend (React + TypeScript + Vite)**
   - Four top-level views: Library, Courses, Question Editor, Test Builder.
   - Library: every standard in the bank, grouped by source, with import and manual entry.
   - Courses: a named set of standards plus its tests, with coverage and blind-spot reporting.
   - Question browser with filters.
   - Question editor with form mode and raw JSON mode.
   - KaTeX preview for LaTeX strings.

3. **Backend (Python + FastAPI + Pydantic)**
   - Open/unpack/save/repack `.bok` files.
   - Validate manifest and question schemas.
   - Manage assets and import staging.

## Data flow

1. User opens `.bok` in desktop app.
2. Backend unpacks `.bok` into managed working directory.
3. Frontend reads/modifies working data through local API.
4. Save operation validates data and repacks working directory to `.bok`.

## Packaging model

- `.bok` is a zip container with structured folders.
- Edits happen on unpacked files, not in-place zip mutation.
- Asset copies are stored inside package by default.

## Early non-goals

- No cloud sync.
- No authentication.
- No custom encryption in v1.
