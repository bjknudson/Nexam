"""Classical-CV bubble/digit detection against a frozen SheetLayoutModel.

No ML: a scanned sheet is registered against known geometry via four corner
fiducials (a homography, not a generic bubble search), then every bubble's
fill state is read as a simple pixel-darkness ratio. That ratio doubles as
the confidence score the review queue uses to flag uncertain marks -- see
docs/grading-plan.md.

detect_bubble_fill and locate_fiducials are kept narrow and swappable so a
future ONNX-based detector (for noisier phone-camera capture) can replace
either without touching the rest of this module.
"""

from __future__ import annotations

import json

import cv2
import numpy as np

from ..models import BubbleCellModel, DetectedRowResultModel, SheetPageModel, SheetRowModel
from .layout import DECIMAL_POINT_BUBBLE_VALUE, SIGN_BUBBLE_VALUE

CANONICAL_DPI = 300
FILL_THRESHOLD = 0.4
LOW_CONFIDENCE_THRESHOLD = 0.5

# A fiducial's expected pixel position/size is derived from the page's own
# point-space geometry (DPI-independent), then searched for within a window
# around that expected position -- robust to unknown scan DPI and moderate
# skew, without needing to know anything about the scanner up front.
_SEARCH_WINDOW_FRACTION = 0.12
_AREA_TOLERANCE = (0.25, 4.0)
_FILL_SAMPLE_RADIUS_FRACTION = 0.7

# The sheet prints its QR in a fixed corner, so looking there before scanning
# the whole page is both quicker and more reliable: OpenCV localises a code
# far better when it fills more of the frame.
_QR_REGION_FRACTION = 0.42

# OpenCV's QR localisation is sensitive to the pixel size the finder patterns
# land on, and not monotonically so -- a code that fails at 600px wide reads
# fine at 450px and again at 900px. Roughly 1% of codes are missed by any one
# pass, so the ladder mixes thresholding with both up- and down-scaling and
# stops at the first rung that reads. Otsu at 0.9 leads because it was the
# single most reliable rung when this was measured over several hundred codes.
_QR_DECODE_ATTEMPTS = (
    (True, 0.9),
    (False, 1.0),
    (True, 1.0),
    (False, 2.0),
    (True, 0.6),
    (False, 0.75),
    (True, 1.5),
    (False, 0.5),
)

# The whole-page fallback only has to cope with odd framing, and upscaling a
# full 300dpi page is by far the most expensive thing here -- a page with no
# readable code at all would otherwise spend a second being resized. The
# corner crops above already carry the hard-to-localise codes.
_QR_WHOLE_PAGE_ATTEMPTS = (
    (True, 0.9),
    (False, 1.0),
    (True, 1.0),
    (False, 0.5),
)


def _qr_search_regions(image: np.ndarray):
    """Where a sheet's QR is worth looking for, and how hard to try there."""

    height, width = image.shape[:2]
    band = int(height * _QR_REGION_FRACTION)
    side = int(width * _QR_REGION_FRACTION)
    if band and side:
        yield image[:band, width - side :], _QR_DECODE_ATTEMPTS
        # Same corner on a page that went through the feeder upside down.
        yield image[height - band :, :side], _QR_DECODE_ATTEMPTS
    yield image, _QR_WHOLE_PAGE_ATTEMPTS


