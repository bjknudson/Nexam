"""Shared notion of 'has this row/sheet been resolved.'

Used to flag sheets needing review right after ingest or a correction, and
to decide what counts as still-flagged in a grade report -- one rule, so
"needs review" never means something slightly different depending on which
code path is asking.
"""

from __future__ import annotations

from ..models import DetectedRowResultModel, ScannedSheetModel


def row_is_resolved(row: DetectedRowResultModel) -> bool:
    if row.kind == "manual_capture":
        return row.manual_score is not None
    if row.override_blank:
        return True
    if row.override_choice_indices is not None or row.override_value is not None:
        return True
    return row.flag == "none"


def sheet_needs_review(sheet: ScannedSheetModel) -> bool:
    if sheet.identity_status not in ("pre_identified", "manually_resolved"):
        return True
    if sheet.fiducial_confidence is None:
        return True
    return any(not row_is_resolved(row) for row in sheet.row_results)
