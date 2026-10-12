# SVG Editor Plan

## Goal

Add a teacher-friendly SVG editor that can build and edit simple instructional diagrams directly inside Nexam without requiring an external vector tool.

The editor runs in its own Nexam window (like Import Questions), and its code lives in the self-contained `app/frontend/src/drawing/` folder. It does not depend on the rest of the app.

Goals for the drawing tool:

1. Draw clean diagrams that print well on black-and-white copiers, sized correctly the first time for where they will appear on a test.
2. Add variable controls (lengths and labels) so one diagram can serve many question versions through `svg_variables`.
3. Reuse common teaching elements from a stamp library.
4. Save plain, readable SVG into the bank's `assets/` folder, with no new file format.

## Shape tools

| Tool | Draws | SVG output | Notes |
| --- | --- | --- | --- |
| Select | — | — | Move, resize, rotate, duplicate, delete, z-order; Shift snaps to 15° |
| Line | Segment | `line` | Shift locks horizontal/vertical/45° |
| Arrow | Segment with arrowhead at the end | `g` (`line` + `polygon`) | Option for heads at the start, end, or both. Polygon heads are used instead of `marker` so print and placeholder rendering stay simple |
| Rectangle | Box | `rect` | Corner radius in the inspector; Shift for a square |
| Circle / Ellipse | Round shape | `circle` / `ellipse` | Shift for a circle |
| Triangle | Right or isosceles triangle | `polygon` | Picked from the tool's dropdown |
| Polygon | Closed shape, click points | `polygon` | Double-click or Enter to close |
| Polyline | Open path, click points | `polyline` | For ramps, graphs, outlines |
| Point | Dot | `circle` (r = 3) | For marking positions, vertices, and data |
| Text | Label | `text` | Literal text or a variable (see below) |
| Arc | Part of a circle: start, sweep (± direction), radius | `g` with a `path` | Built 2026-10-11. Can be dashed, closed as a fillable wedge, have arrowheads and a label; **Make sweep a variable** turns it into a variable arc |
| Freehand | Pen stroke | `path` | **Later** |

## Style controls and defaults

Diagrams are designed for photocopied tests, so the default palette is black, white, and grays only. A custom color picker is available, but it sits behind a "More colors…" button.

- **Stroke color**: swatches for black `#000000` (default), dark gray `#404040`, gray `#808080`, light gray `#bfbfbf`, white `#ffffff`, and none.
- **Fill color**: none (default for shapes), white `#ffffff`, very light gray `#f0f0f0`, light gray `#d9d9d9`, gray `#a6a6a6`, dark gray `#595959`, black `#000000`. Grays are spaced far enough apart that they stay distinct after copying.
- **Stroke weight**: 0.75, 1, **1.5 (default)**, 2, 3, 4 px. Answer-choice canvases default to 1.25 px.
- **Line type**:
  - Solid (default)
  - Dashed: `stroke-dasharray="6 4"`
  - Dotted: `stroke-dasharray="0.1 3"` with `stroke-linecap="round"`, so the dots come out round
  - Dash spacing scales with stroke weight, so a 3 px dashed line still reads as dashed.
- **Text**:
  - Default size: 14 px (~10.5 pt, close to the 11 pt test body text); answer-choice canvases use 12 px
  - Default color: black; system sans-serif font
  - Alignment: start, middle, end
- **Opacity**: available in the inspector but not shown in the main toolbar. Gray fills are preferred over transparency for printing.

Styles are written as explicit attributes (`stroke`, `stroke-width`, `fill`, `stroke-dasharray`), never as `style=""` strings.

## Canvas presets

Sizes come from the test print layout (`TestPrintPreview.tsx`): 96 px/in, Letter paper, 0.75 in margins (7 in of content), and a 0.35 in column gap. Assets print at `max-width: 100%`. A canvas sized to its slot therefore prints at 1:1 scale, so stroke weights and font sizes come out as drawn.

| Preset | Canvas (px) | Printed size | Use |
| --- | --- | --- | --- |
| **Two-column** (default) | 318 × 200 | 3.3 in × 2.1 in | Question diagrams on two-column tests |
| **Full width** | 672 × 280 | 7 in × 2.9 in | Single-column tests, passages, large setups |
| **Answer choice** | 134 × 96 | 1.4 in × 1 in | Diagram used as a multiple-choice option (matches `.print-choice-image`) |
| Custom | any | — | Width and height typed in |

- Height is only a starting point and can be changed freely; width is what decides the print scale.
- On A4 paper the slots are about 3% narrower, so diagrams scale down slightly. That's fine, and no separate A4 preset is needed.
- Each preset sets matching defaults (stroke weight, font size, grid spacing):
  - Grid: 10 px, with snapping on
  - Answer choice: 5 px grid
- The canvas shows a faint outline of the printed slot. If an existing asset is wider than its slot, the editor warns that it will print scaled down.

## Variable controls

Variable controls are editor objects that turn into `{{name}}` / `{{calc: …}}` placeholders on save. That way, `svg_variables` on each question can change the diagram without the teacher writing expressions by hand.

- **Variable length line/arrow**
  - Settings:
    - Anchor point
    - Direction: up/down/left/right, or any angle
    - Length variable (e.g. `arrow_length`)
    - Scale (px per unit)
    - Default value, and min/max for the preview slider
  - On save, the endpoint and arrowhead coordinates become `{{calc: …}}` expressions. For angled arrows, the cos/sin values are written in as fixed numbers (e.g. `{{calc: 160 + 0.7071 * arrow_length}}`), because the renderer only supports + − × ÷.
  - An attached label follows the arrow's tip.
  - **The angle can be a variable too** (e.g. `arrow_angle`, in degrees), measured counterclockwise from the positive x-axis: 0° points right, 90° up. See **Angle convention** below.
    - The renderer has no trig functions, so a variable-angle arrow is built pointing right and wrapped in `<g transform="rotate({{arrow_angle}} tailX tailY)">`.
    - Its label is turned back upright with `rotate({{calc: -arrow_angle}} …)` and centered past the tip, because the label can't pick a side when the direction isn't known yet.
    - `data-angle-variable` names the variable. `data-angle` remembers the last preview direction, so the file reopens pointing the same way.
    - If a question leaves the angle unset, the arrow points right (0°).
- **Variable length bar**: a rectangle whose width or height is bound to a variable, for bar charts, blocks, and energy bars.
- **Variable text**
  - A text element whose content mixes literal text with variables, e.g. `{{mass}} kg` or `θ = {{angle}}°`
  - Each variable carries a `variable_name`, `default_value`, and optional `label`.
- **Variables panel**
  - Lists every variable in the drawing, with its default value and its label.
  - A preview slider or field shows the diagram rendered with test values, using the existing `/api/assets/inspect` renderer.
- **How controls are stored**
  - Each control is written as a `<g data-nexam-control="variable-arrow" data-variable="arrow_length" data-x="160" data-y="60" data-angle="-90" data-scale="1">` group with ordinary shapes inside.
  - Renderers ignore `data-*` attributes, so files still display everywhere.
  - The editor reads them to re-open the control as one object instead of as raw expressions.
- Existing hand-written placeholder SVGs (like `sample-force-diagram.svg`) still open fine. Their placeholder attributes show as read-only values in the inspector.

### Angle convention

Added and built 2026-10-11. One part isn't automatic yet: converting an old *variable*-angle arrow shows a notice naming the variable whose question values need their sign flipped, but doesn't flip them itself.

**Angles should be measured the way students learn them:** counterclockwise from the positive x-axis (horizontal, pointing right). 0° points right, 90° up, 180° left, 270° (or −90°) down.

The editor currently uses SVG's screen convention, where y points down, so positive angles turn *clockwise* (90° points down). That's the opposite of every physics and math textbook. A question that sets `arrow_angle = 30` for "30° above the horizontal" currently draws the arrow 30° *below* it.

