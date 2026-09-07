# Nexam agent guidance

## Product and architecture priorities

- Nexam is **desktop-first** and **local-first**.
- Do **not** add user-account, authentication, or multi-user systems.
- `.bok` is the source-of-truth package format.
- Use an unpacked working directory for edits, then repack on save.

## Code and schema principles

- Prefer readable, explicit code over clever abstractions.
- Preserve backward compatibility for persisted bank files.
- Never silently rename persisted fields.
- Prefer small, reviewable changes.
- Request schema migrations only when necessary.

## UX guidance

- Keep React UI simple and teacher-focused.
- Keep editor and browser workflows obvious and low-friction.
- Prefer portability and inspectability of files over opaque storage tricks.

## v1 scope reminders

- Required fields: `id`, `type`, `topic`, `difficulty`, `prompt`.
- Support from start: answers, explanations, rubrics, sample solutions, teacher-only notes, standards, tags, points, estimated time, and assets.
- Support parameterized SVG metadata in schema from the beginning.
- Use KaTeX for preview and HTML-to-PDF for initial export path.
