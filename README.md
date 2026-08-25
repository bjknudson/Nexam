# Nexzam

Nexzam is a desktop app for building and maintaining a question bank
and turning it into printable tests — without a subscription, an
account, or an internet connection.

Everything you make lives in a single `.bok` file: a zip package of
plain JSON that you can back up, move between computers, or hand to a
colleague like any other document. Open the file, and you'll find
readable JSON — one file per question, plus your standards, courses,
tests, and attached images — not a proprietary blob.

```text
mybank.bok
├── manifest.json     # bank title, description
├── questions/        # one JSON file per question
├── standards/        # your standards library, filed by source
├── courses/          # named sets of the standards each course teaches
├── tests/            # test drafts assembled from your questions
└── assets/           # images and SVG diagrams attached to questions
```

## Features

- **Math formatting** — Write math right in a prompt or answer using
  `$v^2 = u^2 + 2as$`, `\( ... \)`, `\[ ... \]`, or plain notation like
  `x^2`, and Nexzam renders it live with KaTeX. The stored JSON stays
  exactly what you typed.
- **Print-ready export** — Assemble a test in the Test Builder, open
  Print Preview, and use your system print dialog to save it as a
  paginated PDF.
- **Local-first `.bok` files** — No account, no cloud, no lock-in.
  Your bank is one file on your disk.
- **Image and SVG assets** — Attach diagrams and photos to questions,
  including parameterized SVG templates whose labels and values you
  can adjust per question.

## Tools

### Question Editor

Browse and filter your question bank, then edit a question in form
mode or switch to raw JSON for full control. Every question has a
`type`, `topic`, `difficulty`, and `prompt`; everything else depends
on the type. Nexzam supports four question types:

**`multiple_choice`**

```json
{
  "id": "q_mc_0001",
  "type": "multiple_choice",
  "topic": "Mechanics",
  "difficulty": 2,
  "prompt": "A cart starts from rest and accelerates at 2 m/s^2 for 3 s. What is its final speed?",
  "answer": {
    "choices": ["3 m/s", "6 m/s", "9 m/s", "12 m/s"],
    "correct_choice_index": 1
  },
  "explanation": "Use v = u + at with u = 0, a = 2, t = 3."
}
```

**`numeric_response`**

```json
{
  "id": "q_num_0001",
  "type": "numeric_response",
  "topic": "Waves",
  "difficulty": 3,
  "prompt": "A wave has speed 12 m/s and wavelength 3 m. Find its frequency.",
  "answer": { "value": 4, "unit": "Hz", "tolerance": 0.05 },
  "explanation": "Use v = fλ, so f = v/λ = 12/3 = 4 Hz."
}
```

**`short_answer`**

```json
{
  "id": "q_sa_0001",
  "type": "short_answer",
  "topic": "Electricity",
  "difficulty": 2,
  "prompt": "State Ohm's law in words and write the symbolic equation.",
  "sample_solution": "Current is directly proportional to voltage for a conductor at constant temperature: V = IR."
}
```

**`free_response`**

```json
{
  "id": "q_fr_0001",
  "type": "free_response",
  "topic": "Mechanics",
  "difficulty": 4,
  "prompt": "Explain the difference between mass and weight, and give one real-world example.",
  "rubric": [
    { "criterion": "Defines mass", "points": 1 },
    { "criterion": "Defines weight", "points": 1 },
    { "criterion": "States equation W=mg", "points": 1 },
    { "criterion": "Provides valid example", "points": 1 }
  ]
}
```

A question can also carry `subtopic`, `tags`, `standards`, `points`,
`status`, `teacher_notes`, and `assets` — all optional.

### Import Questions

Paste JSON or CSV containing many questions at once. Nexzam stages
each row, flags problems (invalid fields, unknown standards, etc.) so
you can fix them before they land in your bank, and lets you promote
the ones you want. This is the fastest way to bring in AI-generated or
spreadsheet-authored questions in bulk — see [Generating questions
with AI](#generating-questions-with-ai) below.

### Library

The library is every standard in your bank. Each standard is filed
under the source it came from — a state framework, a published set,
your own district list — and you browse the library sorted by source,
filtered by source or strand, and searched by anything the standard
says.

Import a set of standards from CSV or JSON, or type them in by hand.
CSV needs `id` (or `standard_id`), `code`, and `statement` columns,
plus optional `strand`, `subject`, `grade_band`, and `tags`. JSON can
be a plain array of standard objects, `{ "items": [...] }`, or
`{ "source_list": {...}, "standards": [...] }`.

Nexzam reads the source out of the file first. Add a `source` (or
`source_title`) column — optionally with `source_id` and `issuer` — and
one file can bring in standards from several sources at once, each
kept with its own. Only when the file cannot name a source for every
standard does Nexzam ask you for one to cover the rest.

When you add a standard by hand you pick its source from the ones
already in the library, or choose **Add new source...** and describe a
new one right there.

### Courses

A course is a named set of standards you actually teach, plus the
tests that assess them. Pull standards into it from the library and
attach tests to it — a test can belong to more than one course, so
reusing a midterm when a course is retaught does not take it away from
anywhere else.

The course view then shows you what your tests actually cover: which
of the course's standards are assessed and how many times, which are
not assessed at all (the blind spots), and which standards the tests
reach that the course never listed — reading and writing standards
often turn up that way.

### Test Builder

Pick questions from your bank to assemble a test draft, reorder them,
and drop in section headers (e.g. "Multiple Choice — select the best
answer"). Configure the print layout — page size, columns, font size,
margins, cover sheet, name field — then open Print Preview to see the
formatted, paginated result and export it to PDF.

## Getting started

1. Open the bundled demo bank to explore, or start a new one from the
   app menu.
2. Browse and edit questions in the **Question Editor**.
3. Attach images or SVG diagrams to a question from its asset panel.
4. Import a standards list into the **Library** and align questions to
   it.
5. Create a course under **Courses**, pull in the standards it teaches,
   and attach its tests.
6. Build a test in **Test Builder**, then open Print Preview and
   **Print** to save it as a PDF.
7. Click **Save Bank** to write your changes back into the `.bok`
   file. (Nexzam autosaves form edits to a local working copy as you
   go; raw JSON edits and the `.bok` archive itself are saved
   explicitly.)

### Generating questions with AI

Because every question is just JSON, you can hand an existing one to
an AI assistant as a template. Open a question's **Raw JSON** tab in
the Question Editor, copy it, and ask something like:

> Using this JSON as a schema example, write 5 more `multiple_choice`
> questions about projectile motion at difficulty 3. Return only a
> JSON array in the same shape.

Paste the result into **Import Questions** to review, fix any flagged
issues, and promote the ones you want — or paste a single question
into a question's Raw JSON tab and use **Save as New**.

## License

Nexzam is free software, licensed under the [GNU General Public
License v3.0 or later](LICENSE) — a share-alike license: if you
distribute a modified version, you must pass the same source-access
freedoms on to your users. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
for the licenses of the open-source components Nexzam is built on.

---

Looking to build Nexzam from source or contribute? See
[contributor/DEVELOPMENT.md](contributor/DEVELOPMENT.md).
