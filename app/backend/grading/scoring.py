"""Score a batch's sheets against its snapshot's frozen answer key.

Pure functions: no persistence, no bank dependency. Everything needed to
grade already lives on the snapshot (answer key, standard ids) or the
gradebook's own roster -- consistent with the snapshot being self-contained.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from ..models import (
    AdministeredTestSnapshotModel,
    AnswerKeyItemModel,
    AnswerKeyModel,
    ChoiceDistributionEntryModel,
    DetectedRowResultModel,
    ExcludedSheetModel,
    GradeReportItemModel,
    GradeReportModel,
    GradeReportStandardModel,
    GradingBatchModel,
    ScannedSheetModel,
    SheetRowKind,
    StudentModel,
    StudentScoreModel,
)
from .review_state import row_is_resolved

_RESOLVED_IDENTITY_STATUSES = ("pre_identified", "manually_resolved")


@dataclass(frozen=True)
class RowScore:
    """One answered row, scored, with the key's descriptive fields alongside.

    Carrying `standard_ids` and `difficulty` here rather than making callers
    re-join to the answer key is what lets by-standard and difficulty-weighted
    aggregation be a plain sum over these.
    """

    question_id: str
    row_kind: SheetRowKind
    standard_ids: tuple[str, ...]
    difficulty: int | None
    # What the student actually marked, override applied -- empty for the two
    # row kinds that have no choices. Kept here so choice-distribution
    # reporting doesn't have to go back to the raw row for it.
    chosen_choice_indices: tuple[int, ...]
    points_earned: float
    points_possible: float
    is_full_credit: bool
    is_unscored_manual: bool
    is_flagged: bool


@dataclass(frozen=True)
class SheetScore:
    """One scanned sheet scored against one answer key.

    `points_possible` is the whole key's total, not the sum of the rows that
    happened to be read: a page that lost a row still gets graded out of the
    whole test.
    """

    sheet_id: str
    student_id: str | None
    version: str
    rows: tuple[RowScore, ...]
    points_earned: float
    points_possible: float
    flagged_count: int
    contains_unscored_manual_items: bool

    @property
    def percent_correct(self) -> float:
        return 100.0 * self.points_earned / self.points_possible if self.points_possible else 0.0


def score_sheet(sheet: ScannedSheetModel, key: AnswerKeyModel) -> SheetScore:
    """Score one sheet against one key. Rows with no matching key item -- a
    page read against the wrong printing -- are skipped rather than guessed at."""

    key_by_question = {item.question_id: item for item in key.items}
    rows: list[RowScore] = []
    for row in sheet.row_results:
        key_item = key_by_question.get(row.question_id)
        if key_item is None:
            continue
        points_earned, is_full_credit, unscored = _score_row(row, key_item)
        rows.append(
            RowScore(
                question_id=row.question_id,
                row_kind=row.kind,
                standard_ids=tuple(key_item.standard_ids),
                difficulty=key_item.difficulty,
                chosen_choice_indices=(
                    tuple(_chosen_choice_indices(row)) if row.kind == "multiple_choice" else ()
                ),
                points_earned=points_earned,
                points_possible=key_item.points,
                is_full_credit=is_full_credit,
                is_unscored_manual=unscored,
                is_flagged=not row_is_resolved(row),
            )
        )

    return SheetScore(
        sheet_id=sheet.id,
        student_id=sheet.student_id,
        version=key.version,
        rows=tuple(rows),
        points_earned=sum(row.points_earned for row in rows),
        points_possible=key.total_points,
        flagged_count=sum(1 for row in rows if row.is_flagged),
        contains_unscored_manual_items=any(row.is_unscored_manual for row in rows),
    )


def has_resolved_identity(sheet: ScannedSheetModel) -> bool:
    return sheet.identity_status in _RESOLVED_IDENTITY_STATUSES


def _chosen_choice_indices(row: DetectedRowResultModel) -> list[int]:
    """A human override wins over the detector; absent one, what was detected."""

    return (
        row.override_choice_indices
        if row.override_choice_indices is not None
        else row.detected_choice_indices
    )


class _ItemAccumulator:
    def __init__(self, key_item: AnswerKeyItemModel) -> None:
        self.key_item = key_item
        self.attempts = 0
        self.full_credit_count = 0
        self.flagged_count = 0
        self.choice_counts: dict[int, int] = defaultdict(int)

    def record(self, row: RowScore) -> None:
        self.attempts += 1
        if row.is_full_credit:
            self.full_credit_count += 1
        if row.is_flagged:
            self.flagged_count += 1
        for choice_index in row.chosen_choice_indices:
            self.choice_counts[choice_index] += 1

    def to_item_model(self) -> GradeReportItemModel:
        percent = 100.0 * self.full_credit_count / self.attempts if self.attempts else 0.0
        distribution = [
            ChoiceDistributionEntryModel(choice_index=index, count=count)
            for index, count in sorted(self.choice_counts.items())
        ]
        return GradeReportItemModel(
            question_id=self.key_item.question_id,
            sheet_item_number=self.key_item.sheet_item_number,
            row_kind=self.key_item.row_kind,
            standard_ids=self.key_item.standard_ids,
            attempts=self.attempts,
            full_credit_count=self.full_credit_count,
            percent_full_credit=percent,
            choice_distribution=distribution,
            flagged_count=self.flagged_count,
        )


def score_batch(
    batch: GradingBatchModel,
    snapshot: AdministeredTestSnapshotModel,
    students: list[StudentModel],
) -> GradeReportModel:
    students_by_id = {student.id: student for student in students}

    # On an interchangeable sheet the paper says one version and the student may
    # have taken another, so each sheet is scored against the key it names.
    keys_by_version = {snapshot.answer_key.version: snapshot.answer_key}
    for alternate in snapshot.alternate_answer_keys:
        keys_by_version[alternate.version] = alternate

    def key_for(sheet: ScannedSheetModel) -> AnswerKeyModel:
        return keys_by_version.get(sheet.detected_version or "", snapshot.answer_key)

    scoreable_sheets = [sheet for sheet in batch.sheets if _is_scoreable(sheet, batch.snapshot_id)]
    excluded_count = len(batch.sheets) - len(scoreable_sheets)

    excluded_sheets = []
    for sheet in batch.sheets:
        reasons = exclusion_reasons(sheet, batch.snapshot_id)
        if not reasons:
            continue
        student = students_by_id.get(sheet.student_id or "")
        excluded_sheets.append(
            ExcludedSheetModel(
                sheet_id=sheet.id,
                student_display_name=(
                    f"{student.first_name} {student.last_name}"
                    if student
                    else sheet.free_text_name
                ),
                reasons=reasons,
            )
        )

    accumulators = {
        item.question_id: _ItemAccumulator(item) for item in snapshot.answer_key.items
    }
    student_scores: list[StudentScoreModel] = []
    contains_unscored_manual_items = False

    for sheet in scoreable_sheets:
        sheet_score = score_sheet(sheet, key_for(sheet))
        if sheet_score.contains_unscored_manual_items:
            contains_unscored_manual_items = True
        for row_score in sheet_score.rows:
            # An interchangeable sheet scored against an alternate version asks
            # different questions, so by-item stats only accumulate the items
            # this snapshot's own key actually has.
            accumulator = accumulators.get(row_score.question_id)
            if accumulator is not None:
                accumulator.record(row_score)

        if has_resolved_identity(sheet):
            student_scores.append(
                _build_student_score(
                    sheet,
                    sheet_score.points_earned,
                    sheet_score.points_possible,
                    sheet_score.flagged_count,
                    students_by_id,
                )
            )

    by_item = [accumulator.to_item_model() for accumulator in accumulators.values()]
    by_standard = _aggregate_by_standard(accumulators.values())

    average_percent = (
        sum(score.percent_correct for score in student_scores) / len(student_scores)
        if student_scores
        else 0.0
    )
    histogram: dict[str, int] = defaultdict(int)
    for score in student_scores:
        histogram[_histogram_bucket(score.percent_correct)] += 1

    return GradeReportModel(
        batch_id=batch.id,
        snapshot_id=snapshot.id,
        test_title=snapshot.title,
        version=snapshot.version,
        generated_at=datetime.now(UTC),
        scored_sheet_count=len(scoreable_sheets),
        excluded_sheet_count=excluded_count,
        excluded_sheets=excluded_sheets,
        total_possible_points=snapshot.answer_key.total_points,
        average_percent_correct=average_percent,
        score_histogram=dict(histogram),
        by_standard=by_standard,
        by_item=by_item,
        student_scores=student_scores,
        contains_unscored_manual_items=contains_unscored_manual_items,
    )


def combine_by_standard(reports: list[GradeReportModel]) -> list[GradeReportStandardModel]:
    """Sum, not max: see CombinedGradeReportModel's docstring."""

    attempts_by_standard: dict[str, int] = defaultdict(int)
    full_credit_by_standard: dict[str, int] = defaultdict(int)
    for report in reports:
        for entry in report.by_standard:
            attempts_by_standard[entry.standard_id] += entry.attempts
            full_credit_by_standard[entry.standard_id] += entry.full_credit_count

    return [
        GradeReportStandardModel(
            standard_id=standard_id,
            attempts=attempts_by_standard[standard_id],
            full_credit_count=full_credit_by_standard[standard_id],
            percent_full_credit=(
                100.0 * full_credit_by_standard[standard_id] / attempts_by_standard[standard_id]
                if attempts_by_standard[standard_id]
                else 0.0
            ),
        )
        for standard_id in sorted(attempts_by_standard)
    ]


