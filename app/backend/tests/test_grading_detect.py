"""Round-trip verification for the classical-CV bubble/digit detector.

No physical printer or scanner involved: render a known-answer layout to a
PDF, rasterize it back to an image (at a DPI deliberately different from the
internal canonical 300 to prove DPI-independence), programmatically fill in
bubbles at the layout's own known coordinates, and assert detection recovers
exactly what was filled. See docs/grading-plan.md's verification section.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.backend.grading.detect import decode_qr_payload, locate_fiducials, read_sheet
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

    # The payload is just the sheet id: everything else is already in the
    # snapshot it resolves to, and every extra character made the code denser.
    assert decode_qr_payload(image) == {"sheet_id": "sheet-1"}


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


def test_old_json_payloads_still_decode():
    """Sheets printed before the payload was trimmed are paper that already
    exists, so their QR has to keep working."""

    from app.backend.grading.detect import parse_qr_payload

    old_style = (
        '{"test_id":"t1","version":"A","sheet_id":"sheet-1","page_index":0,"student_id":null}'
    )
    assert parse_qr_payload(old_style) == {
        "test_id": "t1",
        "version": "A",
        "sheet_id": "sheet-1",
        "page_index": 0,
        "student_id": None,
    }
    assert parse_qr_payload("nzs1:sheet-1") == {"sheet_id": "sheet-1"}
    assert parse_qr_payload("not a payload") is None


def test_the_qr_is_never_mistaken_for_a_corner_marker():
    """A QR's finder patterns are solid dark squares of about a fiducial's size.

    Picking one as the top-right marker skews the homography, which does not
    fail loudly -- it quietly misreads most of the answers on the page. This is
    checked across many payloads because the code pattern changes with the id.
    """

    import uuid
    from app.backend.grading.layout import SheetCopySpec, build_sheet_layout

    for _ in range(8):
        layout = build_sheet_layout(
            layout_id="L",
            answer_key=_mixed_answer_key(),
            mode="blank",
            page_size="letter",
            copies=[SheetCopySpec(sheet_id=uuid.uuid4().hex[:16])],
        )
        page = layout.pages[0]
        image = rasterize_layout_page(layout, 0, 300)

        found = locate_fiducials(image, page, layout.page_width_pt, layout.page_height_pt)
        assert found is not None

        for marker in page.fiducials:
            expected_x = (marker.center_x_pt / layout.page_width_pt) * image.shape[1]
            expected_y = (1 - marker.center_y_pt / layout.page_height_pt) * image.shape[0]
            actual_x, actual_y = found[marker.corner]
            drift = ((actual_x - expected_x) ** 2 + (actual_y - expected_y) ** 2) ** 0.5
            assert drift < 10, f"{marker.corner} drifted {drift:.0f}px -- the QR was picked up"


def test_registration_rejects_a_quadrilateral_that_is_not_the_page_rectangle():
    """Traced from a real scan: the QR mask erased the true top-right marker
    along with the QR, so the search fell back to a scan-edge shadow well
    inside its own search window. Three good corners plus one bad one still
    produces *a* homography -- cv2.getPerspectiveTransform never refuses --
    and that homography reads every row wrong while reporting full
    confidence. Registration should refuse before that happens. See
    docs/grading-plan.md."""

    from app.backend.grading.detect import _registration_is_plausible

    good = {
        "top_left": (150.0, 150.0),
        "top_right": (2400.0, 150.0),
        "bottom_left": (150.0, 3150.0),
        "bottom_right": (2400.0, 3150.0),
    }
    assert _registration_is_plausible(good, 612.0, 792.0) is True

    bad = dict(good, top_right=(1800.0, 400.0))
    assert _registration_is_plausible(bad, 612.0, 792.0) is False


def test_a_corner_locked_onto_the_wrong_feature_is_rejected_not_silently_misread():
    """Same failure as above, exercised through the real pixel pipeline: erase
    one true marker (as an over-eager QR mask would) and leave a same-sized
    decoy elsewhere within its own search window. Registration should refuse
    rather than build a homography from it."""

    layout, page = _layout_and_page()
    image = rasterize_layout_page(layout, 0, 300)
    scale = 300 / 72.0

    bottom_left = next(m for m in page.fiducials if m.corner == "bottom_left")
    cx = bottom_left.center_x_pt * scale
    cy = (layout.page_height_pt - bottom_left.center_y_pt) * scale
    half = bottom_left.size_pt * scale / 2

    # Erase the true marker and draw a decoy elsewhere in the search window --
    # same size, so it passes the area filter, but far enough off to break
    # the rectangle.
    pad = int(half * 3)
    image[int(cy - pad) : int(cy + pad), int(cx - pad) : int(cx + pad)] = 255
    decoy_x, decoy_y = 540.0, 2754.0
    cv2.rectangle(
        image,
        (int(decoy_x - half), int(decoy_y - half)),
        (int(decoy_x + half), int(decoy_y + half)),
        0,
        -1,
    )

    found = locate_fiducials(image, page, layout.page_width_pt, layout.page_height_pt)
    assert found is None

    results, fiducial_confidence, _ = read_sheet(image, page, layout.page_width_pt, layout.page_height_pt)
    assert fiducial_confidence is None
    assert results == []


# Real sheet ids whose QR OpenCV's detector fails to localise on a single pass.
# They are not corrupt or low quality -- the detector's blind spots depend on
# the code's own module pattern, so roughly one sheet id in a hundred renders
# a code that one pass misses. These three were found by sweeping random ids
# and are kept as fixtures because they reproduce exactly.
_HARD_TO_LOCALISE_SHEET_IDS = ["F54E5B8906E6", "964433F3D485", "053BB3BFEC92"]


@pytest.mark.parametrize("sheet_id", _HARD_TO_LOCALISE_SHEET_IDS)
@pytest.mark.parametrize("page_size", ["letter", "half_letter"])
def test_a_qr_the_detector_struggles_to_localise_is_still_read(sheet_id, page_size):
    layout = build_sheet_layout(
        layout_id="L",
        answer_key=_mixed_answer_key(),
        mode="blank",
        page_size=page_size,
        copies=[SheetCopySpec(sheet_id=sheet_id)],
    )
    image = rasterize_layout_page(layout, 0, 300)

    assert decode_qr_payload(image) == {"sheet_id": sheet_id}


@pytest.mark.parametrize("dpi", [200, 300, 400])
def test_a_hard_to_localise_qr_is_read_at_any_scan_resolution(dpi):
    layout = build_sheet_layout(
        layout_id="L",
        answer_key=_mixed_answer_key(),
        mode="blank",
        page_size="letter",
        copies=[SheetCopySpec(sheet_id=_HARD_TO_LOCALISE_SHEET_IDS[0])],
    )
    image = rasterize_layout_page(layout, 0, dpi)

    assert decode_qr_payload(image) == {"sheet_id": _HARD_TO_LOCALISE_SHEET_IDS[0]}


def test_a_sheet_scanned_upside_down_still_reports_its_id():
    layout = build_sheet_layout(
        layout_id="L",
        answer_key=_mixed_answer_key(),
        mode="blank",
        page_size="letter",
        copies=[SheetCopySpec(sheet_id="A1B2C3D4E5F6")],
    )
    image = rasterize_layout_page(layout, 0, 300)

    assert decode_qr_payload(np.rot90(image, 2).copy()) == {"sheet_id": "A1B2C3D4E5F6"}
