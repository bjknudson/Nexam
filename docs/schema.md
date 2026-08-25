# Nexzam Schema (Milestone 1 Draft)

## Package-level files

- `manifest.json`: package metadata and schema/version info.
- `bank.json`: index and high-level bank metadata.
- `questions/*.json`: one file per question.
- `standards/source_lists.json`: the sources standards came from, one per imported or hand-entered set.
- `standards/records.json`: the standards library -- every standard in the bank, each filed under its source.
- `courses/courses.json`: courses, each a named collection of standard references.
- `tests/tests.json`: additive test draft collection for print-prep workflows, including the courses each test serves.
- `assets/*`: copied image/SVG assets.
- `imports/*`: imported source files and staging references.
- `meta/*`: audit and maintenance metadata.

## Manifest shape (draft)

```json
{
  "schema_version": "1.0.0",
  "bank_id": "demo-bank",
  "title": "Physics 1",
  "created_at": "2026-04-11T00:00:00Z",
  "updated_at": "2026-04-11T00:00:00Z",
  "difficulty_labels": {
    "1": "easy",
    "2": "easy-medium",
    "3": "medium",
    "4": "medium-hard",
    "5": "hard"
  }
}
```

## Question types (v1)

- `multiple_choice`
- `numeric_response`
- `short_answer`
- `free_response`

## Required question fields

- `id`
- `type`
- `topic`
- `difficulty`
- `prompt`

## Additional supported fields

- `subtopic`
- `tags`
- `standards`
- `estimated_time_sec`
- `points`
- `status`
- `teacher_notes`
- `answer`
- `explanation`
- `rubric`
- `sample_solution`
- `assets`

## Standards collections (draft)

Every standard belongs to exactly one source. The **library** is the whole bank of standards
across all sources; `source_list_id` is what files a standard under its source, and the set of
sources is maintained from the standards themselves rather than curated separately.

Source standard lists are preserved as complete imported reference sets:

```json
{
  "items": [
    {
      "id": "physics-core-2026",
      "title": "Physics Core Standards",
      "issuer": "Nexzam Sample Curriculum",
      "subject": "Physics",
      "version": "2026.1",
      "description": "Sample complete reference set for introductory physics topics.",
      "imported_at": "2026-04-11T00:00:00Z"
    }
  ]
}
```

Standard records stay explicit and are referenced by id:

```json
{
  "items": [
    {
      "id": "PHY-KIN-01",
      "source_list_id": "physics-core-2026",
      "code": "PHY-KIN-01",
      "statement": "Apply constant-acceleration relationships to one-dimensional motion.",
      "strand": "Mechanics"
    }
  ]
}
```

`strand` is optional and defaults to `null`, so banks written before it existed load unchanged.
Standards are browsed sorted by source, filterable by source and strand, and searchable across
every text field including the strand.

A **course** is a named collection of standards a teacher actually teaches, stored as references
rather than duplicated text:

```json
{
  "items": [
    {
      "id": "physics-1",
      "title": "Physics 1",
      "description": "Sample course curation.",
      "standard_refs": [
        {
          "standard_id": "PHY-KIN-01"
        }
      ]
    }
  ]
}
```

Tests point at courses (see `course_ids` under test drafts), so a course view can report which of
its standards its tests cover, how many times, which are not covered at all, and which standards
the tests reach that the course does not list.

## Standards import formats

CSV headers supported:

- required: `id` or `standard_id`, `code`, `statement`
- optional: `strand`, `subject`, `grade_band`, `tags`
- per-standard source: `source` or `source_title`, plus optional `source_id`/`source_list_id`,
  `issuer`, `source_subject`, `source_version`, `source_description`

JSON imports may be:

- an array of standards
- an object with `items`
- an object with `source_list` and `standards`

A JSON standard may also carry its own `source` object with `id`, `title`, `issuer`, `subject`,
`version`, and `description`.

Because every standard has a source, the importer resolves one for each row before writing
anything:

1. Source information carried by the standard itself wins. A file may name several sources, and
   the import is split into one group per source.
2. A source id that already exists is reused as-is; an import never rewrites the metadata of a
   source already on file.
3. Anything the file leaves unattributed falls back to the source supplied with the import, which
   is why `POST /api/standards/import/inspect` exists: it reports `needs_source_input` so the
   caller only asks for source details when the file cannot name a source for every standard.

A source id may be omitted when a title is present; it is then slugified from the title. When a
source is new and no issuer can be resolved for it, the import fails with a 422 rather than
inventing one.

Imported source files may be copied into `imports/` for reference alongside the normalized standards collections.

Standards can also be entered by hand instead of uploaded. Manual entry posts rows to
`/api/standards/manual` and writes the same `standards/source_lists.json` and
`standards/records.json` records as a file import, with two differences: no file is copied into
`imports/`, and rows may be appended to a source list that already exists. A row needs `id` and
`statement`; `code` defaults to `id`, and `subject` falls back to the source list subject. Each row
may name its own source via `source_list_id` plus, for a new source, `source_title`,
`source_issuer`, `source_subject`, `source_version`, and `source_description`. Rows that name no
source fall back to the request-level source fields.

