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

PageSize = Literal["letter", "legal", "a4"]

_PAGE_SIZES_PT: dict[PageSize, tuple[float, float]] = {
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
    "a4": (595.28, 841.89),
}

_MARGIN_PT = 54.0
_FIDUCIAL_SIZE_PT = 18.0
_QR_BOX_SIZE_PT = 72.0
_NAME_BOX_WIDTH_PT = 260.0
_NAME_BOX_HEIGHT_PT = 24.0
_HEADER_HEIGHT_PT = 120.0
_BUBBLE_ROW_HEIGHT_PT = 28.0
_MANUAL_ROW_HEIGHT_PT = 90.0
_BUBBLE_RADIUS_PT = 6.0
_BUBBLE_SPACING_PT = 20.0
_LABEL_OFFSET_PT = 36.0

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
) -> SheetLayoutModel:
    if not copies:
        raise ValueError("build_sheet_layout requires at least one copy to print")

    page_width_pt, page_height_pt = _PAGE_SIZES_PT[page_size]
    row_chunks = _paginate_rows(answer_key.items, page_height_pt)

    pages: list[SheetPageModel] = []
    for copy in copies:
        for page_index, chunk in enumerate(row_chunks):
            pages.append(
                _build_page(
                    copy=copy,
                    page_index=page_index,
                    chunk=chunk,
                    mode=mode,
                    page_width_pt=page_width_pt,
                    page_height_pt=page_height_pt,
                    answer_key=answer_key,
                )
            )

    return SheetLayoutModel(
        id=layout_id,
        mode=mode,
        page_size=page_size,
        page_width_pt=page_width_pt,
        page_height_pt=page_height_pt,
        pages=pages,
    )


def _row_height(item: AnswerKeyItemModel) -> float:
    if item.row_kind == "manual_capture":
        return _MANUAL_ROW_HEIGHT_PT
    if item.row_kind == "numeric_response":
        return _NUMERIC_ROW_HEIGHT_PT
    return _BUBBLE_ROW_HEIGHT_PT


def _paginate_rows(
    items: list[AnswerKeyItemModel], page_height_pt: float
) -> list[list[AnswerKeyItemModel]]:
    usable_height = page_height_pt - _HEADER_HEIGHT_PT - _MARGIN_PT
    chunks: list[list[AnswerKeyItemModel]] = []
    current: list[AnswerKeyItemModel] = []
    remaining = usable_height

    for item in items:
        row_height = _row_height(item)
        if current and row_height > remaining:
            chunks.append(current)
            current = []
            remaining = usable_height
        current.append(item)
        remaining -= row_height

    if current:
        chunks.append(current)
    if not chunks:
        # A test with no sheet-eligible items still gets one (empty) page.
        chunks.append([])
    return chunks


def _build_page(
    *,
    copy: SheetCopySpec,
    page_index: int,
    chunk: list[AnswerKeyItemModel],
    mode: Literal["blank", "pre_id"],
    page_width_pt: float,
    page_height_pt: float,
    answer_key: AnswerKeyModel,
) -> SheetPageModel:
    fiducials = _build_fiducials(page_width_pt, page_height_pt)

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
        x_pt=page_width_pt - _MARGIN_PT - _QR_BOX_SIZE_PT,
        y_pt=page_height_pt - _MARGIN_PT - _QR_BOX_SIZE_PT,
        width_pt=_QR_BOX_SIZE_PT,
        height_pt=_QR_BOX_SIZE_PT,
    )

    # Always reserve the same box position regardless of mode: pdf.py draws
    # a blank line inside it for "blank" mode, or centers printed_name inside
    # it for "pre_id" mode -- one shared coordinate, two ways to render it.
    name_box = CaptureBoxModel(
        x_pt=_MARGIN_PT,
        y_pt=page_height_pt - _MARGIN_PT - _NAME_BOX_HEIGHT_PT,
        width_pt=_NAME_BOX_WIDTH_PT,
        height_pt=_NAME_BOX_HEIGHT_PT,
    )
    printed_name = copy.printed_name if mode == "pre_id" else None

    rows: list[SheetRowModel] = []
    row_y = page_height_pt - _HEADER_HEIGHT_PT
    for item in chunk:
        row_height = _row_height(item)
        rows.append(_build_row(item, row_y, row_height))
        row_y -= row_height

    return SheetPageModel(
        page_index=page_index,
        fiducials=fiducials,
        qr_box=qr_box,
        qr_payload=qr_payload,
        name_box=name_box,
        printed_name=printed_name,
        rows=rows,
    )


def _build_fiducials(page_width_pt: float, page_height_pt: float) -> list[FiducialMarkerModel]:
    inset = _MARGIN_PT / 2
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


def _build_row(item: AnswerKeyItemModel, row_y: float, row_height: float) -> SheetRowModel:
    label_x = _MARGIN_PT
    label_y = row_y - row_height / 2

    if item.row_kind == "multiple_choice":
        cells = _build_choice_cells(item, label_y)
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
        cells, digit_columns = _build_numeric_cells(item, grid_top_y)
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

    capture_box = CaptureBoxModel(
        x_pt=label_x + _LABEL_OFFSET_PT,
        y_pt=row_y - row_height + 8.0,
        width_pt=400.0,
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


def _build_choice_cells(item: AnswerKeyItemModel, label_y: float) -> list[BubbleCellModel]:
    choice_count = item.choice_count or 0
    start_x = _MARGIN_PT + _LABEL_OFFSET_PT
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
    item: AnswerKeyItemModel, grid_top_y: float
) -> tuple[list[BubbleCellModel], int]:
    """Lay out one bubble column per digit, each stacking all ten digits
    (0-9) vertically downward from grid_top_y -- like a scantron grid-in --
    plus an optional leading sign column and a decimal-point column placed
    after the first half of the digits. Deliberately simple placement -- see
    grading-plan.md's numeric_response note -- refined once detection needs
    to decode it."""

    digit_columns = max(item.grid_digits or 1, 1)
    start_x = _MARGIN_PT + _LABEL_OFFSET_PT
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

    decimal_after = digit_columns // 2 if item.allow_decimal else None
    for digit_index in range(digit_columns):
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
        if decimal_after is not None and digit_index == decimal_after:
            cells.append(
                BubbleCellModel(
                    value=DECIMAL_POINT_BUBBLE_VALUE,
                    center_x_pt=column_x,
                    center_y_pt=grid_top_y,
                    radius_pt=_BUBBLE_RADIUS_PT,
                )
            )
            column_x += _BUBBLE_SPACING_PT

    return cells, digit_columns