def decode_qr_payload(image: np.ndarray) -> dict | None:
    """Read the sheet's QR, trying harder before giving up.

    A sheet whose QR cannot be read has to be identified by hand, so it is
    worth several attempts first -- and this matters for clean renders as much
    as for real scans (phone photos, low-DPI scanners), because the detector's
    blind spots depend on the code's own pattern, not only on scan quality.
    """

    detector = cv2.QRCodeDetector()
    for region, attempts in _qr_search_regions(image):
        if region.size == 0:
            continue
        # Pushes a washed-out or unevenly lit code back to clean black/white,
        # which is the state the finder patterns are easiest to locate in.
        # Thresholding per region beats one pass over the whole page, whose
        # darkest content sits well away from the QR.
        _, binarized = cv2.threshold(region, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        for binarize, scale in attempts:
            candidate = binarized if binarize else region
            if scale != 1.0:
                interpolation = cv2.INTER_CUBIC if scale > 1.0 else cv2.INTER_AREA
                candidate = cv2.resize(
                    candidate, None, fx=scale, fy=scale, interpolation=interpolation
                )
            try:
                data, _, _ = detector.detectAndDecode(candidate)
            except cv2.error:
                continue
            if not data:
                continue
            payload = parse_qr_payload(data)
            if payload is not None:
                return payload
    return None


QR_PAYLOAD_PREFIX = "NZS1:"


def parse_qr_payload(data: str) -> dict | None:
    """Read either payload format.

    Sheets printed before the payload was trimmed carry a JSON record; new ones
    carry `nzs1:<sheet_id>`. Both have to keep working, because the old ones are
    paper already sitting in a filing cabinet.
    """

    text = data.strip()
    if text.upper().startswith(QR_PAYLOAD_PREFIX):
        sheet_id = text[len(QR_PAYLOAD_PREFIX) :]
        return {"sheet_id": sheet_id} if sheet_id else None

    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def detect_bubble_fill(roi_gray: np.ndarray) -> tuple[bool, float]:
    """The one primitive every row kind's decoder is built from: is this
    circular region filled in, and how confident are we in that read."""

    if roi_gray.size == 0:
        return False, 0.0

    height, width = roi_gray.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    center_y, center_x = height / 2, width / 2
    radius = min(height, width) / 2
    mask = (xx - center_x) ** 2 + (yy - center_y) ** 2 <= radius**2
    if not mask.any():
        return False, 0.0

    fill_ratio = float((roi_gray[mask] < 140).mean())
    filled = fill_ratio >= FILL_THRESHOLD
    if filled:
        confidence = (fill_ratio - FILL_THRESHOLD) / (1 - FILL_THRESHOLD) if FILL_THRESHOLD < 1 else 1.0
    else:
        confidence = (FILL_THRESHOLD - fill_ratio) / FILL_THRESHOLD if FILL_THRESHOLD > 0 else 1.0
    return filled, min(1.0, max(0.0, confidence))


def _mask_out_qr(
    binary: np.ndarray,
    page: SheetPageModel,
    page_width_pt: float,
    page_height_pt: float,
    image_w: int,
    image_h: int,
) -> None:
    box = page.qr_box
    if box is None:
        return

    # A little wider than the box itself, to cover the code's quiet zone.
    pad_pt = 6.0
    x0 = int(((box.x_pt - pad_pt) / page_width_pt) * image_w)
    x1 = int(((box.x_pt + box.width_pt + pad_pt) / page_width_pt) * image_w)
    # Page coordinates run bottom-up; image rows run top-down.
    y0 = int((1 - (box.y_pt + box.height_pt + pad_pt) / page_height_pt) * image_h)
    y1 = int((1 - (box.y_pt - pad_pt) / page_height_pt) * image_h)

    x0, x1 = max(0, x0), min(image_w, x1)
    y0, y1 = max(0, y0), min(image_h, y1)
    if x1 > x0 and y1 > y0:
        binary[y0:y1, x0:x1] = 0


def locate_fiducials(
    image_gray: np.ndarray, page: SheetPageModel, page_width_pt: float, page_height_pt: float
) -> dict[str, tuple[float, float]] | None:
    image_h, image_w = image_gray.shape[:2]
    _, binary = cv2.threshold(image_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Blank out the QR before hunting for corner markers. A QR's three finder
    # patterns are solid dark squares of exactly the kind this looks for, and
    # the sparser the code the closer they get to a fiducial's size -- close
    # enough that one can be picked as the top-right marker, which skews the
    # homography and quietly misreads most of the page rather than failing.
    _mask_out_qr(binary, page, page_width_pt, page_height_pt, image_w, image_h)

    found: dict[str, tuple[float, float]] = {}
    window = int(max(image_w, image_h) * _SEARCH_WINDOW_FRACTION)

    for marker in page.fiducials:
        expected_x = (marker.center_x_pt / page_width_pt) * image_w
        expected_y = (1 - marker.center_y_pt / page_height_pt) * image_h
        expected_area = ((marker.size_pt / page_width_pt) * image_w) ** 2

        x0, x1 = max(0, int(expected_x - window)), min(image_w, int(expected_x + window))
        y0, y1 = max(0, int(expected_y - window)), min(image_h, int(expected_y + window))
        crop = binary[y0:y1, x0:x1]
        if crop.size == 0:
            return None

        contours, _ = cv2.findContours(crop, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None

        in_band = [
            c
            for c in contours
            if expected_area * _AREA_TOLERANCE[0] <= cv2.contourArea(c) <= expected_area * _AREA_TOLERANCE[1]
        ]
        candidates = in_band or contours
        best = max(candidates, key=cv2.contourArea)

        moments = cv2.moments(best)
        if moments["m00"] == 0:
            return None
        found[marker.corner] = (x0 + moments["m10"] / moments["m00"], y0 + moments["m01"] / moments["m00"])

    return found if len(found) == len(page.fiducials) else None


def read_sheet(
    image_gray: np.ndarray,
    page: SheetPageModel,
    page_width_pt: float,
    page_height_pt: float,
    canonical_dpi: int = CANONICAL_DPI,
    version_labels: list[str] | None = None,
) -> tuple[list[DetectedRowResultModel], float | None, str | None]:
    """Register the scanned page against `page`'s frozen geometry and read
    every row. Returns (row_results, fiducial_confidence); fiducial_confidence
    is None when registration itself failed, in which case row_results is
    empty -- there is nothing to read without a resolved geometry.

    The third element is the version the student bubbled on an interchangeable
    sheet, or None when the sheet has no version row or nothing was marked."""

    fiducial_pixels = locate_fiducials(image_gray, page, page_width_pt, page_height_pt)
    if fiducial_pixels is None:
        return [], None, None

    scale = canonical_dpi / 72.0
    homography = _compute_homography(fiducial_pixels, page, page_height_pt, scale)
    canonical = _warp_canonical(image_gray, homography, page_width_pt, page_height_pt, scale)

    row_results = [_read_row(canonical, row, scale, page_height_pt) for row in page.rows]

    detected_version = None
    if page.version_row is not None and version_labels:
        # The version row is an ordinary multiple-choice row, so it reads with
        # the same detector; exactly one mark means a usable answer.
        version_result = _read_row(canonical, page.version_row, scale, page_height_pt)
        marked = version_result.detected_choice_indices
        if len(marked) == 1 and 0 <= marked[0] < len(version_labels):
            detected_version = version_labels[marked[0]]

    return row_results, 1.0, detected_version


def _compute_homography(
    fiducial_pixels: dict[str, tuple[float, float]],
    page: SheetPageModel,
    page_height_pt: float,
    scale: float,
) -> np.ndarray:
    src = np.array([fiducial_pixels[marker.corner] for marker in page.fiducials], dtype=np.float32)
    dst = np.array(
        [
            (marker.center_x_pt * scale, (page_height_pt - marker.center_y_pt) * scale)
            for marker in page.fiducials
        ],
        dtype=np.float32,
    )
    return cv2.getPerspectiveTransform(src, dst)


def _warp_canonical(
    image_gray: np.ndarray, homography: np.ndarray, page_width_pt: float, page_height_pt: float, scale: float
) -> np.ndarray:
    size = (int(round(page_width_pt * scale)), int(round(page_height_pt * scale)))
    return cv2.warpPerspective(image_gray, homography, size)


def _point_to_canonical_pixel(x_pt: float, y_pt: float, page_height_pt: float, scale: float) -> tuple[float, float]:
    return x_pt * scale, (page_height_pt - y_pt) * scale


def _extract_roi(
    canonical: np.ndarray, cell: BubbleCellModel, page_height_pt: float, scale: float
) -> np.ndarray:
    cx, cy = _point_to_canonical_pixel(cell.center_x_pt, cell.center_y_pt, page_height_pt, scale)
    # Sample a disk noticeably smaller than the printed circle itself -- a
    # blank bubble's own printed ring sits right at its nominal radius, and
    # sampling flush with it would count that ink as a partial fill.
    r = max(1, int(round(cell.radius_pt * scale * _FILL_SAMPLE_RADIUS_FRACTION)))
    x0, x1 = int(round(cx - r)), int(round(cx + r))
    y0, y1 = int(round(cy - r)), int(round(cy + r))
    x0, y0 = max(0, x0), max(0, y0)
    return canonical[y0:y1, x0:x1]


def _read_row(
    canonical: np.ndarray, row: SheetRowModel, scale: float, page_height_pt: float
) -> DetectedRowResultModel:
    if row.kind == "manual_capture":
        return DetectedRowResultModel(
            question_id=row.question_id,
            sheet_item_number=row.sheet_item_number,
            kind="manual_capture",
            needs_manual_grade=True,
        )
    if row.kind == "multiple_choice":
        return _read_choice_row(canonical, row, scale, page_height_pt)
    return _read_numeric_row(canonical, row, scale, page_height_pt)


def _read_choice_row(
    canonical: np.ndarray, row: SheetRowModel, scale: float, page_height_pt: float
) -> DetectedRowResultModel:
    reads = [
        (cell.value, *detect_bubble_fill(_extract_roi(canonical, cell, page_height_pt, scale)))
        for cell in row.cells
    ]
    indices, confidence, flag = _summarize_cells(reads)
    return DetectedRowResultModel(
        question_id=row.question_id,
        sheet_item_number=row.sheet_item_number,
        kind="multiple_choice",
        detected_choice_indices=indices,
        confidence=confidence,
        flag=flag,
    )


def _summarize_cells(reads: list[tuple[int, bool, float]]) -> tuple[list[int], float, str]:
    filled = [(value, conf) for value, is_filled, conf in reads if is_filled]
    if len(filled) == 1:
        value, conf = filled[0]
        return [value], conf, ("none" if conf >= LOW_CONFIDENCE_THRESHOLD else "low_confidence")
    if len(filled) == 0:
        conf = min((c for _, _, c in reads), default=0.0)
        return [], conf, ("no_mark" if conf >= LOW_CONFIDENCE_THRESHOLD else "low_confidence")
    conf = min(c for _, c in filled)
    return [value for value, _ in filled], conf, (
        "multi_mark" if conf >= LOW_CONFIDENCE_THRESHOLD else "low_confidence"
    )


def _read_numeric_row(
    canonical: np.ndarray, row: SheetRowModel, scale: float, page_height_pt: float
) -> DetectedRowResultModel:
    columns: dict[float, list[BubbleCellModel]] = {}
    for cell in row.cells:
        columns.setdefault(cell.center_x_pt, []).append(cell)
    ordered_columns = [columns[x] for x in sorted(columns)]

    sign_negative = False
    decimal_after_digit_count: int | None = None
    digit_values: list[int | None] = []
    confidences: list[float] = []

    for cells in ordered_columns:
        reads = [
            (cell.value, *detect_bubble_fill(_extract_roi(canonical, cell, page_height_pt, scale)))
            for cell in cells
        ]
        if len(cells) == 1:
            # A lone-bubble column is the sign or decimal-point marker, not a
            # 0-9 digit column.
            value, is_filled, conf = reads[0]
            confidences.append(conf)
            if is_filled and value == SIGN_BUBBLE_VALUE:
                sign_negative = True
            elif is_filled and value == DECIMAL_POINT_BUBBLE_VALUE:
                decimal_after_digit_count = len(digit_values)
            continue

        indices, conf, _flag = _summarize_cells(reads)
        confidences.append(conf)
        digit_values.append(indices[0] if len(indices) == 1 else None)

    confidence = min(confidences) if confidences else 0.0
    digits_text = "".join(str(v) if v is not None else "?" for v in digit_values)
    if decimal_after_digit_count is not None:
        digits_text = (
            digits_text[:decimal_after_digit_count] + "." + digits_text[decimal_after_digit_count:]
        )

    if "?" in digits_text:
        flag = "low_confidence" if any(v is not None for v in digit_values) else "no_mark"
        return DetectedRowResultModel(
            question_id=row.question_id,
            sheet_item_number=row.sheet_item_number,
            kind="numeric_response",
            detected_digits=digits_text,
            confidence=confidence,
            flag=flag,
        )

    value = float(digits_text) if digits_text and digits_text != "." else None
    if sign_negative and value is not None:
        value = -value
    flag = "none" if confidence >= LOW_CONFIDENCE_THRESHOLD else "low_confidence"
    return DetectedRowResultModel(
        question_id=row.question_id,
        sheet_item_number=row.sheet_item_number,
        kind="numeric_response",
        detected_digits=digits_text,
        detected_value=value,
        confidence=confidence,
        flag=flag,
    )