## Passages

Shared stimulus material (reading selections, data tables, documents, diagrams referenced
by more than one question) is a proposed addition, not implemented. See
`docs/passages-design.md` for the schema, test-grouping, and print-layout design.

## Asset metadata (draft)

Support static and parameterized SVG metadata:

```json
{
  "path": "assets/fig_shm_01.svg",
  "kind": "svg",
  "svg_variables": {
    "label": "A",
    "mass": "2kg"
  }
}
```

`svg_variables` keys map to token placeholders like `{{label}}` in source SVG templates.
Numeric geometry can also use simple expressions such as `{{calc: 60 - arrow_length}}`, referencing values from the same `svg_variables` map.

Questions may attach more than one asset by adding multiple entries to the `assets` array.

Question standards should be stored as references:

```json
[
  {
    "standard_id": "PHY-KIN-01"
  }
]
```

## Test drafts (Phase 4 draft)

Test drafts are stored separately from question records so questions remain the reusable source of truth:

```json
{
  "items": [
    {
      "id": "test_0001",
      "title": "Unit 1 Mechanics",
      "version": "A",
      "course_ids": ["physics-1"],
      "items": [
        {
          "question_id": "q_mc_0001",
          "experimental": false,
          "response_space_lines": null,
          "teacher_notes": null
        },
        {
          "item_type": "section",
          "section_id": "section_1",
          "question_type": "multiple_choice",
          "title": "Multiple Choice",
          "instructions": "Select the best answer.",
          "header_template": "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
          "topic": "Linear motion",
          "standards": ["PHY-KIN-01"],
          "suggested_time_mode": "calculated",
          "suggested_time_sec": null
        }
      ],
      "print_settings": {
        "cover_sheet_enabled": true,
        "cover_sheet_template": null,
        "page_header": {
          "template": "{{title}}\nVersion {{version}}    {{date}}",
          "alignment": "center",
          "horizontal_line": true,
          "spacing_after_lines": 1
        },
        "name_field": {
          "template": "Name: ______________________________",
          "alignment": "left",
          "horizontal_line": false,
          "spacing_after_lines": 1
        },
        "typeface": "system",
        "font_size_pt": 11,
        "margin_in": 0.75,
        "page_size": "letter",
        "columns": 1,
        "name_field_enabled": true,
        "page_numbers_enabled": true,
        "default_response_space_lines": 0,
        "instruction_section_options": {
          "show_topic": false,
          "show_standards": false,
          "show_suggested_time": true,
          "alignment": "left",
          "horizontal_line": true,
          "spacing_after_lines": 1
        },
        "instruction_sections": [
          {
            "question_type": "multiple_choice",
            "title": "Multiple Choice",
            "instructions": "Select the best answer.",
            "header_template": "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
            "show_topic": false,
            "show_standards": false,
            "show_suggested_time": true,
            "suggested_time_mode": "calculated",
            "suggested_time_sec": null
          }
        ]
      },
      "performance_runs": []
    }
  ]
}
```

`course_ids` associates a test with one or more courses. It is a list because the same test may be
reused across courses, or across a course being retaught, without being taken away from anywhere
else. It defaults to an empty list, so tests written before it existed load unchanged.

Test items can be question references or explicit section headers. Older question-only test items remain valid without `item_type`; section items use `item_type: "section"` and can be reordered with questions. If a manual section is linked to a `question_type`, the printable preview can reuse that style's default instructions and suppress the immediately repeated automatic style header.

Template blocks use plain text with placeholders. Current placeholders include `{{title}}`, `{{version}}`, `{{date}}`, `{{section_title}}`, `{{instructions}}`, `{{topic}}`, `{{standards}}`, and `{{time}}`.

Performance runs are kept on the test draft as local post-use records:

```json
{
  "id": "run_20260601_a",
  "administered_at": "2026-06-01T17:00:00Z",
  "cohort_label": "Period 2",
  "notes": "First use after review lesson.",
  "item_results": [
    {
      "question_id": "q_mc_0001",
      "attempts": 28,
      "correct": 19,
      "average_score": null,
      "observed_difficulty": 3.4,
      "tricky": true,
      "notes": "Many students missed the sign convention."
    }
  ]
}
```

## Validation principles

- Validate on open/import/save.
- If a question or course references a standard id that is missing from `standards/records.json`, create a placeholder standard record in the unpacked working copy under `unresolved-question-standards` with `placeholder` and `needs-review` tags. This keeps the bank open and makes the issue visible without dropping the reference.
- If a test references a course id that is missing from `courses/courses.json`, drop that reference on open. A course that no longer exists is not a broken bank, so the repair is silent rather than fatal.
- Deleting a course strips its id from every test that referenced it. The course's standards stay in the library and its tests stay in the bank.
- Keep persisted field names stable.
- Prefer additive schema evolution.
