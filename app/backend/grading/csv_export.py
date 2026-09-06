"""CSV export of student scores, in the three shapes a teacher actually needs.

All three are *wide*: one row per student, one column per test or per standard.
That is the shape a gradebook or SIS import expects, and the shape a teacher can
read without pivoting anything.

    total        one column pair (points, %) per test, plus an overall %
    by_standard  one % column per standard -- points earned over points possible
    mastery      one column per standard, as a mastery *level* rather than a
                 percentage -- how far up the ladder the evidence reaches
                 (see grading/mastery.py)

Every export runs through the same retake resolution, so the number in the cell
is the one score that test contributes for that student -- never a first attempt
and a retake fighting over the same column.

Students with no scored sheets are still exported, with empty cells. A roster
that silently loses the absentees is worse than one that shows them as blank.
"""

from __future__ import annotations

import csv
import io

from ..models import (
    ScoreExportMethod,
    StudentPerformanceListResponseModel,
    StudentPerformanceModel,
)

_IDENTITY_HEADERS = ["Last name", "First name", "External ID", "Section", "Group"]

def build_scores_csv(
    performance: StudentPerformanceListResponseModel,
    method: ScoreExportMethod,
    standard_codes: dict[str, str] | None = None,
) -> str:
    """`standard_codes` maps standard id to the teacher-facing code, when a bank
    is open to supply them. Ids are used as-is when it isn't -- a snapshot only
    freezes ids, and an export must not require the source bank."""

    if method == "total":
        return _build_total_csv(performance)
    return _build_standard_csv(performance, method, standard_codes or {})


def suggested_filename(
    method: ScoreExportMethod, resolution: str, calculation: str | None = None
) -> str:
    """A mastery export names the calculation it used: the same students under
    Level Ladder and Difficulty Weighted produce different numbers, and two such
    files in a downloads folder are otherwise indistinguishable."""

    parts = ["scores", method.replace("_", "-"), resolution.replace("_", "-")]
    if method == "mastery" and calculation:
        parts.append(calculation.replace("_", "-"))
    return "-".join(parts) + ".csv"


def _identity_cells(student_performance: StudentPerformanceModel) -> list[str]:
    student = student_performance.student
    return [
        student.last_name,
        student.first_name,
        student.external_id or "",
        student.section or "",
        student.grouping or "",
    ]


def _build_total_csv(performance: StudentPerformanceListResponseModel) -> str:
    columns = _test_columns(performance)

    headers = list(_IDENTITY_HEADERS)
    for _, title in columns:
        headers.extend([f"{title} points", f"{title} %"])
    headers.extend(["Overall points", "Overall points possible", "Overall %"])

    rows = []
    for item in performance.items:
        resolved_by_lineage = {lineage.lineage_id: lineage.resolved for lineage in item.lineages}
        row = _identity_cells(item)
        for lineage_id, _ in columns:
            resolved = resolved_by_lineage.get(lineage_id)
            if resolved is None:
                row.extend(["", ""])
            else:
                row.extend([_number(resolved.points_earned), _number(resolved.percent_correct)])
        if item.tests_taken:
            row.extend(
                [
                    _number(item.points_earned),
                    _number(item.points_possible),
                    _number(item.percent_correct),
                ]
            )
        else:
            row.extend(["", "", ""])
        rows.append(row)

    return _write_csv(headers, rows)


def _build_standard_csv(
    performance: StudentPerformanceListResponseModel,
    method: ScoreExportMethod,
    standard_codes: dict[str, str],
) -> str:
    standard_ids = sorted(
        {entry.standard_id for item in performance.items for entry in item.by_standard}
    )
    # The mastery columns are levels, not percentages, and the two are easy to
    # confuse at a glance in a spreadsheet -- so the header says what it is out of.
    scale_max = max(
        (entry.mastery.scale_max for item in performance.items for entry in item.by_standard),
        default=0,
    )
    suffix = (
        "%"
        if method == "by_standard"
        # No invented ceiling: with no evidence there is nothing to be out of.
        else (f"mastery (of {scale_max})" if scale_max else "mastery")
    )

    headers = list(_IDENTITY_HEADERS)
    headers.extend(
        f"{standard_codes.get(standard_id) or standard_id} {suffix}"
        for standard_id in standard_ids
    )
    headers.append("Standards assessed")

    rows = []
    for item in performance.items:
        by_standard = {entry.standard_id: entry for entry in item.by_standard}
        row = _identity_cells(item)
        for standard_id in standard_ids:
            entry = by_standard.get(standard_id)
            if entry is None:
                row.append("")
            elif method == "by_standard":
                row.append(_number(entry.percent_earned))
            else:
                row.append(_number(entry.mastery.level))
        row.append(str(len(by_standard)))
        rows.append(row)

    return _write_csv(headers, rows)


def _test_columns(performance: StudentPerformanceListResponseModel) -> list[tuple[str, str]]:
    """(lineage_id, column title) for every test anyone took, in title order.

    Keyed by lineage rather than by title so two tests that happen to share a
    title -- or a retake linked in under a different one -- land in the column
    they belong to. The title is disambiguated only when it would otherwise
    collide, so the common case stays a clean, importable column name.
    """

    titles_by_lineage: dict[str, str] = {}
    for item in performance.items:
        for lineage in item.lineages:
            titles_by_lineage.setdefault(lineage.lineage_id, lineage.test_title)

    title_counts: dict[str, int] = {}
    for title in titles_by_lineage.values():
        title_counts[title] = title_counts.get(title, 0) + 1

    columns = []
    for lineage_id, title in titles_by_lineage.items():
        label = title if title_counts[title] == 1 else f"{title} ({lineage_id[:6]})"
        columns.append((lineage_id, label))
    columns.sort(key=lambda column: column[1].casefold())
    return columns


def _number(value: float) -> str:
    """Two decimals, with trailing zeros trimmed -- 87.5 rather than 87.50, and
    18 rather than 18.0. Spreadsheets read all three as numbers; teachers only
    read the first two without flinching."""

    return f"{value:.2f}".rstrip("0").rstrip(".")


def _write_csv(headers: list[str], rows: list[list[str]]) -> str:
    buffer = io.StringIO()
    # Excel needs CRLF to reliably keep rows apart on every platform, and it is
    # what RFC 4180 asks for; every other reader accepts it.
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(headers)
    writer.writerows(rows)
    return buffer.getvalue()
