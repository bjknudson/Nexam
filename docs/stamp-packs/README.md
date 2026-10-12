# Nexam stamp packs: format for pack-building tools

This is the contract between a tool that prepares drawing stamps and Nexam's stamp importer (`app/backend/stamp_library.py`). A pack that follows it is filed straight into the teacher's library. The teacher sees it in an import review first and can still change anything, but shouldn't need to.

Files in this folder:

| File | Use |
| --- | --- |
| [`stamps.template.json`](stamps.template.json) | The manifest to fill in. Replace every `<…>`. |
| [`stamps.example.json`](stamps.example.json) | A complete, valid manifest for a real batch. |
| [`stamps.schema.json`](stamps.schema.json) | JSON Schema (draft 2020-12) to validate a manifest before zipping. |
| [`README.template.txt`](README.template.txt) | The fallback format, if the tool can only write a text README. |

## The zip

```text
physics-batch-01.zip
├── stamps.json          ← the manifest (preferred)
├── README.txt           ← optional, for people; kept for provenance
├── disk.svg
├── disk-filled-light.svg
└── vector-arrow.svg
```

- **Layout:** files sit at the top level of the zip, or inside a single wrapper folder (what "Compress folder" produces). Anything in deeper folders is skipped.
- **Names:**
  - `stamps.json`, and `README`, `README.txt` or `README.md`, are matched regardless of case.
  - Every other file must be `.svg`.
  - Use lower-case, hyphenated SVG file names (`vector-arrow.svg`). The file name is part of a stamp's identity (see "Later batches" below), so **keep it stable across batches**.
- **Limits:** at most 200 files, 512 KB per SVG, and 20 MB unpacked.
- **Ignored or rejected:** `__MACOSX/` and dotfiles are ignored. Absolute paths and `..` are rejected.

## How stamps are organized

**Packs are only a delivery format.** One logical set may arrive as several batch zips, so the pack name is never used as a heading. Every stamp is filed by its own fields:

| Field | Meaning | Example values |
| --- | --- | --- |
| `collection` | The subject: the top heading in the Stamps panel. | `Physics`, `Chemistry`, `Biology`, `Math` |
| `category` | The kind of component within the subject: the section it's listed under. | `Mechanics`, `Vectors`, `Circuits`, `Waves`, `Optics`, `Graphs`, `Guides`, `Lab equipment` |
| `topics` | Curriculum topics the stamp is useful for. Used to filter and search; a stamp can have several. | `Collisions`, `Momentum`, `Newton's Laws`, `Projectile motion` |
| `tags` | Free-form search words about how it looks. | `top-view`, `outline`, `filled`, `dashed` |

How to fill these in:

- **Use the same spelling every time.** Matching ignores case (`physics` files under an existing `Physics`), but `Vector` and `Vectors` become two categories. Keep a fixed list of collections and categories in the tool.
- **Collection is the school subject,** not the source or batch. Built-in Nexam stamps use `Physics` with `Mechanics`, `Graphs` and `Circuits`, so packs that use those names sit alongside them.
- **Category is what the stamp *is*,** not which lesson it's for: `Vectors` for arrows, `Guides` for dashed reference lines, `Mechanics` for objects such as carts and blocks.
- **Topics should use the names teachers use for question topics** in their banks (e.g. `Newton's Laws`, `Waves`, `Ohm's law`). Nexam suggests stamps by topic, so matching wording pays off. Two to four topics per stamp is plenty.
- **Description:** one short phrase saying what the stamp shows, e.g. "outline disk/circle". It's shown as the tooltip and is searchable.

## The manifest (`stamps.json`)