def _is_scoreable(sheet: ScannedSheetModel, batch_snapshot_id: str) -> bool:
    return not exclusion_reasons(sheet, batch_snapshot_id)


def exclusion_reasons(sheet: ScannedSheetModel, batch_snapshot_id: str) -> list[str]:
    """Why this sheet cannot be scored, in the teacher's terms.

    Read from the sheet's own fields rather than from `identity_status`, which
    is overwritten the moment someone resolves the identity by hand -- that
    would erase the very reason the sheet was unusable and leave a page that
    looks fixed but still cannot be scored.
    """

    reasons: list[str] = []

    if sheet.snapshot_id is None:
        reasons.append(
            "The QR code could not be read, so this page was never matched to a printed test."
        )
    elif sheet.snapshot_id != batch_snapshot_id:
        reasons.append(
            "This page is from a different printing of the test. Versions and reprints each "
            "get their own answer key, so it has to be scored with the batch it belongs to."
        )

    if sheet.fiducial_confidence is None:
        reasons.append(
            "The corner markers could not be found, so the page could not be lined up to read "
            "answers. Rescan it flat and fully in frame."
        )
    elif not sheet.row_results:
        reasons.append("No answer rows were read from this page.")

    return reasons


def _score_row(
    row: DetectedRowResultModel, key_item: AnswerKeyItemModel
) -> tuple[float, bool, bool]:
    """Returns (points_earned, is_full_credit, is_an_unscored_manual_row)."""

    if row.kind == "manual_capture":
        if row.manual_score is None:
            return 0.0, False, True
        max_score = row.manual_score_max if row.manual_score_max is not None else key_item.points
        return row.manual_score, row.manual_score >= max_score, False

    if row.kind == "multiple_choice":
        chosen = _chosen_choice_indices(row)
        correct = sorted(chosen) == sorted(key_item.correct_choice_indices or [])
        return (key_item.points if correct else 0.0), correct, False

    chosen_value = row.override_value if row.override_value is not None else row.detected_value
    correct = (
        chosen_value is not None
        and key_item.numeric_value is not None
        and abs(chosen_value - key_item.numeric_value) <= (key_item.numeric_tolerance or 0.0)
    )
    return (key_item.points if correct else 0.0), correct, False