What changes:

- **Variable angles:**
  - The arrow's rotation becomes `rotate({{calc: -arrow_angle}} tailX tailY)`, negated because SVG rotates clockwise.
  - The label's upright correction becomes `rotate({{arrow_angle}} …)`.
  - No renderer change is needed.
- **Fixed angles use the same convention,** so the inspector shows one meaning everywhere. The baked-in coefficients become `x = X + cos θ · len` and `y = Y − sin θ · len`.
- **Everything that shows or sets an angle:**
  - The direction buttons map ↑ = 90°, → = 0°, ↓ = 270° (shown as −90° if typed that way), ← = 180°.
  - The preview slider runs 0–360°. Typed values may be negative or above 360, and are drawn the same as their equivalent angle within one turn.
  - Dragging the tip measures `atan2(−dy, dx)` and still snaps to 15°.
  - The help text reads "0° points right, 90° points up (counterclockwise)".
- **Label placement for fixed angles** (which side of the tip the label sits on) is recomputed with the corrected direction, so an arrow pointing up-right still gets its label to the upper right.

**Keeping files saved before the change correct.** A drawing's stored angles and the `svg_variables` its questions set both mean the old, clockwise thing, so silently reinterpreting them would flip arrows in existing questions. Per AGENTS.md (backward compatibility, no silent renames):

- **New drawings** mark each arrow with `data-angle-convention="ccw"`, and the editor writes the counterclockwise forms.
- **A control without the marker** keeps drawing exactly as before: clockwise `rotate({{v}} …)`, and `data-angle` read as clockwise.
- **Converting an old arrow:**
  - When one is selected, the inspector shows "This arrow uses the old clockwise angles" and a **Switch to counterclockwise** button.
  - Converting negates `data-angle` and adds the marker.
  - For a variable angle, it also offers to negate the value in every question that sets it, shown through the same "used by N questions" dialog as saving. Those questions then draw identically.
- **Fixed-angle arrows can be converted silently,** because the drawing looks identical afterwards; only the stored number changes sign.
- **Scope:** these controls were built on 2026-10-11, so in practice only test drawings use the old convention. The marker still costs little and protects anything saved in between.

**Tests:**
- `controls.test.ts`: 90° points up and 30° points up-right; tip dragging reports counterclockwise angles; and an unmarked control still renders clockwise.
- Backend renderer test: the negated `rotate({{calc: -arrow_angle}} …)` form.

### Scaling variable lengths

Added and built 2026-10-11: the scale factor (decimal or %), the length formula, Fit to a range, minimum and maximum lengths, and scale groups. Not built yet:

- a distinct look for a length held at its minimum or maximum (still to be decided)
- letting a question set the scale (deferred, as planned)
- sharing formulas within a scale group (groups share only the scale factor and limits)

Controls saved without their shapes are rebuilt from their settings when opened. Saved shapes are otherwise kept exactly as written.

**The problem:** a question's real values may be 5 N in one version and 800 N in another. Drawn at 1 px per unit, the first is an invisible stub and the second runs off the page. The drawing should turn the value into a *visible* length while staying proportional, so that when new versions are made with similar values, the arrows still compare correctly.

- **Scaling lives in the graphic, not the label.**
  - The length formula changes; the label doesn't. A label like `{{force}} N` still shows the real value ("800 N") while the arrow is drawn at, say, 80 px.
  - All of this is written into the SVG's `{{calc: …}}` expressions, so every version a question renders is scaled the same way.
- **Scale factor.** Already built as "px per unit" (`data-scale`), but it should be easier to find and use:
  - Show it as **Scale** with a choice of entry: a decimal (`0.1`) or a percent (`10%`).
  - Read it back in words, "1 N draws as 0.1 px · 800 N draws as 80 px", using the current preview value.
  - The preview slider stays in the variable's own units (newtons), not pixels.
- **Basic math on the length (an "advanced" mode).** The length can also be a short expression in the variable, using + − × ÷ and parentheses: e.g. `force / 10`, `2 * force + 10`, `(force - 100) / 5`.
  - It's validated as you type with the same parser the preview uses (`drawing/preview.ts`). An invalid formula keeps the last valid one and shows the error.
  - Nexam folds the expression into each coordinate's formula. For example, a tip at `X + cos·len` becomes `{{calc: 160 + 0.7071 * (force / 10)}}`. The renderer already supports this; no backend change is needed.
  - It's stored as `data-length-expression="force / 10"` next to `data-variable`. The plain scale factor is just the simple case `force * 0.1`.
- **Fit to a range (a helper that fills in the formula).** The teacher enters the range of values the question will use (e.g. 50–800 N) and how long the arrow should be at each end (e.g. 15–120 px).
  - **Proportional fit (the default).** Nexam picks the one scale factor that keeps the largest value within the maximum length (120 / 800 = 0.15 px per N). It warns if the smallest value would then be shorter than a visible minimum, about 6 px: "50 N would be 7.5 px".
  - **Linear fit (scale plus offset).** This maps the range exactly (`15 + (force − 50) × 0.14`), so short arrows stay visible. Because it's no longer proportional, the inspector says so plainly: "Not proportional: a force twice as large won't draw twice as long". The teacher chooses this knowingly.
- **Minimum and maximum lengths (clamping).** These keep a value outside the expected range from vanishing or running off the canvas, e.g. "never shorter than 8 px or longer than 140 px".
  - This needs `min()` and `max()` in `{{calc: …}}`, so the backend renderer (`_eval_svg_ast` in `service.py`) and the frontend preview evaluator both gain them. Existing files are unaffected, since they don't use them.
  - A clamped arrow should look different (e.g. a small break mark or a dashed end) so a capped length doesn't pass as a true one. Exactly how is still to be decided.
- **One scale for related arrows (scale groups).** A free-body diagram is only honest if the normal force and the weight use the *same* scale.
  - Controls can share a named scale, e.g. "Forces", stored as `data-scale-group`. Changing the factor on one updates every control in the group, and Fit to range considers all of their ranges together.
  - The Variables panel lists scale groups with their factor.
- **Letting a question set the scale (optional, later).** The scale factor could itself be a variable (e.g. `force_scale`), so a question with unusual values can override it in `svg_variables` without editing the drawing. The renderer already supports a product of two variables. This is off by default, because it moves a drawing decision into question data.
- **The same applies to the variable bar.** Its length uses the same Scale, Formula, Fit and Clamp settings. Bar charts and energy bars are where fixed scales break most often.

### Variable arc

Added 2026-10-11 and built the same day in `drawing/arcs.ts` (with the tool, handles and an `ArcInspector` in the editor).

Not built yet:

- formulas and min/max for a variable radius (it has a scale only)
- snapping the centre to line ends and intersections
- lining up the start with a selected line
- a menu of the drawing's angle variables (typing an existing name already links)
- ~~dashed arcs and filled sectors, which wait for phase two (sin/cos in `{{calc:}}`)~~ Built 2026-10-11:
  - `sin()` and `cos()`, in degrees, work in `{{calc:}}` in both the backend renderer and the editor's preview.
  - A variable arc that is **dashed or dotted**, or **closed as a wedge**, is drawn as a `<path>` whose points use them. It always runs counterclockwise from `rotation + min(sweep, 0)` through the middle to `rotation + max(sweep, 0)`, so each half is at most 180° and the SVG arc flags stay fixed numbers.
  - Solid open arcs keep the dashed-circle drawing, so arcs saved before are unchanged. The wedge option and line type are in the arc's Appearance section.
  - Still not done: attaching a separate text to a variable arc's end (its built-in label covers most uses).

The original plan follows.

Added 2026-10-11. A **partial circle** whose sweep, and optionally its radius, is a variable, with a label inside or outside the arc. It's for angle markers (θ between two lines or on a variable-angle force arrow), circular motion and rotation, and protractor-style figures.

