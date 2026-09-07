"""Render a frozen SheetLayoutModel to PDF bytes with reportlab.

Draws exactly the coordinates the layout computed -- no layout decisions are
made here. reportlab's canvas origin is bottom-left with y increasing
upward, which is the same convention grading/layout.py used, so every
center_x_pt/center_y_pt is drawn as-is with no axis flipping.
"""

from __future__ import annotations

from io import BytesIO

import qrcode
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from ..models import CaptureBoxModel, SheetLayoutModel, SheetPageModel, SheetRowModel
from .layout import DECIMAL_POINT_BUBBLE_VALUE, SIGN_BUBBLE_VALUE

CHOICE_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def render_sheet_layout_to_pdf(layout: SheetLayoutModel) -> bytes:
    buffer = BytesIO()

    if layout.page_size == "half_letter":
        _render_half_letter_pairs(buffer, layout)
        return buffer.getvalue()

    pdf = canvas.Canvas(buffer, pagesize=(layout.page_width_pt, layout.page_height_pt))
    for page in layout.pages:
        _draw_page(pdf, page, layout.header_label, layout.version_labels)
        pdf.showPage()

    pdf.save()
    return buffer.getvalue()


def _render_half_letter_pairs(buffer: BytesIO, layout: SheetLayoutModel) -> None:
    """Two half-letter sheets side by side exactly tile one letter sheet
    turned sideways (2 x 5.5in = 11in, matching the 8.5in height), so this
    puts both on one physical page at their true size -- no dependence on a
    printer's own "pages per sheet" imposition, which is not reliable enough
    to trust with geometry the detector is frozen to (see the misregistered
    top-right corner traced in docs/grading-plan.md). Scan ingestion still
    reads one sheet per image, so the two halves have to be separated before
    scanning -- hence the cut guide between them."""

    sheet_width_pt, sheet_height_pt = layout.page_width_pt, layout.page_height_pt
    pdf = canvas.Canvas(buffer, pagesize=(sheet_width_pt, sheet_height_pt))

    pages = layout.pages
    index = 0
    while index < len(pages):
        left = pages[index]
        right = pages[index + 1] if index + 1 < len(pages) else None

        if right is None:
            # Nothing to pair with -- print this one sheet alone, at its own
            # size, rather than stranding it on an oversized page.
            pdf.setPageSize((sheet_width_pt, sheet_height_pt))
            _draw_page(pdf, left, layout.header_label, layout.version_labels)
        else:
            pdf.setPageSize((sheet_width_pt * 2, sheet_height_pt))
            _draw_page(pdf, left, layout.header_label, layout.version_labels)
            pdf.saveState()
            pdf.translate(sheet_width_pt, 0)
            _draw_page(pdf, right, layout.header_label, layout.version_labels)
            pdf.restoreState()
            _draw_cut_guide(pdf, sheet_width_pt, sheet_height_pt)

        pdf.showPage()
        index += 2

    pdf.save()


def _draw_cut_guide(pdf: canvas.Canvas, sheet_width_pt: float, sheet_height_pt: float) -> None:
    """Mark the seam between two imposed half sheets. Detection registers one
    sheet per scanned image, so an uncut pair reads as neither student's
    sheet -- the dashed line and label are the only thing standing between a
    teacher and a page that comes back unreadable.

    The label runs along the seam at mid-height, rotated rather than sitting
    flat at the top or bottom -- both corners there already carry a fiducial
    square close to the edge, and flat text wide enough to read would run
    right through them."""

    pdf.saveState()
    pdf.setDash(4, 3)
    pdf.setLineWidth(0.75)
    pdf.line(sheet_width_pt, 0, sheet_width_pt, sheet_height_pt)
    pdf.restoreState()

    pdf.saveState()
    pdf.translate(sheet_width_pt, sheet_height_pt / 2)
    pdf.rotate(90)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawCentredString(0, 3, "CUT HERE BEFORE SCANNING")
    pdf.restoreState()


def _draw_page(
    pdf: canvas.Canvas,
    page: SheetPageModel,
    header_label: str | None,
    version_labels: list[str],
) -> None:
    _draw_fiducials(pdf, page)
    _draw_qr(pdf, page)
    _draw_header(pdf, page, header_label)
    _draw_name_box(pdf, page)
    _draw_version_row(pdf, page, version_labels)
    for row in page.rows:
        _draw_row(pdf, row)