```json
{
  "format": "nexam-stamp-pack/1",
  "pack": "Physics stamp batch 01",
  "description": "Derived as reusable components from the supplied collision/top-view reference.",
  "defaults": { "collection": "Physics", "category": "Mechanics", "topics": ["Collisions", "Momentum"], "tags": [] },
  "stamps": [
    { "file": "disk.svg", "name": "Disk", "description": "outline disk/circle" },
    { "file": "vector-arrow.svg", "name": "Vector arrow", "description": "generic editable arrow",
      "category": "Vectors", "topics": ["Vectors", "Collisions"] }
  ],
  "conventions": ["Uses currentColor for stroke/fill where practical", "No text embedded"]
}
```

- **`format`:** always `"nexam-stamp-pack/1"`.
- **`pack`:** the batch's name. It's recorded with each stamp as provenance and never used as a heading.
- **`defaults`:** applies to every stamp in `stamps` that doesn't set the same field itself.
- **Per-stamp fields replace the defaults; they aren't merged with them.**
  - A stamp with `"topics": ["Vectors"]` gets only `Vectors`.
  - `"topics": []` gives it no topics at all.
  - Leave a field out to use the default.
- **`stamps[].file`** must match an SVG in the zip.
  - A listed file that's missing is reported in the review.
  - An SVG in the zip but not listed is still imported, using the defaults and a name taken from its file name, but the tool should list every SVG.
- **`name`:** optional; without it the file name is used (`disk-filled-light.svg` → "Disk filled light"). Use short, capitalised names that read well under a thumbnail.
- **`topics` and `tags`:** may be arrays (preferred) or strings separated by `;` or `,`.
- **`conventions`:** optional notes shown to the teacher in the review.
- **Unknown fields** are ignored, so a tool may add its own (e.g. `"generator": "…"`).

## The SVG files

Each file must be:
- UTF-8 text
- valid XML whose root is `<svg>`
- free of entity declarations (`<!ENTITY …>`)
- 512 KB or smaller

For stamps that work well in printed tests:

- **Size:**
  - Give the root a `viewBox` *and* `width`/`height` at the size the stamp should usually print. Nexam works at 96 px per inch, and a two-column test column is about 318 px wide, so most stamps are 20–130 px.
  - Nexam inserts stamps at that size and shrinks only those too big for the canvas.
- **Shapes:**
  - Use simple shapes (`rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `g`). Teachers can edit these inside a stamp.
  - `path` is accepted and drawn as-is, but it can't be edited in Nexam.
- **Colour:**
  - Black and grays, or `currentColor`. A stamp drawn in `currentColor` is inserted with `color="#000000"`, so it prints black, and the teacher can change it.
  - Tests are photocopied, so avoid relying on colour.
- **Line weight:** about 1.5 px for outlines and 1 px for hatching, to match Nexam's drawing defaults.
- **Text:** avoid embedded text unless it's part of the symbol (e.g. "+" on a battery). Teachers add labels in Nexam, where they can contain `{{variables}}` and math.
- **Self-contained:** no external references (images, fonts, CSS, scripts).

## Later batches

A stamp's identity is **collection + category + file name**.
- If a later batch sends a file with the same identity and **identical content**, it's skipped, but any new topics and tags are added to it.
- If the content is **different**, the review offers to replace it (the old version is kept aside) or keep both.
- So a tool can safely re-send a whole set. It should keep file names stable, and change a file name only when it means a genuinely different stamp.

## If the tool can only write a README

[`README.template.txt`](README.template.txt) shows the text fallback:
- **Header lines** set the defaults: `Collection:`, `Category:`, `Topics:` and `Tags:`.
- **Files** are described with `- file.svg: description`, optionally ending in `[category: Vectors; topics: Vectors, Collisions]`.

The manifest is preferred because it can't be misread. If a zip has both, the manifest is used and the README is kept for people.

## Checking a pack

1. Validate `stamps.json` against `stamps.schema.json`.
2. Check that every `stamps[].file` exists in the zip, and every SVG in the zip is listed.
3. Import it in Nexam's drawing tool: Stamps → **Add stamps (SVG or zip)…**. The review should show every row already filed (no "Required" fields) and no "can't be imported" list.