**Settings** (a new control, `data-nexam-control="variable-arc"`). All angles are in degrees and measured counterclockwise from the positive x-axis, like arrows (see **Angle convention**).

- **Centre:** `data-x`, `data-y`.
- **Rotation:** `data-rotation`, *where the arc starts*. Fixed or a variable (`data-rotation-variable`).
- **Sweep:** `data-variable`, *how far the arc goes* (its angular length), and **signed**:
  - **Positive** sweeps counterclockwise from the starting point; **negative** sweeps clockwise.
  - So rotation 90° with sweep −45° starts straight up and ends at 45°, and the same arc could also be written as rotation 45°, sweep +45°.
  - The arc ends at rotation + sweep.
- **Radius:** fixed (`data-radius`) or a variable (`data-radius-variable`, using the same Scale / Formula / min-max settings as variable lengths).
- **Arrowheads:** none, at the end, at the start, or both, to show the direction of rotation.
- **Label:** see below.

**Drawing it without trig.** `{{calc:}}` has no sin/cos, so the arc is built from things SVG and the renderer can already do:

- **The arc itself:** a full `<circle>` whose stroke is cut short with `stroke-dasharray`, inside a group turned to the right starting point.
  - The dash length is the arc length, which must be positive whatever the sweep's sign: `{{calc: 0.017453 * r * max(sweep, -sweep)}}` (that is, |sweep|), followed by the circumference `{{calc: 6.2832 * r}}`.
  - A product of two variables is fine for the renderer, and `min`/`max` already exist.
  - A circle's stroke starts at 3 o'clock and runs clockwise, so the group mirrors it vertically to follow the counterclockwise convention.
  - **A negative sweep** covers the same stretch of circle as a positive sweep that starts at the far end: it runs from rotation + sweep counterclockwise back to the rotation. So the group is turned to `rotation + min(sweep, 0)`, using one drawing for both signs and no conditionals.
- **The arrowhead at the end:** placed at (r, 0) inside a group turned to `rotation + sweep`.
  - It must point *with* the sweep: counterclockwise for positive, clockwise for negative.
  - So it's flipped by the sweep's sign, `scale(1, {{calc: sweep / max(0.0001, max(sweep, -sweep))}})`, which is +1 or −1. At sweep 0 it collapses to nothing, which is fine for an arc of zero length.
  - "At start" arrowheads use the same trick at the rotation, pointing the other way.
- **The label at the middle of the arc:** placed at (r ± gap, 0) inside a group turned to `rotation + sweep / 2`, which is right for either sign, then turned back by the opposite amount about its own position so it stays upright. This is the same trick the variable-angle arrow's label uses.
- **Result:** every coordinate stays linear, and the rest is `rotate(…)`. Existing files and the backend need no change. All parts update per question, in print and in the asset thumbnails.

**Limits of that approach, and when to add trig:**

- **The arc's line can't be dashed or dotted,** because the dash pattern is what cuts the circle short. A dashed arc, a **filled sector or wedge** (pie charts), or attaching a separate text to the arc's end would need a `<path>` whose end point is computed with `sin`/`cos`.
- **The fix, if teachers want those:** add `sin()` / `cos()` in degrees to `{{calc:}}`, beside `min`/`max`, in both the backend renderer (`_eval_svg_ast`) and the editor's preview evaluator. Then let controls generate `<path>` children, which the scene model and saved files would need to support for generated shapes. This doesn't affect existing files, but it's a bigger change, so it's left for a second phase.

**Label:**

- **Inside or outside** the arc, at its middle, with a gap. Inside suits angle markers ("θ" in the corner); outside suits rotation arrows.
- **Upright** (default), or **along the arc**, rotated to the tangent at the middle.
- Any text, with `{{variables}}` and `$…$` math, e.g. `$\theta$ = {{angle}}°`.
- It uses the same placement settings and drag-to-offset as other built-in labels (see **Labels that follow shapes**). The offset is measured outward from the centre and along the tangent.

**Editing on the canvas:**

- **Handles:**
  - **Centre:** moves the arc.
  - **Radius:** drag outward.
  - **Start:** sets the rotation in 15° steps when it's fixed.
  - **End:** sets the preview sweep, positive or negative depending on which way it's dragged round from the start. Dragging past the start onto the other side flips the sign, and the inspector shows the signed value, e.g. "−45°".
- **Snapping:** dragging the centre near a line's end, an arrow's tail, or where two lines cross snaps to it.
- **Lining up the start:** when the rotation is fixed, it can be lined up with a selected line or arrow, so the arc measures the angle *from* it in either direction.

**Linking to other controls:** the sweep (or rotation) can use the **same variable** as a variable-angle arrow, e.g. `arrow_angle`. The marker then always matches the arrow's direction in every question version, with nothing to keep in sync by hand. The inspector offers the drawing's existing angle variables in a menu.

**Tests:**

- Generated dash lengths, rotations and label positions checked against the preview evaluator, for several sweeps and radii.
- Arrowhead and label positions and directions for sweeps of 0°, ±90°, ±180°, ±270° and ±359°, from several rotations.
- A negative sweep covers the same stretch of circle as the equivalent positive one.
- Upside-down handling for "along" labels.
- A backend render with question values.
- Round trip: load, then save, gives identical markup.

## Text: symbols and math

Added 2026-10-11 and built the same day in `drawing/mathText.ts` (converter) and `drawing/SymbolPicker.tsx` (Ω palette and the "Means:" KaTeX hint), with save and load in `svgIO.ts`. It works in text items and in every label field.

Differences from the plan as written:

- **Spacing follows TeX:** typed spaces in math are ignored, and relations and operators (=, +, −, ×, ·, ≤, →) get spaces automatically.
- **Search** indexes the cleaned math source as one phrase.

Not built yet: stacked fractions, and overlines for long square roots.

The original plan follows.
 This applies to every text the drawing tool writes: Text-tool labels, arrow and variable-control labels (`data-label`), and text inside stamps.

**The constraint:** SVG `<text>` can't display LaTeX. KaTeX, which Nexam uses for question previews, produces HTML. Putting that HTML inside an SVG (`<foreignObject>`) breaks when the asset is shown as an `<img>`, can't load KaTeX's fonts there, and isn't reliable in the PDF export. So math in drawings has to become **real SVG text**. That keeps it printable, searchable and inspectable, and lets `{{variables}}` work inside it.

1. **Symbol palette (first, and simplest).** A small "Ω α ∑" button next to every text and label field opens a grid of symbols. Clicking one inserts it at the cursor as a plain Unicode character:
   - Greek: θ φ α β γ λ μ ω Δ Σ Ω π ρ τ
   - Operators: × · ÷ ± ≈ ≠ ≤ ≥ ∝ √ ∞
   - Arrows: → ← ↑ ↓ ⇒
   - Units and marks: ° Ω μ ′ ″ ⊥ ∥ ∠
   - Subscript and superscript digits: ₀–₉ and ⁰–⁹, for quick `v₀` or `m/s²`

   Recently used symbols come first, remembered per viewer in local storage, which may be empty.
