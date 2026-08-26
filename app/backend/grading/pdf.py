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
    pdf = canvas.Canvas(buffer, pagesize=(layout.page_width_pt, layout.page_height_pt))

    for page in layout.pages:
        _draw_page(pdf, page)
        pdf.showPage()

    pdf.save()
    return buffer.getvalue()


def _draw_page(pdf: canvas.Canvas, page: SheetPageModel) -> None:
    _draw_fiducials(pdf, page)
    _draw_qr(pdf, page)
    _draw_name_box(pdf, page)
    for row in page.rows:
        _draw_row(pdf, row)


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
