# Passages (design draft)

Status: **proposal**, not implemented. Written against the schema in `docs/schema.md`
as of the 0.12.x line.

## Problem

Some questions cannot stand alone. A reading comprehension set, a lab data table, a
document-based history prompt, and a shared diagram all have the same shape: one piece
of stimulus material, several questions about it.

Nexam has no way to express that today. The only options are both bad:

- **Duplicate the stimulus into every question's prompt.** Six questions about one
  passage means six copies of the text. A typo fix is six edits, and a printed test
  repeats the passage six times.
- **Put it in the first question and hope.** The questions become order-dependent, and
  reordering a test or pulling one question into a different test silently breaks it.

Both fight the principle already established in `docs/schema.md`: questions are the
reusable source of truth, and everything else references them rather than copying them.
A passage is the same idea applied one level up.

## What a passage is

A **passage** is stimulus material that one or more questions refer to. It may hold text,
an asset, or both:

- a reading selection or excerpt
- a data table from an experiment
- a historical document
- a large diagram or map that several questions interrogate

### What a passage is not

**Size is not the test — sharing is.** A single force diagram attached to a single
question is an asset on that question, and should stay one. What makes something a
passage is that more than one question depends on it, so the material needs an identity
of its own and must print exactly once.

This matters because the obvious rule ("big things become passages") produces a worse
model: it forces authors to make a classification decision at authoring time based on a
property that does not affect anything, and it leaves single-question stimulus material
in a structure built for sharing.

## Schema

### Storage

A new package folder, consistent with the existing layout:

- `passages/passages.json` — a collection file, matching how courses and tests are stored.

A single collection rather than one file per passage: passages are far fewer than
questions, are usually read as a set when building a test, and have no per-file
concurrency concern.

```json
{
  "items": [
    {
      "id": "psg_0001",
      "title": "The Gettysburg Address",
      "kind": "text",
      "body": "Four score and seven years ago...",
      "attribution": "Abraham Lincoln, 1863",
      "assets": [],
      "tags": ["primary-source", "civil-war"],
      "standards": [{ "standard_id": "APUSH-KC-5.2.I" }],
      "teacher_notes": null
    }
  ]
}
```

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | `psg_0001` style, matching the `q_mc_0001` convention |
| `title` | yes | Shown in pickers and optionally above the passage in print |
| `kind` | yes | `text`, `table`, `asset`, or `mixed` — drives layout, not validation |
| `body` | no | Passage text; KaTeX-capable like a prompt |
| `attribution` | no | Source line printed beneath the passage |
| `assets` | no | Same `AssetModel` shape questions already use |
| `tags`, `standards`, `teacher_notes` | no | Same shapes and semantics as on a question |

A passage needs at least one of `body` or `assets` to be non-empty.

### Question reference

One additive, optional field on `QuestionModel`:

```json
{
  "id": "q_mc_0031",
  "passage_id": "psg_0001"
}
```

Reference, not embed — same as `standards`. Questions without `passage_id` are unchanged,
so every existing bank stays valid with no migration. This satisfies the additive-evolution
rule in `docs/schema.md`.

A question belongs to at most one passage. Questions drawing on two documents (a common
DBQ pattern) are better served by a passage that itself contains both documents than by a
many-to-many relationship, which would make print ordering ambiguous.

### Validation

Follow the existing precedent for unresolved standard references: **keep the bank open and
make the problem visible.** A question pointing at a missing `passage_id` should get a
placeholder passage in the working copy tagged `placeholder` and `needs-review`, rather
than failing the open.

Deleting a passage that questions still reference should warn and list the dependents,
the way deleting a heavily-used standard should.

## Test drafts

This is where passages cost the most, because test items are currently a flat list.

`tests.json` items today are either a question reference or a section header. Passages add
a third kind that **owns a run of questions**:

```json
{
  "item_type": "passage",
  "passage_id": "psg_0001",
  "items": [
    { "question_id": "q_mc_0031" },
    { "question_id": "q_mc_0032" },
    { "question_id": "q_fr_0007" }
  ],
  "keep_together": true,
  "repeat_on_break": false
}
```

Nesting rather than flattening, because the group is the unit that must move, reorder, and
stay together. A flat list with a `passage_start` marker would let a drag-and-drop reorder
split a group silently.

Older tests with no `item_type` remain valid, as they already do for question items.

## Print layout

The hard part. `.print-question-flow` uses CSS `column-count`, and a passage group is
frequently taller than one column.

Three rules, in priority order:

1. **The passage prints once**, immediately above its first question.
2. **A passage never separates from its first question.** A passage stranded at the bottom
   of a column with its questions overleaf is the worst outcome and must be prevented.
3. **The group prefers to stay whole** (`break-inside: avoid` on the group), but a group
   taller than one column must be allowed to break, or it vanishes from the layout
   entirely — a real CSS multi-column failure mode, not a hypothetical.

When a group must break, two conventions exist and they suit different material:

- **Continue** — passage, then as many questions as fit, remainder flows on with a
  "Questions 4-6 refer to the passage on the previous page" line. Standard for reading
  tests. Saves paper.
- **Repeat** — the passage reprints at the top of the new column or page. Standard for
  data tables and diagrams, where flipping back is a real burden on a timed test.

The `repeat_on_break` flag above lets the author choose per passage, defaulting to
`false` (continue) for text and `true` for `table` and `asset` kinds. Guessing a single
global rule here will be wrong for half the material.

## Authoring workflow

**Creating.** A passage is created from the Standards-style workspace or from a question:
"Move this stimulus into a passage" takes the material currently at the top of a prompt,
creates a passage, and links the question. That path matters — most passages will be
discovered in existing content, not authored fresh.

**Attaching.** The question editor gets a Passage row beside Standards, using the same
attach/detach interaction the standards picker already provides.

**Collecting.** The question browser gains a passage filter, and the test builder gains
"Add all questions for this passage." This is the workflow benefit that motivated the
feature: a passage becomes a unit of reuse across tests, not just a layout device.

**Previewing.** The question editor shows the attached passage above the prompt, collapsed
by default — a passage is often longer than the question, and expanding it by default would
bury the item being edited.

## Phasing

The value is front-loaded; the layout work is not.

1. **Schema and storage** — `passages/passages.json`, `passage_id` on questions,
   validation and placeholder behavior. Nothing visible, everything else depends on it.
2. **Authoring** — create, edit, attach, detach, and the passage filter in the browser.
   At this point passages are useful for organizing a bank even with no print support.
3. **Test grouping** — the nested `passage` test item, grouped reorder, "add all questions."
4. **Print layout** — print once, keep-together, and the continue/repeat break rules.

Steps 1 and 2 are self-contained and could ship without 3 and 4. A bank author gets value
from deduplicating shared stimulus material before any test ever prints it.

## Open questions

- **Passage-level points and timing.** A reading set often carries a suggested time for the
  whole group. Does that live on the passage, the test item, or stay derived from the
  questions?
- **Cross-bank reuse.** Passages are the most likely thing an author would want to share
  between banks. Out of scope here, but the `id` scheme should not preclude it.
- **Question independence.** If a question's `passage_id` is dropped, does its prompt still
  make sense on its own? Probably worth a soft warning rather than a rule.
- **Answer keys.** Should the key reprint the passage, or reference it? Likely reference.