2. **A LaTeX subset in `$…$`.** A text or label can mix plain text, `{{variables}}` and math, e.g. `$F_{net}$ = {{force}} N` or `$\theta$ = {{angle}}°`. On save, the math parts become SVG `<tspan>`s:
   - **Sub/superscripts:** `x_1`, `v_{0}`, `v^2`, `x^{n+1}` become a smaller `<tspan>` raised or lowered with `baseline-shift`. Nested scripts are supported to one level.
   - **Symbols:** `\theta \alpha \Delta \mu \Omega \pi`, the Greek alphabet, `\cdot \times \pm \le \ge \approx \neq \propto \infty \circ \degree \to \perp \parallel` all become their Unicode characters.
   - **Accents:** `\vec{F}` becomes F with a combining right arrow (U+20D7). `\hat{x}` and `\bar{v}` work the same way. Combining marks render a little differently between fonts, so the preview shows the actual result.
   - **Fractions:** `\frac{a}{b}` is written inline as `a/b` in v1. Stacked fractions need two lines positioned with `dy` and a drawn bar; that's possible later but isn't in the first version.
   - **Roots:** `\sqrt{x}` becomes `√x`, with an overline for longer arguments if feasible.
   - **Styling:** single-letter variables are italic, as TeX does; `\text{…}` and `\mathrm{…}` are upright.
   - **Literal dollar sign:** `\$`.
   - **Anything not supported** (matrices, `\int` limits, `\begin{…}`) is left as typed, with a gentle "not supported in drawings" note.
3. **How it's stored, so it stays editable:**
   - The `<text>` keeps the typed source in `data-nexam-tex="$F_{net}$ = {{force}} N"`, and its children are the generated `<tspan>`s.
   - On load, Nexam regenerates the `<tspan>`s from `data-nexam-tex` rather than parsing them back. This matters because the current parser reads a text's `textContent` and would flatten the `<tspan>`s.
   - A plain text with no `$` stays a plain `<text>`, exactly as today.
4. **Variables inside math:** `{{name}}` placeholders are kept as literal text inside the `<tspan>`s, so the backend's text substitution fills them per question, e.g. `$v_{0}$ = {{v0}} m/s`. A placeholder *inside* a sub/superscript (`v_{{{n}}}`) works too. The `{{`/`}}` delimiters are recognized before LaTeX braces, so the two don't collide.
5. **Fonts:** math parts use a print-safe serif stack (`"STIX Two Math", "Cambria Math", "Times New Roman", serif`), and the rest of the label keeps the drawing's sans-serif. Tests are photocopied, so the choice is about legibility, not style.
6. **Editing experience:**
   - The text field shows the source.
   - The canvas shows the rendered SVG, which is the real printed result.
   - An optional KaTeX preview under the field shows what the author *meant*, so a difference ("\frac stays inline") is obvious.
7. **Later, if needed:** for complex *static* equations (no variables) that the subset can't do, convert LaTeX to SVG paths at authoring time with MathJax's SVG output. The result is self-contained and prints perfectly, but it's a new and fairly large dependency, the text is no longer editable as text, and it can't contain `{{variables}}`. Decide only if teachers hit the subset's limits.

**Tests:**
- Source to `<tspan>` conversion for each construct.
- Placeholders survive inside math.
- Round trip: load, then save, gives identical markup.
- Backend render of a math label with variables.

## Labels that follow shapes

Added 2026-10-11 and built the same day:

- **Built-in labels** on lines, arrows, variable arrows and variable bars: tail, middle or tip; upright or along the shape; above or below; a gap; and a draggable offset with Reset.
- **Attach to…** for texts, with lines, arrows, variable controls, rectangles, circles and ellipses as targets.
- **Detach on delete,** and id remapping on duplicate.
- **Everything is code in the drawing module:** `labelLayout.ts` (placement) and `anchors.ts` (attached texts).

Not built yet:

- ~~Stamps and groups as targets.~~ Built 2026-10-11: they offer centre, above, below, left and right, worked out from their placement (`transforms.ts`), so the anchors turn, grow and move with them. A group placed before centred transforms is measured and converted when a text is attached, without moving.
- ~~**Drag a text onto an anchor point to attach it.**~~ Built 2026-10-11 (`anchorSpotsNear` in `anchors.ts`):
  - Dragging a single loose text shows the anchor points within about 60 screen px of the pointer as green dots, and snaps to the nearest within about 14 px, naming it ("Tip", "Below").
  - Dropping there attaches the text, as one undo step with the move. A notice says what it attached to.
  - **Alt** drops the text loose. "Here" isn't offered by dragging, since any drop spot would be "here"; use the menu.
  - Variable arrows and bars show their points where they're drawn with the current preview values.
  - Not done: dragging an *attached* text to a different anchor point (dragging it still adjusts its offset; Detach first).
- **Attaching a separate text to a variable-*angle* arrow.** Use its built-in label instead, which is laid out inside the rotated group.

Differences from the plan as written:

- Text placement uses `dy="0.35em"` for vertical centring instead of computed baseline offsets.
- Labelled plain lines are saved as `<g data-nexam-shape="line" data-heads="none">`. Clearing the label turns them back into a plain `<line>`.

Today a variable arrow has one label, fixed just past its tip (`data-label`). Plain lines and arrows have no label at all, and a separate text item stays put when the shape it describes moves or changes length. Teachers need labels that **stay attached**: in the editor when they drag things around, and in every question version when a variable makes an arrow longer or turns it.

**One mechanism, two ways in: anchored text.** Any text item can be anchored to a point on another element. Its position is then computed from that point plus an offset, instead of being fixed.

- **Built-in labels:** a **Label** field on lines, arrows, variable arrows and variable bars. It creates and manages an anchored text for you. This is the quick path.
- **Attach any text:** select a text item and choose **Attach to…**, or drag the text near a shape until its anchor points appear and drop it on one. This covers several labels on one shape, e.g. the force name at the tip and the magnitude at the midpoint.

### Anchor points

| Element | Anchor points |
| --- | --- |
| Line, arrow, variable arrow | tail · midpoint · tip |
| Variable bar | base · middle · end (the moving end) |
| Rectangle, circle, ellipse, stamp, group | center · top · bottom · left · right · the four corners (from its bounding box) |
| Point | the point |

### "Here": a position relative to the centre

Added and built 2026-10-11.

Besides the named points, a text can be attached **Here (keeps its place)**: wherever it is now, relative to the shape's centre.

- **How it's stored:** the offset is kept in the shape's own frame, as `data-anchor-point="here"` with `data-anchor-ox` / `data-anchor-oy`.
- **Stamps and groups:** when the shape **rotates, the text orbits** its centre and stays upright, like a moon. When the shape **resizes**, the distance scales with it, so the text stays at the same relative spot. A **flip** mirrors the offset too.
- **Rectangles, circles and ellipses:** the text moves with the centre.
- **Lines and arrows:** the frame is the midpoint and the line's direction, so the text orbits as the line turns but keeps its distance as the line gets longer.
- **Not offered for variable controls,** whose geometry depends on question values. Their built-in label is the way to label them.
- **Dragging** the text updates the stored offset, converted into the shape's frame.
- **Attaching "Here"** keeps the text exactly where it was, including its alignment.

### Placement and orientation

- **Orientation:** either **Horizontal** (always upright) or **Along the shape** (rotated to follow a line or arrow).
  - Text along a shape is turned 180° when the shape points leftward, so it's never upside down.
  - With a *variable* angle, that flip can't be decided in advance, because `{{calc:}}` has no conditionals. Such labels default to Horizontal, and Along is offered with a warning that some angles will read upside down.
- **Side and distance:** for lines and arrows, the label sits **above or below** the shape (left/right for vertical ones) at a chosen distance, measured perpendicular to the shape so it keeps clear of it at any angle. At the tip, it sits just beyond the arrowhead, as today.
- **Fine-tuning by dragging:** dragging an anchored label moves it *relative to its anchor*, and the offset is saved, not an absolute position.
  - A dashed leader line to the anchor shows while dragging.
  - For Along labels, the offset turns with the shape.
  - **Reset position** in the inspector clears the offset.

### What "stays attached" means

- **In the editor:** moving, reshaping or rotating the target (dragging a tip, changing a fixed angle, changing the preview value) moves its anchored texts with it.
  - **Duplicating a shape together with its labels** links the copies to the copy.
  - **Deleting the target** leaves its texts where they are, detached, with a notice. Undo restores the link.