def _build_student_score(
    sheet: ScannedSheetModel,
    points_earned: float,
    points_possible: float,
    flagged_count: int,
    students_by_id: dict[str, StudentModel],
) -> StudentScoreModel:
    display_name = None
    if sheet.student_id and sheet.student_id in students_by_id:
        student = students_by_id[sheet.student_id]
        display_name = f"{student.first_name} {student.last_name}"
    elif sheet.free_text_name:
        display_name = sheet.free_text_name

    return StudentScoreModel(
        sheet_id=sheet.id,
        student_id=sheet.student_id,
        student_display_name=display_name,
        points_earned=points_earned,
        points_possible=points_possible,
        percent_correct=(100.0 * points_earned / points_possible if points_possible else 0.0),
        flagged_answer_count=flagged_count,
    )


def _aggregate_by_standard(accumulators) -> list[GradeReportStandardModel]:
    attempts_by_standard: dict[str, int] = defaultdict(int)
    full_credit_by_standard: dict[str, int] = defaultdict(int)
    for accumulator in accumulators:
        for standard_id in accumulator.key_item.standard_ids:
            attempts_by_standard[standard_id] += accumulator.attempts
            full_credit_by_standard[standard_id] += accumulator.full_credit_count

    return [
        GradeReportStandardModel(
            standard_id=standard_id,
            attempts=attempts_by_standard[standard_id],
            full_credit_count=full_credit_by_standard[standard_id],
            percent_full_credit=(
                100.0 * full_credit_by_standard[standard_id] / attempts_by_standard[standard_id]
                if attempts_by_standard[standard_id]
                else 0.0
            ),
        )
        for standard_id in sorted(attempts_by_standard)
    ]


def _histogram_bucket(percent_correct: float) -> str:
    index = min(int(percent_correct // 10), 9)
    low = index * 10
    high = 100 if index == 9 else low + 9
    return f"{low}-{high}"
