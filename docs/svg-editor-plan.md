# SVG Editor Plan

## Goal

Add a teacher-friendly SVG editor that can build and edit simple instructional diagrams directly inside Nexam without requiring an external vector tool.

## Scope for the first editor slice

- create and edit basic shapes:
  - line
  - rectangle
  - ellipse/circle
  - polygon/polyline
  - arrowed line
  - text
- edit common style properties:
  - stroke color
  - stroke width
  - stroke dash
  - fill color
  - opacity
  - font size
  - text anchor/alignment
- support placeholder or variable text values such as `{{label}}`
- save editor output as plain SVG files under `assets/`
- keep generated SVG readable and inspectable on disk

## Recommended document model

Use an internal scene model that maps cleanly to SVG:

- document
  - width
  - height
  - viewBox
  - optional background
- elements[]
  - id
  - type
  - geometry
  - style
  - transform
  - text content when relevant
  - variable metadata when relevant

This model should stay editor-native in memory, but serialize back to ordinary SVG on save. That keeps `.bok` portable and avoids inventing a second opaque asset format.

## Variable text model

Support two text modes:

- literal text
- variable text

Variable text should carry:

- `variable_name`
- `default_value`
- optional `label`

On SVG export, variable text renders as `{{variable_name}}`. The current question-level `svg_variables` map can continue to populate these placeholders with no schema break.

For numeric geometry, Nexam can also support simple SVG expressions such as `{{calc: 60 - arrow_length}}`. That lets one variable drive line length, arrowhead position, and label position together instead of forcing authors to hand-calculate every coordinate.

## Editing workflow

1. User creates a new SVG asset or opens an existing SVG asset.
2. Nexam parses supported SVG nodes into the internal scene model.
3. The canvas supports select, move, resize, reorder, duplicate, and delete.
4. The inspector shows geometry and style controls for the current selection.
5. Text nodes can toggle between literal text and variable placeholders.
6. Save writes plain SVG back to `assets/`.

## Rendering and parsing requirements

### Export

- generate stable, readable SVG markup
- preserve `viewBox`
- preserve placeholder text exactly as `{{name}}`
- use explicit attributes instead of style blobs where possible

### Import

The first parser should support a constrained subset:

- `line`
- `rect`
- `circle`
- `ellipse`
- `polygon`
- `polyline`
- `text`
- simple `path` only for known library elements
- groups with basic transforms

Unsupported nodes should remain editable as opaque passthrough blocks or trigger a warning instead of being silently discarded.

## UI layout

Recommended layout for the editor:

- left rail:
  - tool palette
  - reusable element library
- center:
  - SVG canvas
  - grid and snap controls
- right rail:
  - selection inspector
  - fill/stroke/text controls
  - variable controls

## Reusable element library

Start a local library of composable physics/teaching elements stored as SVG snippets plus editable anchors.

Initial library targets:

- cart
- block
- pulley
- incline plane
- spring
- friction surface
- force arrow
- velocity arrow
- acceleration arrow
- axis/grid

Each library element should define:

- source SVG snippet
- editable handles
- exposed variables
- themeable fill/stroke regions

### Force arrow component note

The current sample force diagram proved that numeric geometry variables work well for arrow sizing. Treat `force arrow` as an early reusable component in the SVG builder/editor.

Recommended editable properties:

- position
- direction
- length
- stroke color
- stroke width
- label text
- label offset

Recommended exported variables:

- `arrow_length`
- `arrow_label`

Recommended editor behavior:

- the builder/editor pane should let the user drag the arrow to set location
- the builder/editor pane should let the user rotate or flip the arrow to set direction
- the builder/editor pane should let the user edit length numerically or by dragging the endpoint
- the label should stay attached to the arrow and update automatically when length or direction changes

These can live in a local repo folder such as `assets/library/` or `meta/svg-library/` and be inserted as grouped elements into a diagram.

## Implementation sequence

### Step 1

- add bank asset browser and attach existing asset flow
- add "create new SVG" entry point in UI

### Step 2

- define internal scene model in TypeScript
- build SVG import/export helpers for the supported subset

### Step 3

- build canvas with selection, move, resize, and z-order
- add inspector for stroke, fill, and text

### Step 4

- add variable text creation and editing
- connect exported placeholders to question `svg_variables`

### Step 5

- add reusable element library with simple physics objects
- support drag/drop insertion and grouped editing

## Risks

- full SVG parsing is too broad for v1 and should stay intentionally constrained
- freeform path editing is much more complex than shape editing
- variable placeholders must round-trip exactly or existing question attachments will break
- library elements need a stable authoring format so they do not become hard-coded React components

## Immediate next tasks

- add bank metadata editing to complete the Milestone 3 gap
- add asset browser actions for attach existing asset and unused asset visibility
- add "new SVG asset" scaffolding flow
- choose the internal TypeScript scene model before starting canvas work