def _draw_version_row(
    pdf: canvas.Canvas, page: SheetPageModel, version_labels: list[str]
) -> None:
    row = page.version_row
    if row is None or not version_labels:
        return
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(row.label_x_pt, row.label_y_pt - 3, "Version:")
    for cell in row.cells:
        pdf.circle(cell.center_x_pt, cell.center_y_pt, cell.radius_pt, fill=0, stroke=1)
        label = version_labels[cell.value] if cell.value < len(version_labels) else str(cell.value)
        pdf.setFont("Helvetica", 6)
        pdf.drawCentredString(cell.center_x_pt, cell.center_y_pt - 2, label)


def _draw_header(pdf: canvas.Canvas, page: SheetPageModel, header_label: str | None) -> None:
    """Which test and version this sheet belongs to, on every page.

    Sits above the name box so it survives the sheet being handed out on its
    own, and repeats per page so a separated second page is still identifiable.
    """

    if not header_label:
        return
    box = page.name_box
    if box is None:
        return
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(box.x_pt, box.y_pt + box.height_pt + 14, header_label)


def _draw_fiducials(pdf: canvas.Canvas, page: SheetPageModel) -> None:
    for marker in page.fiducials:
        half = marker.size_pt / 2
        if marker.shape == "square":
            pdf.rect(
                marker.center_x_pt - half,
                marker.center_y_pt - half,
                marker.size_pt,
                marker.size_pt,
                fill=1,
                stroke=0,
            )
        else:
            pdf.circle(marker.center_x_pt, marker.center_y_pt, half, fill=1, stroke=0)


def _draw_qr(pdf: canvas.Canvas, page: SheetPageModel) -> None:
    qr_image = qrcode.make(page.qr_payload)
    pdf.drawImage(
        ImageReader(qr_image.get_image()),
        page.qr_box.x_pt,
        page.qr_box.y_pt,
        width=page.qr_box.width_pt,
        height=page.qr_box.height_pt,
    )


def _draw_name_box(pdf: canvas.Canvas, page: SheetPageModel) -> None:
    box = page.name_box
    if box is None:
        return
    if page.printed_name:
        pdf.setFont("Helvetica-Bold", 12)
        pdf.drawString(box.x_pt, box.y_pt + box.height_pt / 2 - 4, page.printed_name)
    else:
        pdf.setFont("Helvetica", 8)
        pdf.drawString(box.x_pt, box.y_pt + box.height_pt + 2, "Name:")
        pdf.line(box.x_pt, box.y_pt, box.x_pt + box.width_pt, box.y_pt)


def _draw_row(pdf: canvas.Canvas, row: SheetRowModel) -> None:
    pdf.setFont("Helvetica", 10)
    pdf.drawString(row.label_x_pt, row.label_y_pt - 3, f"{row.test_item_number}.")

    if row.kind == "multiple_choice":
        for cell in row.cells:
            pdf.circle(cell.center_x_pt, cell.center_y_pt, cell.radius_pt, fill=0, stroke=1)
            label = CHOICE_LABELS[cell.value] if cell.value < len(CHOICE_LABELS) else str(cell.value)
            pdf.setFont("Helvetica", 6)
            pdf.drawCentredString(cell.center_x_pt, cell.center_y_pt - 2, label)
    elif row.kind == "numeric_response":
        for cell in row.cells:
            pdf.circle(cell.center_x_pt, cell.center_y_pt, cell.radius_pt, fill=0, stroke=1)
            if cell.value == SIGN_BUBBLE_VALUE:
                label = "-"
            elif cell.value == DECIMAL_POINT_BUBBLE_VALUE:
                label = "."
            else:
                label = str(cell.value)
            pdf.setFont("Helvetica", 6)
            pdf.drawCentredString(cell.center_x_pt, cell.center_y_pt - 2, label)
    elif row.kind == "manual_capture" and row.capture_box is not None:
        _draw_capture_box(pdf, row.capture_box)


def _draw_capture_box(pdf: canvas.Canvas, box: CaptureBoxModel) -> None:
    pdf.rect(box.x_pt, box.y_pt, box.width_pt, box.height_pt, fill=0, stroke=1)