- **In every question version:** when the target is a variable control, the anchored text's `x`/`y` are written as `{{calc: …}}` expressions built from the same length and angle terms as the control. For example, the midpoint of a variable arrow is `tail + u · (L / 2)`, so the label follows the arrow when a question sets a different length.
  - **With a variable angle,** the label goes inside the control's `rotate(…)` group, at a position along the unrotated arrow. A Horizontal label gets the opposite rotation to stay upright, as the current tip label does.
  - This needs no backend change.

### How it's saved

- **The target** gets a stable `id`, generated by Nexam (e.g. `id="nexam-arrow-3"`) and kept on save. Today the editor's keys are never saved.
- **The text** records its link: `data-nexam-anchor="nexam-arrow-3"`, `data-anchor-point="midpoint"`, `data-anchor-orient="along"`, `data-anchor-side="above"`, `data-anchor-distance="6"`, and optional `data-anchor-dx` / `data-anchor-dy`.
  - Its `x`, `y` and `transform` are generated from those settings, the same way control shapes are regenerated, so any SVG viewer still draws it.
  - If the link can't be resolved, it's treated as an ordinary text at its saved position.
- **Variable controls inside the target's group:** when the target is a variable control, the label is written *inside* the control's `<g>`. That's needed for the variable-angle case, and it keeps the label with the control when the control is copied as a stamp.
- **Old files:** the existing `data-label` keeps working. Opening a control that has one turns it into a built-in label at the tip, the same place as before, the first time the label is edited. Opening alone doesn't change the file.
- **Plain lines** get a label by being saved as a small `<g data-nexam-shape="line">` (like arrows), but only when they actually have a label. An unlabeled line stays a plain `<line>`.

### Tests

- Anchor positions for each kind and anchor point.
- Upside-down flipping for fixed angles.
- Label `{{calc}}` expressions for variable length and variable angle, checked against the preview evaluator and a backend render.
- Moving or duplicating a target carries its labels; deleting it detaches them.
- Round trip: load, then save, gives identical markup.

## Selection, grouping, and layers

Added to the plan 2026-10-11 and built the same day, in `drawing/tree.ts`, `drawing/LayersPanel.tsx` and the editor. Not built yet:

- moving rows into or out of groups in the Layers panel (rows only restack within their own group; use Group/Ungroup instead)
- saving lock state as `data-nexam-locked`
- ~~alignment and distribution tools for a multi-selection~~ Built 2026-10-11 (`drawing/align.ts`):
  - **Align** left, centre, right, top, middle or bottom: several selected shapes line up with their combined bounds, and a single shape aligns **on the canvas**.
  - **Space ↔ / ↕** (three or more selected) leaves equal gaps and keeps the outermost shapes in place.
  - It works by drawn bounds, so it suits any kind of element. Shapes with placeholder positions stay put, with a notice.
  - Also built: pressing on a shape in a multi-selection keeps the group so it can be dragged, and releasing without a drag selects just that shape.

- **Multi-select**
  - **Drag selector (marquee):** with the Select tool, dragging on empty canvas draws a selection box. Elements the box touches are selected. Shift-drag adds them to the current selection.
  - **Shift-click** adds an element to the selection, or removes it. **⌘-click (Mac) / Ctrl-click (Windows)** does the same, so either habit works.
  - A multi-selection can be moved, nudged, duplicated, deleted, and restyled together. Style changes apply to every selected element that supports them.
  - The inspector shows the styles the selected elements have in common. Where they differ, the control shows "Mixed".
- **Grouping**
  - **Group** (⌘G / Ctrl+G) wraps the selection in `<g data-nexam-group="true">`. **Ungroup** (⇧⌘G / Shift+Ctrl+G) moves the children back out and folds any group `translate` into their coordinates where those are literal numbers.
  - Groups can be nested. Clicking selects the outermost group; double-clicking enters the group to select something inside it. Escape steps back out.
  - Stamps are inserted as groups. Variable controls are groups too, but they act as single objects. Ungrouping one turns it into plain shapes, with a warning that it will no longer update as a control.
