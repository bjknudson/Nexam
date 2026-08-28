"""Round-trip verification for the classical-CV bubble/digit detector.

No physical printer or scanner involved: render a known-answer layout to a
PDF, rasterize it back to an image (at a DPI deliberately different from the
internal canonical 300 to prove DPI-independence), programmatically fill in
bubbles at the layout's own known coordinates, and assert detection recovers
exactly what was filled. See docs/grading-plan.md's verification section.
"""

from __future__ import annotations

from app.backend.grading.detect import decode_qr_payload, read_sheet
from app.backend.grading.layout import SheetCopySpec, build_sheet_layout
from app.backend.models import AnswerKeyItemModel, AnswerKeyModel

from app.backend.tests.grading_test_utils import (
    apply_perspective_skew_and_noise,
    fill_cells,
    rasterize_layout_page,
)

_NON_CANONICAL_DPI = 250


def _mixed_answer_key() -> AnswerKeyModel:
    return AnswerKeyModel(
        test_id="t1",
        version="A",
        total_points=2.0,
        items=[
            AnswerKeyItemModel(
                question_id="q1",
                test_item_number=1,
                sheet_item_number=1,
                row_kind="multiple_choice",
                points=1.0,
                choice_count=4,
                correct_choice_indices=[2],
            ),
            AnswerKeyItemModel(
                question_id="q2",
                test_item_number=2,
                sheet_item_number=2,
                row_kind="numeric_response",
                points=1.0,
                numeric_value=-4.5,
                numeric_tolerance=0.1,
                grid_digits=2,
                allow_decimal=True,
                allow_negative=True,
            ),
            AnswerKeyItemModel(
                question_id="q3",
                test_item_number=3,
                sheet_item_number=3,
                row_kind="manual_capture",
                points=1.0,
            ),
        ],
    )


def _layout_and_page():
    layout = build_sheet_layout(
        layout_id="layout-1",
        answer_key=_mixed_answer_key(),
        mode="blank",
        page_size="letter",
        copies=[SheetCopySpec(sheet_id="sheet-1")],
    )
    return layout, layout.pages[0]


def _numeric_fill_cells(numeric_row):
    sign_cell = next(c for c in numeric_row.cells if c.value == -1)
    decimal_cell = next(c for c in numeric_row.cells if c.value == -2)
    digit_cols = sorted({c.center_x_pt for c in numeric_row.cells if c.value not in (-1, -2)})
    first_digit = next(c for c in numeric_row.cells if c.center_x_pt == digit_cols[0] and c.value == 4)
    second_digit = next(c for c in numeric_row.cells if c.center_x_pt == digit_cols[1] and c.value == 5)
    return [sign_cell, decimal_cell, first_digit, second_digit]


def test_clean_round_trip_at_non_canonical_dpi_recovers_exact_answers():
    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, _NON_CANONICAL_DPI)
    mc_row, numeric_row, manual_row = page.rows

    fill_cells(image, layout, [mc_row.cells[2]], _NON_CANONICAL_DPI)
    fill_cells(image, layout, _numeric_fill_cells(numeric_row), _NON_CANONICAL_DPI)

    results, fiducial_confidence, _ = read_sheet(image, page, layout.page_width_pt, layout.page_height_pt)

    assert fiducial_confidence == 1.0
    mc_result, numeric_result, manual_result = results
    assert mc_result.detected_choice_indices == [2]
    assert mc_result.flag == "none"
    assert numeric_result.detected_value == -4.5
    assert numeric_result.flag == "none"
    assert manual_result.needs_manual_grade is True
    assert manual_result.kind == "manual_capture"


def test_perspective_skew_and_noise_still_recovers_answers():
    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, 300)
    mc_row = page.rows[0]
    fill_cells(image, layout, [mc_row.cells[2]], 300)

    distorted = apply_perspective_skew_and_noise(image)
    results, fiducial_confidence, _ = read_sheet(distorted, page, layout.page_width_pt, layout.page_height_pt)

    assert fiducial_confidence == 1.0
    assert results[0].detected_choice_indices == [2]
    assert results[0].flag == "none"


def test_blank_bubble_flagged_no_mark_not_silently_wrong():
    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, 300)

    results, _, _ = read_sheet(image, page, layout.page_width_pt, layout.page_height_pt)

    assert results[0].detected_choice_indices == []
    assert results[0].flag == "no_mark"


def test_two_filled_bubbles_flagged_multi_mark_not_silently_one_answer():
    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, 300)
    mc_row = page.rows[0]

    fill_cells(image, layout, [mc_row.cells[1], mc_row.cells[2]], 300)
    results, _, _ = read_sheet(image, page, layout.page_width_pt, layout.page_height_pt)

    assert set(results[0].detected_choice_indices) == {1, 2}
    assert results[0].flag == "multi_mark"


def test_faint_partial_mark_flagged_low_confidence():
    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, 300)
    mc_row = page.rows[0]

    fill_cells(image, layout, [mc_row.cells[2]], 300, darkness=90, fill_fraction=0.4)
    results, _, _ = read_sheet(image, page, layout.page_width_pt, layout.page_height_pt)

    assert results[0].flag == "low_confidence"


def test_qr_reads_correctly_alongside_filled_bubbles():
    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, 300)
    mc_row = page.rows[0]
    fill_cells(image, layout, [mc_row.cells[2]], 300)

    payload = decode_qr_payload(image)
    assert payload == {
        "test_id": "t1",
        "version": "A",
        "sheet_id": "sheet-1",
        "page_index": 0,
        "student_id": None,
    }


def test_corrupted_qr_region_is_unreadable():
    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, 300)
    scale = 300 / 72.0
    qr = page.qr_box
    x0 = int(qr.x_pt * scale)
    x1 = int((qr.x_pt + qr.width_pt) * scale)
    y0 = int((layout.page_height_pt - qr.y_pt - qr.height_pt) * scale)
    y1 = int((layout.page_height_pt - qr.y_pt) * scale)
    image[y0:y1, x0:x1] = 0

    assert decode_qr_payload(image) is None
