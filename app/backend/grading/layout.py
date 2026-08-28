"""Pure geometry: turn an answer key into a printable response-sheet layout.

Everything here is expressed in PDF points (1/72 inch) and has no I/O. The
same SheetLayoutModel this produces is what grading/pdf.py draws from and
what a future grading/detect.py reads bubble coordinates out of -- neither
side "finds" bubbles generically, they both just consume this one frozen
geometry. See docs/grading-plan.md.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

from ..models import (
    AnswerKeyItemModel,
    AnswerKeyModel,
    BubbleCellModel,
    CaptureBoxModel,
    FiducialMarkerModel,
    SheetLayoutModel,
    SheetPageModel,
    SheetRowModel,
)

PageSize = Literal["letter", "legal", "a4", "half_letter"]

_PAGE_SIZES_PT: dict[PageSize, tuple[float, float]] = {
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
    "a4": (595.28, 841.89),
    # Half of a letter sheet, portrait. Two of these print on one page without
    # shrinking anything: the bubbles stay the size the detector expects,
    # which is what scaling a full sheet down to 2-up would have ruined.
    "half_letter": (396.0, 612.0),
}


@dataclass(frozen=True)
class _Placement:
    """One response, positioned on a page."""

    item: AnswerKeyItemModel
    x_pt: float
    row_top_y_pt: float
    height_pt: float


@dataclass(frozen=True)
class _PageGeometry:
    """Furniture positions for one page size.

    Fixed margins and a fixed name-box width work on letter-sized paper and
    collide on a half sheet -- at 396pt wide the name box ran under the QR. The
    chrome scales with the page instead, and the name box takes whatever width
    is left beside the QR.
    """

    width: float
    height: float
    margin: float
    qr_size: float
    header_height: float
    name_box_width: float
    manual_row_height: float


def _page_geometry(page_size: PageSize) -> _PageGeometry:
    width, height = _PAGE_SIZES_PT[page_size]
    compact = width < 500.0
    margin = 36.0 if compact else _MARGIN_PT
    qr_size = 54.0 if compact else _QR_BOX_SIZE_PT
    header_height = 84.0 if compact else _HEADER_HEIGHT_PT
    # Whatever is left between the left margin and the QR, never less than a
    # width a name can actually be written in.
    name_box_width = max(120.0, width - 2 * margin - qr_size - 12.0)
    # A written-response box worth writing in, without eating a short page.
    manual_row_height = 72.0 if compact else _MANUAL_ROW_HEIGHT_PT
    return _PageGeometry(
        width=width,
        height=height,
        margin=margin,
        qr_size=qr_size,
        header_height=header_height,
        name_box_width=name_box_width,
        manual_row_height=manual_row_height,
    )

_MARGIN_PT = 54.0
_FIDUCIAL_SIZE_PT = 18.0
_QR_BOX_SIZE_PT = 72.0
_NAME_BOX_HEIGHT_PT = 24.0
_HEADER_HEIGHT_PT = 120.0
_BUBBLE_ROW_HEIGHT_PT = 28.0
_MANUAL_ROW_HEIGHT_PT = 90.0
_BUBBLE_RADIUS_PT = 6.0
_BUBBLE_SPACING_PT = 20.0
_VERSION_LABEL_WIDTH_PT = 52.0
_LABEL_OFFSET_PT = 36.0
_COLUMN_GUTTER_PT = 18.0
_COLUMN_PAD_PT = 8.0
# Beyond four, the columns get too narrow to label clearly and a mis-shaded
# bubble becomes hard to trace back to its question.
_MAX_RESPONSE_COLUMNS = 4

# A numeric grid-in column stacks all ten digit bubbles vertically (like a
# scantron grid-in), so its row needs far more height than one MC bubble
# line -- not a fixed per-row height at all.
_NUMERIC_DIGIT_SPACING_PT = 14.0
_NUMERIC_HEADER_PT = 20.0
_NUMERIC_ROW_HEIGHT_PT = _NUMERIC_HEADER_PT + 10 * _NUMERIC_DIGIT_SPACING_PT + 10.0

# Numeric grid-in sign/decimal bubbles share the digit column's value space
# but are out of the 0-9 range so a detector can tell them apart at a glance.
SIGN_BUBBLE_VALUE = -1
DECIMAL_POINT_BUBBLE_VALUE = -2


@dataclass(frozen=True)
class SheetCopySpec:
    """One physical sheet-set to print: either one student (pre_id mode) or
    one anonymous blank copy."""

    sheet_id: str
    student_id: str | None = None
    printed_name: str | None = None


def build_sheet_layout(
    *,
    layout_id: str,
    answer_key: AnswerKeyModel,
    mode: Literal["blank", "pre_id"],
    page_size: PageSize,
    copies: list[SheetCopySpec],
    header_label: str | None = None,
    version_labels: list[str] | None = None,
) -> SheetLayoutModel:
    if not copies:
        raise ValueError("build_sheet_layout requires at least one copy to print")

    geometry = _page_geometry(page_size)
    page_width_pt, page_height_pt = geometry.width, geometry.height
    # The version bubble sits above the responses on the first page, so the
    # planner has to know that row of space is already spoken for.
    version_offset = _BUBBLE_ROW_HEIGHT_PT if version_labels else 0.0
    page_plans = _plan_pages(answer_key.items, geometry, version_offset)

    pages: list[SheetPageModel] = []
    for copy in copies:
        for page_index, chunk in enumerate(page_plans):
            pages.append(
                _build_page(
                    copy=copy,
                    page_index=page_index,
                    chunk=chunk,
                    mode=mode,
                    page_width_pt=page_width_pt,
                    page_height_pt=page_height_pt,
                    answer_key=answer_key,
                    version_labels=version_labels or [],
                    geometry=geometry,
                )
            )

    return SheetLayoutModel(
        id=layout_id,
        mode=mode,
        page_size=page_size,
        page_width_pt=page_width_pt,
        page_height_pt=page_height_pt,
        header_label=header_label,
        version_labels=list(version_labels or []),
        pages=pages,
    )


def _row_height(item: AnswerKeyItemModel, geometry: _PageGeometry) -> float:
    if item.row_kind == "manual_capture":
        return geometry.manual_row_height
    if item.row_kind == "numeric_response":
        return _NUMERIC_ROW_HEIGHT_PT
    return _BUBBLE_ROW_HEIGHT_PT


def _item_column_width(item: AnswerKeyItemModel) -> float:
    """How wide one response needs to be, label included.

    A written response always takes the full width; the bubble kinds are narrow
    enough that several fit side by side, which is the whole point of columns.
    """

    if item.row_kind == "multiple_choice":
        choices = max(item.choice_count or 0, 1)
        return _LABEL_OFFSET_PT + choices * _BUBBLE_SPACING_PT + _COLUMN_PAD_PT

    if item.row_kind == "numeric_response":
        digits = max(item.grid_digits or 1, 1)
        extras = (1 if item.allow_negative else 0) + (1 if item.allow_decimal else 0)
        return _LABEL_OFFSET_PT + (digits + extras) * _BUBBLE_SPACING_PT + _COLUMN_PAD_PT

    return 0.0


def _max_columns(geometry: _PageGeometry, column_width: float) -> int:
    """How many of those fit across the page, at least one."""

    if column_width <= 0:
        return 1
    usable = geometry.width - 2 * geometry.margin
    fitting = int((usable + _COLUMN_GUTTER_PT) // (column_width + _COLUMN_GUTTER_PT))
    return max(1, min(fitting, _MAX_RESPONSE_COLUMNS))


def _runs_by_kind(items: list[AnswerKeyItemModel]) -> list[list[AnswerKeyItemModel]]:
    """Consecutive items of one kind.

    A written response breaks a run, so a test that goes multiple choice, then
    an essay, then more multiple choice becomes a column block, a full-width
    box, and another column block -- rather than one column order that reads
    across the essay.
    """

    runs: list[list[AnswerKeyItemModel]] = []
    for item in items:
        if runs and runs[-1][0].row_kind == item.row_kind:
            runs[-1].append(item)
        else:
            runs.append([item])
    return runs


def _lay_out(
    items: list[AnswerKeyItemModel],
    geometry: _PageGeometry,
    first_page_top_offset: float,
    column_target: int,
) -> list[list[_Placement]]:
    """Place every response, using at most `column_target` columns per run.

    Bubble rows fill a column top to bottom before starting the next, so
    numbering reads down each column the way a scantron does.
    """

    pages: list[list[_Placement]] = []
    placements: list[_Placement] = []
    bottom = geometry.margin
    top_of_page = geometry.height - geometry.header_height
    y = top_of_page - first_page_top_offset

    def start_new_page() -> None:
        nonlocal placements, y
        pages.append(placements)
        placements = []
        y = top_of_page

    for run in _runs_by_kind(items):
        if run[0].row_kind == "manual_capture":
            for item in run:
                height = _row_height(item, geometry)
                if placements and y - height < bottom:
                    start_new_page()
                placements.append(
                    _Placement(item=item, x_pt=geometry.margin, row_top_y_pt=y, height_pt=height)
                )
                y -= height
            continue

        row_height = _row_height(run[0], geometry)
        column_width = _item_column_width(run[0])
        columns_available = min(column_target, _max_columns(geometry, column_width))
        remaining = list(run)

        while remaining:
            rows_per_column = int((y - bottom) // row_height)
            if rows_per_column <= 0:
                start_new_page()
                rows_per_column = int((y - bottom) // row_height)
                if rows_per_column <= 0:
                    # Taller than a whole page: place it and let it overflow
                    # rather than looping forever.
                    rows_per_column = 1

            capacity = rows_per_column * columns_available
            take = remaining[:capacity]
            remaining = remaining[capacity:]

            # Spread across every column allowed, balanced. Collapsing to the
            # fewest columns that merely fit would leave a short run one column
            # wide and push everything after it down the page -- which is what
            # the caller is widening the columns to avoid.
            columns = max(1, min(columns_available, len(take)))
            per_column = max(1, -(-len(take) // columns))

            for index, item in enumerate(take):
                column_index = index // per_column
                row_index = index % per_column
                placements.append(
                    _Placement(
                        item=item,
                        x_pt=geometry.margin
                        + column_index * (column_width + _COLUMN_GUTTER_PT),
                        row_top_y_pt=y - row_index * row_height,
                        height_pt=row_height,
                    )
                )

            y -= per_column * row_height
            if remaining:
                start_new_page()

    pages.append(placements)
    return pages


def _plan_pages(
    items: list[AnswerKeyItemModel], geometry: _PageGeometry, first_page_top_offset: float
) -> list[list[_Placement]]:
    """Fit the responses on as few pages as columns allow.

    Tries one column first and widens only as needed, so a short test keeps a
    single readable column and a long one gets folded into columns rather than
    spilling onto a second sheet. The column count is uniform across the sheet:
    a run that reads two-wide and another that reads three-wide on the same page
    invites shading the wrong row.
    """

    best = _lay_out(items, geometry, first_page_top_offset, 1)
    if len(best) <= 1:
        return best

    for column_target in range(2, _MAX_RESPONSE_COLUMNS + 1):
        candidate = _lay_out(items, geometry, first_page_top_offset, column_target)
        if len(candidate) < len(best):
            best = candidate
        if len(best) <= 1:
            break

    return best


def _build_page(
    *,
    copy: SheetCopySpec,
    page_index: int,
    chunk: list[_Placement],
    mode: Literal["blank", "pre_id"],
    page_width_pt: float,
    page_height_pt: float,
    answer_key: AnswerKeyModel,
    version_labels: list[str] | None = None,
    geometry: _PageGeometry,
) -> SheetPageModel:
    fiducials = _build_fiducials(page_width_pt, page_height_pt, geometry)

    qr_payload = json.dumps(
        {
            "test_id": answer_key.test_id,
            "version": answer_key.version,
            "sheet_id": copy.sheet_id,
            "page_index": page_index,
            "student_id": copy.student_id,
        },
        separators=(",", ":"),
    )
    qr_box = CaptureBoxModel(
        x_pt=page_width_pt - geometry.margin - geometry.qr_size,
        y_pt=page_height_pt - geometry.margin - geometry.qr_size,
        width_pt=geometry.qr_size,
        height_pt=geometry.qr_size,
    )

    # Always reserve the same box position regardless of mode: pdf.py draws
    # a blank line inside it for "blank" mode, or centers printed_name inside
    # it for "pre_id" mode -- one shared coordinate, two ways to render it.
    name_box = CaptureBoxModel(
        x_pt=geometry.margin,
        y_pt=page_height_pt - geometry.margin - _NAME_BOX_HEIGHT_PT,
        width_pt=geometry.name_box_width,
        height_pt=_NAME_BOX_HEIGHT_PT,
    )
    printed_name = copy.printed_name if mode == "pre_id" else None

    version_row = (
        _build_version_row(version_labels, geometry)
        if version_labels and page_index == 0
        else None
    )

    rows = [
        _build_row(
            placement.item,
            placement.row_top_y_pt,
            placement.height_pt,
            geometry,
            placement.x_pt,
        )
        for placement in chunk
    ]

    return SheetPageModel(
        page_index=page_index,
        fiducials=fiducials,
        qr_box=qr_box,
        qr_payload=qr_payload,
        name_box=name_box,
        printed_name=printed_name,
        version_row=version_row,
        rows=rows,
    )


def _build_version_row(version_labels: list[str], geometry: _PageGeometry) -> SheetRowModel:
    """One bubble per version, shaped like a multiple-choice row.

    Reusing the MC shape means the existing fill-ratio detector reads it with no
    special case -- a version mark is just another bubble at a known coordinate.
    """

    row_y = geometry.height - geometry.header_height
    label_y = row_y - _BUBBLE_ROW_HEIGHT_PT / 2
    cells = [
        BubbleCellModel(
            value=index,
            center_x_pt=geometry.margin + _VERSION_LABEL_WIDTH_PT + index * _BUBBLE_SPACING_PT,
            center_y_pt=label_y,
            radius_pt=_BUBBLE_RADIUS_PT,
        )
        for index in range(len(version_labels))
    ]
    return SheetRowModel(
        question_id="__version__",
        test_item_number=0,
        sheet_item_number=0,
        kind="multiple_choice",
        label_x_pt=geometry.margin,
        label_y_pt=label_y,
        cells=cells,
    )


def _build_fiducials(
    page_width_pt: float, page_height_pt: float, geometry: _PageGeometry
) -> list[FiducialMarkerModel]:
    inset = geometry.margin / 2
    half = _FIDUCIAL_SIZE_PT / 2
    return [
        FiducialMarkerModel(
            corner="top_left",
            shape="square",
            center_x_pt=inset + half,
            center_y_pt=page_height_pt - inset - half,
            size_pt=_FIDUCIAL_SIZE_PT,
        ),
        FiducialMarkerModel(
            corner="top_right",
            shape="square",
            center_x_pt=page_width_pt - inset - half,
            center_y_pt=page_height_pt - inset - half,
            size_pt=_FIDUCIAL_SIZE_PT,
        ),
        FiducialMarkerModel(
            corner="bottom_left",
            shape="square",
            center_x_pt=inset + half,
            center_y_pt=inset + half,
            size_pt=_FIDUCIAL_SIZE_PT,
        ),
        # Bottom-right is a circle so a rotated/upside-down scan can still be
        # told apart from a correctly-oriented one -- see docs/grading-plan.md.
        FiducialMarkerModel(
            corner="bottom_right",
            shape="circle",
            center_x_pt=page_width_pt - inset - half,
            center_y_pt=inset + half,
            size_pt=_FIDUCIAL_SIZE_PT,
        ),
    ]


def _build_row(
    item: AnswerKeyItemModel,
    row_y: float,
    row_height: float,
    geometry: _PageGeometry,
    column_x: float,
) -> SheetRowModel:
    label_x = column_x
    label_y = row_y - row_height / 2

    if item.row_kind == "multiple_choice":
        cells = _build_choice_cells(item, label_y, column_x)
        return SheetRowModel(
            question_id=item.question_id,
            test_item_number=item.test_item_number,
            sheet_item_number=item.sheet_item_number,
            kind="multiple_choice",
            label_x_pt=label_x,
            label_y_pt=label_y,
            cells=cells,
        )

    if item.row_kind == "numeric_response":
        # The digit grid stacks downward from just below the row's top, not
        # around the row's vertical midpoint like a single-line MC row.
        grid_top_y = row_y - _NUMERIC_HEADER_PT
        cells, digit_columns = _build_numeric_cells(item, grid_top_y, column_x)
        return SheetRowModel(
            question_id=item.question_id,
            test_item_number=item.test_item_number,
            sheet_item_number=item.sheet_item_number,
            kind="numeric_response",
            label_x_pt=label_x,
            label_y_pt=row_y - _NUMERIC_HEADER_PT / 2,
            cells=cells,
            digit_columns=digit_columns,
        )

    capture_box_x = label_x + _LABEL_OFFSET_PT
    capture_box = CaptureBoxModel(
        x_pt=capture_box_x,
        y_pt=row_y - row_height + 8.0,
        # Whatever is left to the right margin. A fixed width overhung the page
        # on anything narrower than letter.
        width_pt=max(120.0, geometry.width - geometry.margin - capture_box_x),
        height_pt=row_height - 16.0,
    )
    return SheetRowModel(
        question_id=item.question_id,
        test_item_number=item.test_item_number,
        sheet_item_number=item.sheet_item_number,
        kind="manual_capture",
        label_x_pt=label_x,
        label_y_pt=label_y,
        capture_box=capture_box,
    )


def _build_choice_cells(
    item: AnswerKeyItemModel, label_y: float, column_x: float
) -> list[BubbleCellModel]:
    choice_count = item.choice_count or 0
    start_x = column_x + _LABEL_OFFSET_PT
    return [
        BubbleCellModel(
            value=choice_index,
            center_x_pt=start_x + choice_index * _BUBBLE_SPACING_PT,
            center_y_pt=label_y,
            radius_pt=_BUBBLE_RADIUS_PT,
        )
        for choice_index in range(choice_count)
    ]


def _build_numeric_cells(
    item: AnswerKeyItemModel, grid_top_y: float, column_x: float
) -> tuple[list[BubbleCellModel], int]:
    """Lay out one bubble column per digit, each stacking all ten digits
    (0-9) vertically downward from grid_top_y -- like a scantron grid-in --
    plus an optional leading sign column and a decimal-point column placed
    after the first half of the digits. Deliberately simple placement -- see
    grading-plan.md's numeric_response note -- refined once detection needs
    to decode it."""

    digit_columns = max(item.grid_digits or 1, 1)
    start_x = column_x + _LABEL_OFFSET_PT
    column_x = start_x
    cells: list[BubbleCellModel] = []

    if item.allow_negative:
        cells.append(
            BubbleCellModel(
                value=SIGN_BUBBLE_VALUE,
                center_x_pt=column_x,
                center_y_pt=grid_top_y,
                radius_pt=_BUBBLE_RADIUS_PT,
            )
        )
        column_x += _BUBBLE_SPACING_PT

    # Number of digit columns that fall before the decimal point (the rest
    # fall after). Checked *before* placing a digit column, so the marker
    # lands between the two groups rather than trailing after all of them.
    decimal_before_digits = digit_columns // 2 if item.allow_decimal else None
    for digit_index in range(digit_columns):
        if decimal_before_digits is not None and digit_index == decimal_before_digits:
            cells.append(
                BubbleCellModel(
                    value=DECIMAL_POINT_BUBBLE_VALUE,
                    center_x_pt=column_x,
                    center_y_pt=grid_top_y,
                    radius_pt=_BUBBLE_RADIUS_PT,
                )
            )
            column_x += _BUBBLE_SPACING_PT

        for digit_value in range(10):
            cells.append(
                BubbleCellModel(
                    value=digit_value,
                    center_x_pt=column_x,
                    center_y_pt=grid_top_y - digit_value * _NUMERIC_DIGIT_SPACING_PT,
                    radius_pt=_BUBBLE_RADIUS_PT,
                )
            )
        column_x += _BUBBLE_SPACING_PT

    return cells, digit_columns