- **Layering**
  - **Bring to Front / Bring Forward / Send Backward / Send to Back**, in the inspector and on ⇧⌘] / ⌘] / ⌘[ / ⇧⌘[ (Ctrl on Windows). These replace the current Forward/Backward buttons.
  - **Layers panel:**
    - Lists elements from top to bottom, with a readable name: kind plus text content, or the stamp/control name.
    - Click a row to select it; drag a row to reorder.
    - Groups expand to show their children.
    - Per-row hide and lock toggles affect only the editor and are never saved, except that lock may later be stored as `data-nexam-locked`.

## Scope for the first editor slice

- shape tools above, except arc and freehand
- stroke/fill/weight/line-type controls with the grayscale defaults
- the three canvas presets
- variable text and the variable length arrow (the variable length bar follows)
- stamp library: built-in stamps plus "Add from SVG files" into the My Stamps folder
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

Stamp storage (decided 2026-10-10):

- Built-in stamps ship in `app/frontend/src/drawing/stamps/` and are read-only.
- Teacher stamps ("My Stamps") live in a plain folder on disk, default `~/Documents/Nexam Stamps`, changeable in Settings. The folder is shared by every bank. Stamps are never stored inside a `.bok` or in browser storage.
- Each stamp is an `.svg` file plus an optional `.stamp.json` sidecar: `{ name, category, tags, anchor, variables }`. If the sidecar is missing, Nexam fills in the name from the filename and the variables from the stamp's placeholders.
- Inserting a stamp copies its markup into the drawing as a `<g>`, so a bank never depends on the stamp library.
- v1 management is just "Add from SVG files". Save-selection-as-stamp, categories/tags/search, and anchor/variable editing come later.

### Stamp packs: batch upload from a zip

Added to the plan 2026-10-11, revised and built the same day. It lives in `stamp_library.py` (preview and commit, `stamps.json` manifests and README fields, the `<Collection>/<Category>/` layout with sidecars, `.packs/`, `.replaced/`, zip safety checks, filing of old loose stamps) and in `StampImportReview.tsx` / `StampPanel.tsx` (review and bulk filing, collection › category groups, search over topics, tags and descriptions). Inserted stamps carry their topics into the drawing.

Differences from the plan as written:

- **A stamp's status is shown for the filing the pack suggested.** If you re-file a stamp in the review, a conflict at the new place is handled at import time by its *If already there* choice (Replace by default).
- **"Name clash" isn't a separate status.** A file with the same collection, category and file name is either a duplicate or an update.

Not built yet:

- topic chips in the Stamps panel (search covers topics)
- **Export stamp pack…**
- offering Nexam's own arrow in place of a pack's generic arrow
- the pack info panel (notes show in the review only)

**A pack is only a delivery format, not a way of organizing stamps.** Packs come out of a development process, so one logical set (for example, all the collision stamps) may arrive split across several small zips ("batch 01", "batch 02", …). The pack name therefore must never become the category. Each stamp says where it belongs, and every upload is filed into the same shared collections.

#### How stamps are organized

| Level | Example | Meaning |
| --- | --- | --- |
| **Collection** | Physics | The subject. It is the top heading in the Stamps tab. |
| **Category** | Mechanics, Circuits, Graphs | The section within a collection that the stamp is listed under. |
| **Topics** | Collisions, Momentum | Any number. Used to filter and search, not as folders. One stamp can serve several topics. |
| Tags | top-view, vector | Optional free-form search words. |

- Topic names should match the bank's question `topic` values where possible (e.g. "Linear motion"), so the drawing window can later suggest stamps for the question being illustrated.
- The pack name is kept only as **provenance** (`source_pack` in the sidecar), for answering "where did this come from?". It is never used as a heading.

#### What a pack contains

A zip of SVG files plus a description of where they go. The machine-readable manifest is preferred; a README with simple fields is the fallback a person can write by hand.

1. **`stamps.json` manifest (preferred).** This is the format the development process should produce.

   ```json
   {
     "format": "nexam-stamp-pack/1",
     "pack": "Physics stamp batch 01",
     "description": "Derived as reusable components from the supplied collision/top-view reference.",
     "defaults": { "collection": "Physics", "category": "Mechanics", "topics": ["Collisions", "Momentum"] },
     "stamps": [
       { "file": "disk.svg", "name": "Disk", "description": "outline disk/circle" },
       { "file": "disk-filled-light.svg", "name": "Disk (light fill)", "description": "lightly filled disk" },
       { "file": "vector-arrow.svg", "description": "generic editable arrow", "category": "Vectors", "topics": ["Vectors"] },
       { "file": "motion-lines.svg", "description": "generic motion streaks", "tags": ["motion"] },
       { "file": "dashed-guide.svg", "description": "dashed path/trajectory/reference line", "category": "Guides" },
       { "file": "axis-arrow.svg", "description": "simple positive-direction axis arrow", "category": "Graphs", "topics": ["Kinematics"] }
     ],
     "conventions": ["Uses currentColor for stroke/fill where practical", "No text embedded", "No external dependencies"]
   }
   ```

   - **Precedence:** a per-stamp `collection` / `category` / `topics` replaces the pack `defaults`. Topics and tags are replaced, not merged, so a stamp can opt out of the default topics.
   - **Names:** `name` is optional; without it, the name comes from the filename.
   - **Unknown fields** are kept in the sidecar and otherwise ignored, so the format can grow.

2. **README fields (fallback).** Recognized at the top of `README`, `README.txt` or `README.md`, as `Key: value` lines.

   ```text
   Physics stamp batch 01
   Collection: Physics
   Category: Mechanics
   Topics: Collisions, Momentum

   Files:
   - disk.svg: outline disk/circle
   - axis-arrow.svg: simple positive-direction axis arrow [category: Graphs; topics: Kinematics]
   ```

   - **The first line** is still read as the pack name, but only for provenance.
   - **`Collection` / `Category` / `Topics` / `Tags` lines** set the pack defaults.
   - **A `- file.svg: description` line** may end with `[key: value; key: value]` to override them for that file.
   - **Other sections** (such as "Conventions:") are kept as pack notes and not interpreted.
   - **Without either fields or a manifest,** the README is used for descriptions only, and the import review below asks where the stamps go.

#### Importing: review before filing

A zip opens an **Import stamp pack** review instead of importing straight away:

- **One row per SVG**, showing:
  - a thumbnail
  - the name
  - collection › category
  - topics
  - a status: *new*, *same as existing* (skipped), *updated version* (replaces), *name clash*, *missing from zip*, or *not a valid SVG*
- **Filing stamps the pack didn't place:** stamps with no collection or category are grouped at the top and must be filed before Import is enabled. Teachers pick from the existing collections and categories, or type new ones. Choices can be applied to all selected rows at once.
- **Existing collections are suggested first**, so a later batch lands in the same place as earlier ones instead of creating "Mechanics" and "mechanics".
  - Matching ignores case and surrounding spaces.
  - The teacher's existing spelling wins.
- **Editing before import:** any field can be changed in the review. Nothing is written until **Import** is pressed.
- **Report:** afterwards the window shows a summary ("12 added to Physics › Mechanics, 3 updated, 2 skipped as duplicates, 1 rejected") with the reasons per file.

#### Merging later batches

- **A stamp's identity** is its collection + category + file name.
  - If an upload has the same identity and identical content (by hash), it's skipped as a duplicate.
  - If the identity matches but the content differs, it's an *updated version*. By default the new file replaces the old one, and the old one is moved to `Nexam Stamps/.replaced/` rather than deleted. The teacher can choose "keep both" instead, which adds a numbered copy.
- **Drawings already made from the old version** are unaffected: stamps are copied into a drawing when inserted, so nothing in a bank changes.
- **Topics and tags from a later batch** are added to an existing identical stamp's sidecar, so a stamp re-sent in batch 02 with an extra topic gains it.

#### On disk

- Files go where they belong, not into a per-upload folder:
  - `Nexam Stamps/<Collection>/<Category>/<file>.svg`
  - plus a `<file>.stamp.json` sidecar: `name`, `collection`, `category`, `topics`, `tags`, `description`, `source_pack`, `imported_at`, and `sha256` of the SVG.
  - Folder names are the collection and category names, with characters filesystems reject replaced by `-`.
- **Pack READMEs/manifests** are copied to `Nexam Stamps/.packs/<pack name>-<date>/` for provenance. They are never read to build the library: the sidecars are the source of truth, so the folder stays meaningful if a teacher reorganizes or edits it by hand.
- **Moving files around** works: a stamp moved to another folder by hand is listed under the collection and category in its sidecar if it has one, otherwise under its folder names.

#### Safety limits on the zip

- at most 200 files and 512 KB per SVG, with a 20 MB total uncompressed size
- skip `__MACOSX/`, dotfiles, and anything below the zip's top level other than one optional wrapper folder
- reject absolute paths and `..` entries
- SVG-only content with no entity declarations, the same as single files

#### `currentColor`

Packs like this one draw with `currentColor`.

- When a stamp is inserted, its group gets `color="#000000"`, so it prints black by default.
- The stroke swatches on a selected stamp set the group's `color`, so recoloring the whole stamp is one click.
- Thumbnails get a `color` too, or `<img>` previews render with the browser's default.

#### In the Stamps tab

- Stamps are grouped by **collection › category**. A topic filter shows the topics present in the current collection.
- Built-in stamps sit in the same collections (Physics › Mechanics, etc.) and are marked as built-in rather than shown in a separate list.
- Single-file "Add SVG files…" opens the same review, so loose files get a collection and category too, instead of landing in a catch-all "My stamps".

#### Removing stamps and the pack format in the app

Added and built 2026-10-11.

- **Removing stamps:**
  - **Manage** in the Stamps panel shows a remove button on each of the teacher's own stamps, and a "Remove category" option per category.
  - Removed files, with their sidecars, are moved to `Nexam Stamps/.removed/<time>/` and never deleted. **Undo** puts them back.
  - Drawings that already use a stamp don't change, since stamps are copied into drawings when inserted.
  - Built-in stamps can't be removed. Hiding them is a possible later option.
- **Pack format in the app:** a **Pack format…** link beside "Add stamps" opens a short guide and the template files from `docs/stamp-packs/`: the manifest template, a complete example, the JSON Schema and the README fallback. Each can be copied or saved, so whoever prepares packs has the current format without needing the repo.

#### Resizing and rotating stamps

Added and built 2026-10-11 (`drawing/transforms.ts`), replacing the old Size (%) field, which scaled from the stamp's top-left corner and so made it jump.

- **One transform per stamp:** a stamp (or a group made with ⌘G) stores where it sits and how it's turned:
  - `data-x` / `data-y`: its centre on the canvas
  - `data-rotation`: degrees, clockwise on screen like other SVG rotations
  - `data-scale`
  - `data-origin-x` / `data-origin-y` / `data-width` / `data-height`: the centre and size of its own drawing
  - Its `transform` is always generated as `translate(cx cy) rotate(θ) scale(s) translate(-ox -oy)`, so moving, scaling and rotating all happen about its centre, and one setting never disturbs another.
- **Resizing:** four corner handles keep the stamp's proportions.
  - Dragging a corner keeps the **opposite corner fixed**, like slide and drawing apps.
  - With **Alt** held, it scales **about the centre**.
- **Rotating:** a handle above the stamp, joined by a short line, turns it about its centre in **15° steps**, or freely with **Shift**.
- **Inspector:** **Size (%)** and **Rotation (°)** fields keep the stamp centred, and there are ⟲ 90° / ⟳ 90° buttons.
- **Stamps placed before this change** keep their old `translate(…) scale(…)` until first resized or rotated, when they're converted to the new form from where they're drawn, so nothing moves.
- **Flip** left-right (⇋) and upside down (⇵) about the centre, stored as `data-flip-x` / `data-flip-y` and written as a negative scale. Built 2026-10-11. A mirrored older transform is read as a left-right flip.
- ~~**Later:** resizing several selected stamps together.~~ Built 2026-10-11 (`framesBox`, `scaleFramesTogether`, `boxScaleFromCorner` in `transforms.ts`):
  - When every selected item is a stamp or group, the box around them all gets four corner handles. Dragging one scales every stamp **and the spacing between them**, like one picture, keeping the opposite corner still (Alt: about the centre).
  - The inspector's **Size** section has a Size (%) field when they share a size, − / + buttons (10%), and a choice of **As one picture** or **Each in place** (each keeps its centre).

#### Search

With packs, the library will hold hundreds of stamps, so search is part of this work rather than a later extra. It covers built-in stamps and the teacher's own the same way.

- **A search box at the top of the Stamps tab** filters as you type. ⌘F / Ctrl+F focuses it while the Stamps tab is open, and Escape clears it.
- **What it matches:**
  - name
  - description
  - topics
  - tags
  - collection
  - category
  - file name
- **How it matches:**
  - Case and accents are ignored. Every word typed must match something, so "dashed line" finds *dashed-guide*.
  - Prefixes count: "coll" finds *Collisions*.
  - Simple plurals and hyphen/space differences are treated as equal: "springs" finds *Spring*, and "motion line" finds *motion-lines*.
- **Ranking** goes in this order:
  1. name matches
  2. topic or tag matches
  3. category or collection matches
  4. description matches

  Within each level, stamps the teacher used recently come first.
- **Results** show as a flat grid with the collection › category under each name, so the teacher can see where a stamp lives. Clearing the search returns to the grouped view.
- **Filters:**
  - Topic chips and a collection dropdown narrow both the search and the grouped view.
  - **The drawing's question topic** is offered as a one-click filter when the window was opened from a question. This needs the question's `topic` passed to the drawing window, which isn't done yet.
- **Speed:** the index is built in the browser from the stamp list and sidecars when the Stamps tab opens. A few hundred stamps need no server-side search. Recently used stamps are a per-viewer convenience kept in local storage, which may be empty.
- **No results** shows what was searched and offers to clear filters. If the filters are hiding matches, it says so: "3 matches in other collections".

#### Later

- When a pack includes a generic arrow (like `vector-arrow.svg`), offer to insert Nexam's own arrow or variable arrow instead, so it gets handles and variables.
- **Export stamp pack…** writes a selection (e.g. a whole collection) as a zip with a generated `stamps.json` and README, so teachers can share packs.

## Bank Assets pane: redesign

Added 2026-10-11, from screenshots of the demo bank in a 1440 × 900 main window. Built the same day:

- **`AssetBrowser.tsx`:** one component that switches between compact rows and a grid with container queries, plus the details panel, filters and sorting.
- **Thumbnails with real values,** rendered by the backend.
- **Keyboard navigation and drag-to-attach** onto the question's Assets area.
- **Copy to new drawing.**
- **Search over what's inside a drawing,** via `search_terms` from `asset_metadata.py`, cached by file time.
- **Topics and tags in the drawing tool,** saved on the SVG root.
- **Saved preview values** (`data-nexam-preview`), used as the thumbnail fallback.

Not built yet:

- the "⋯" menu (Delete, Reveal); there is no delete-asset endpoint yet
- dropping an asset onto an answer choice
- previewing with the values of the *first* question that uses an asset (thumbnails use the current question's values or the drawing's saved ones)
- copying stamp topics onto stamps, which waits for stamp packs (stamps record their category)

### What's wrong today

- **Asset cards overlap themselves:**
  - The thumbnail runs underneath the "Used by" badge, the question id and the **Edit Drawing** button.
  - Edit Drawing is clipped at the bottom of the card.
  - The thumbnail box has no fixed height, and the card body is laid over it.
- **The New Drawing button** stretches to the pane's full width and pokes out past its right edge.
- **Very little fits:** each asset takes about 220 px of height, so a docked pane shows about 1½ assets. The header spends three lines on a help sentence, a lone "2/2" count, and the search box.
- **Thumbnails** show the raw SVG, `{{placeholders}}` and all, on a checkerboard. Line art on a checkerboard is hard to read.
- **The popped-out window** uses the same single narrow column, however wide the window is. Its empty state ("Open a bank to browse assets.") has no padding and sits against the window edge.
- **Attach / Edit / usage** are buttons and badges stacked vertically in every card, and the "used by" question ids aren't links.

### Proposed design

One `AssetBrowser` component used in both places, adapting to its own width with CSS container queries, not the window's width.

- **Compact header (one row):**
  - The search box shows the count inside it ("2 of 2").
  - A filter button opens chips: *SVG*, *Images*, *Unused*, *On this question*, *Has variables*, plus a topic filter (see below).
  - A sort menu: name, recently changed, most used.
  - **New drawing** is a normal-sized primary button beside **Pop Out**.
  - The help sentence moves into the search box's placeholder: "Search names, labels, stamps, topics…"
- **Narrow (docked):** a list of compact rows, about 56 px each.
  - A 44 px thumbnail with a fixed square box, white background and `object-fit: contain`.
  - The name, then one line of small badges: `svg · 5 vars · 1 use`.
  - Two icon buttons on the right: **Attach** (or ✓ when attached to the current question) and **Edit drawing**. Delete and Reveal go in a "⋯" menu.
  - About 10 assets visible instead of 1½.
- **Wide (popped out, or a wide sidebar):** a responsive grid (`repeat(auto-fill, minmax(160px, 1fr))`) of larger thumbnails with the name under each. The same actions appear on hover or focus.
- **Detail panel:** selecting an asset (click, or Enter on a focused row) opens a details area. It docks at the bottom of the narrow list, or on the right in the wide grid, and shows:
  - a large preview
  - its variables
  - its topics
  - the "used by" questions as links that open each question in the editor
  - Attach, Edit drawing, Copy to new drawing, Delete
- **Previews show real values:** thumbnails are rendered with sample values, so they show a drawing, not braces.
  - If the asset is attached to the current question, that question's `svg_variables` are used.
  - Otherwise, the first question that uses it.
  - Otherwise, the drawing's own saved preview defaults.
  - This uses the existing batch `/api/assets/inspect-batch` renderer, with results cached by path and values.
- **Drag to attach:** drag a row or tile onto the question editor's Assets section, or onto an answer choice, to attach it.
- **Empty and loading states** are padded and centred, and they say what to do next: "Open a bank to browse its assets", "No assets match ‘pulley’. Clear search", or "No assets yet. New drawing · Upload".
- **Keyboard:** ↑/↓ move through the list, Enter opens details, A attaches, E edits.

### Asset search: find drawings by what's in them

The search currently matches only the file path, kind, the ids of questions that use it, and placeholder names (`filterAssets` in `App.tsx`). A drawing built from a *Pulley* stamp, labelled "Normal force", can't be found by searching "pulley" or "normal".

- **`GET /api/assets` returns `search_terms` per asset.** It's computed on the backend from each SVG:
  - stamp names (`data-nexam-stamp`) and, once packs have them, stamp descriptions and topics (copied onto the stamp group when it's inserted, as `data-nexam-stamp-topics`)
  - visible text (labels and text elements), with `{{…}}` placeholders removed
  - variable names
  - the asset's own topics and tags (below)
  - `<title>` / `<desc>`, if present
- **The frontend search uses `search_terms` with the same rules as stamp search:** case and accents ignored, every word must match, and partial words count. A row that matched on something other than its name shows why in a small line under the name, e.g. "stamp: Pulley".
- **Speed:** the backend caches the terms by file modification time, so a large bank isn't re-parsed on every keystroke. The list is fetched once and searched in the browser.

### Topics and tags on assets

- **Where they're stored:** in the SVG itself, on the root element: `data-nexam-topics="Forces; Newton's Laws"` and `data-nexam-tags="free-body; incline"`. This keeps them with the file (portable and inspectable) and needs no schema migration. Other SVG tools ignore these attributes.
- **Set in the drawing tool:** a **Topics & tags** field in the drawing's info section (next to the file name), with suggestions from:
  - the bank's existing question topics and subtopics, so the same spelling is reused
  - the topics of the questions that use this asset (one click: "Add Mechanics, Newton's Laws")
  - the categories and topics of stamps used in the drawing
- **Shown and filtered in the Bank Assets pane:** topics appear as chips in the asset details. The topic filter offers the bank's topics and can default to the current question's topic ("Show assets for Mechanics").
- **Not covered yet: images (PNG/JPG).** They can't carry these attributes. Tagging them would need bank-level asset metadata (e.g. `meta/assets.json`), a schema addition to propose separately if teachers need it.

## Drawing sidebar cleanup

Tabled 2026-10-11, then picked up and built the same day.

**Built: one order for every inspector** (`InspectorLayout` in `DrawingEditor.tsx`). Every selected item shows its settings in the same sections, in the same order, so a setting that different kinds of item share is always in the same place, whether it's a "special" control setting or a plain shape's:

1. **Appearance:** stroke, fill, weight, line type, text colour, size and alignment, arrowheads, and the wedge option for arcs.
2. **Label** (**Text** for a text item): the label with its symbols button and placement, the same for lines, arrows, variable arrows and bars, and arcs.
3. **Position** (named for what it holds, e.g. "Position, length and angle"): coordinates first, then size (length, radius, Size %), then rotation, angle or direction.
   - A setting a variable can drive **stays in this place** and offers *Fixed | Variable*. When it's a variable, the variable's name and a preview slider take the number's place. The Variables panel below lists the same preview values, so they can be set in either place.
   - Attaching a text to a shape is here too, since it decides where the text goes.
4. **Settings:** what is special to the item, e.g. **Length scaling** for variable arrows and bars, **Edit parts inside** for stamps and groups, **Make sweep a variable** for fixed arcs.
5. **Arrange:** align, layer order, group, duplicate and delete.

A short note on how the item is saved closes the panel. Section headings are small capitals with a rule above, so the panel scans quickly.

Ideas from the original plan still open:

- **Inspector tabs or collapsible sections** per selection, e.g. **Shape**, **Variables**, **Label** and **Style**, each remembering whether it's open per viewer. Layer and group actions move to a compact icon row at the top.
- **"Basic / Advanced" split** for variable controls: Basic shows the variable, preview value, direction and label. Formula, min/max, scale group and Fit to a range go under Advanced.
- **Compact field rows:** label and input on one line for short numbers (x, y, gap, thickness). Segmented controls get icons instead of words where the meaning is clear (↑ → ↓ ←, ⟂, along).
- **Move rarely used settings to the canvas:** e.g. direction and label position as small on-canvas toggles near the selection.
- **One scroll container** with sticky section headers, so the Layers dock and Variables stop competing for height.

## Layout and workflow notes

Feedback from trying the editor, 2026-10-11. Built the same day, except:

- **Zip files in the stamp picker** wait for stamp packs, since a zip needs the import review behind it.
- **Stamp search** matches names, categories and file names for now. Descriptions, topics and tags come with pack metadata.

Also fixed along the way: `referenced_by` in `/api/assets` now counts answer-choice images (`answer.choice_assets`) as well as attached figures, so the save warning sees every question that uses a drawing.

### Upload and selection fixes

- **Zip files in the stamp file picker.** "Add SVG files…" currently only accepts `.svg` (`accept=".svg,image/svg+xml"`), so a stamp pack can't be chosen at all. The picker should also accept `.zip` (`application/zip`), with zips going to the stamp-pack import review described above.
- **The selection box should work from the empty area around the canvas.** It currently only starts and ends inside the canvas `<svg>`.
  - A drag that starts in the gray stage area should start a selection box.
  - One that ends outside the canvas should still finish it, clamped to the canvas edge.
  - That means listening on the whole stage and capturing the pointer there. A plain click in the empty area clears the selection, like a click on blank canvas.

### Rearranged editor layout

The current split (tools *or* stamps *or* layers on the left; inspector plus canvas settings on the right) makes the teacher switch tabs for things they use together.

- **Left rail: Tools and Stamps together.** No tabs.
  - The tools are a compact block at the top: icon buttons in a grid, labels shown as tooltips, with the variable controls grouped after them.
  - The stamp library fills the rest of the rail below.
- **Stamps arranged in clickable groups.** Each collection › category is a collapsed group header, showing a count.
  - Clicking a header opens it to show small thumbnails (several per row); clicking again closes it.
  - Click a thumbnail to add it to the middle of the drawing, or drag it onto the canvas to place it, as today.
  - Search (see "Search" above) sits at the top of the stamp area and shows matching thumbnails across all groups.
- **Canvas size moves out of the right sidebar.** It's rarely changed after a drawing is started.
  - The canvas preset, width/height and grid size go into a **Canvas…** popover opened from the toolbar, next to Zoom and Grid. The current preset's name stays visible on the button, e.g. "Canvas: Two-column".
  - The right sidebar then shows only the selected element's settings, or "New shape style" when nothing is selected.
- **Layers as a lower section of the right sidebar.**
  - A collapsible **Layers** section is docked at the bottom of the right sidebar, below the inspector, with a draggable divider. It's collapsed by default and remembers its open/closed state and height per viewer (in local storage, which may be empty).
  - This keeps the layer list next to the settings of the thing selected in it.
- **The Variables list** stays in the right sidebar, between the inspector and Layers, and collapses the same way.

### Editing existing assets

- **Edit from anywhere an asset appears,** not just the Bank Assets pane. The pane's tiles already have **Edit Drawing**; the asset cards on a question in the question editor only have Remove today.
  - Add **Edit drawing** to each attached SVG asset card. That opens the drawing window for that asset, with the question it was opened from.
  - Add the same button to SVG answer-choice images.
  - The window is passed the asset path *and* the question id. That also gives the drawing window the question's `topic` for stamp suggestions, and its `svg_variables` as the starting preview values, so the drawing opens looking the way it does in that question.
- **Saving an asset that's already used.** The backend already lists the questions that use each asset (`referenced_by`), so Save can tell when other questions would change.
  - **Not used by any question, or used only by the question it was opened from:** Save works as it does now.
  - **Used by other questions:** Save opens a dialog listing them, e.g. "Used by 3 questions: q_fr_0001, q_fr_0005, q_mc_0012". The default choice depends on how the window was opened:
    - **Opened from a question:** the default is **Save as a copy for this question**. Nexam writes a new asset (`fig-1.svg`), attaches it to this question in place of the old one, and keeps the question's `svg_variables`. The other questions keep the original.
    - **Opened from Bank Assets (no question):** the default is **Save as a new asset**, which isn't attached to anything.
    - **The other option** in both cases is **Update all N questions**, which overwrites the file. That's the right choice when the revision is meant for every question, such as fixing a mistake in a shared diagram.
  - **Variable changes:** if the edit removes or renames a variable that some of those questions set in `svg_variables`, the dialog says which ones ("q_fr_0005 sets `up_force_length`, which this drawing no longer uses"). That way **Update all** can't silently break a question.
  - **After saving a copy,** the drawing window switches to the new asset, so further saves go to the copy without asking again.
- **The bank isn't saved by this.** Saving the drawing changes the open bank's working copy; the `.bok` is written when the bank is saved, as now. The drawing window keeps its "Save the bank to keep it" reminder.

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
