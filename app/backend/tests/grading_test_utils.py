"""Shared helpers for grading tests: render a layout to a raster image with
specific bubbles filled in, without ever needing a physical printer/scanner."""

from __future__ import annotations

import cv2
import numpy as np
import pymupdf

from app.backend.models import BubbleCellModel, SheetLayoutModel
from app.backend.grading.pdf import render_sheet_layout_to_pdf


def rasterize_layout_page(layout: SheetLayoutModel, page_index: int, dpi: int) -> np.ndarray:
    pdf_bytes = render_sheet_layout_to_pdf(layout)
    document = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    pixmap = document[page_index].get_pixmap(dpi=dpi)
    array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
    return cv2.cvtColor(array, cv2.COLOR_RGB2GRAY) if pixmap.n >= 3 else array[:, :, 0]


def fill_cells(
    image: np.ndarray,
    layout: SheetLayoutModel,
    cells: list[BubbleCellModel],
    dpi: int,
    darkness: int = 0,
    fill_fraction: float = 0.8,
) -> None:
    scale = dpi / 72.0
    for cell in cells:
        cx = cell.center_x_pt * scale
        cy = (layout.page_height_pt - cell.center_y_pt) * scale
        radius = max(1, int(round(cell.radius_pt * scale * fill_fraction)))
        cv2.circle(image, (int(round(cx)), int(round(cy))), radius, darkness, -1)


def png_bytes(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return bytes(encoded)


def apply_perspective_skew_and_noise(image: np.ndarray, seed: int = 0) -> np.ndarray:
    h, w = image.shape
    src = np.float32([[0, 0], [w, 0], [0, h], [w, h]])
    dst = np.float32([[20, 10], [w - 5, 25], [10, h - 15], [w - 25, h - 5]])
    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(image, matrix, (w, h), borderValue=255)
    noise = np.random.default_rng(seed).normal(0, 8, warped.shape)
    return np.clip(warped.astype(np.float32) + noise, 0, 255).astype(np.uint8)
