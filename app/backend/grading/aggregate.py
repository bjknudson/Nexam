"""Cross-test, per-student score aggregation.

Batch reporting answers "how did the class do on this test." This answers the
other question a teacher asks: "how is this student doing, across everything
they have taken." It is the only place in the gradebook that spans tests, so it
is also the only place that has to decide what a retake means -- see
`resolve_lineage` and docs/grading.md.

Pure functions over snapshots, batches, and the roster. Nothing here reads or
writes disk, and nothing here is persisted: totals are recomputed on every call
so a scan-review correction is reflected immediately, with no stored score that
can drift out of step with the sheets it came from.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from ..models import (
    AdministeredTestSnapshotModel,
    GradingBatchModel,
    ResolvedLineageScoreModel,
    RetakeResolution,
    StudentAttemptModel,
    StudentLineagePerformanceModel,
    StudentModel,
    StudentPerformanceListResponseModel,
    StudentPerformanceModel,
    StudentStandardScoreModel,
)
from .lineage import lineage_title, resolve_lineage_id
from .scoring import RowScore, exclusion_reasons, has_resolved_identity, score_sheet

# QuestionModel.difficulty runs 1 (easy) to 5 (hard). Keys frozen before the
# field was carried onto them have no difficulty, and so weigh the same as
# everything else rather than silently counting for nothing or for double.
_DEFAULT_DIFFICULTY = 3.0


@dataclass
class _StandardAccumulator:
    items_attempted: int = 0
    items_full_credit: int = 0
    points_earned: float = 0.0
    points_possible: float = 0.0
    weighted_credit: float = 0.0
    weight_total: float = 0.0

    def record(self, row: RowScore) -> None:
        weight = float(row.difficulty) if row.difficulty is not None else _DEFAULT_DIFFICULTY
        credit = row.points_earned / row.points_possible if row.points_possible else 0.0
        self.items_attempted += 1
        self.items_full_credit += 1 if row.is_full_credit else 0
        self.points_earned += row.points_earned
        self.points_possible += row.points_possible
        self.weighted_credit += weight * credit
        self.weight_total += weight

    def to_model(self, standard_id: str) -> StudentStandardScoreModel:
        return StudentStandardScoreModel(
            standard_id=standard_id,
            items_attempted=self.items_attempted,
            items_full_credit=self.items_full_credit,
            points_earned=self.points_earned,
            points_possible=self.points_possible,
            percent_earned=(
                100.0 * self.points_earned / self.points_possible if self.points_possible else 0.0
            ),
            mastery_estimate=(
                100.0 * self.weighted_credit / self.weight_total if self.weight_total else 0.0
            ),
            average_difficulty=(
                self.weight_total / self.items_attempted if self.items_attempted else 0.0
            ),
        )


def standards_from_rows(rows: tuple[RowScore, ...]) -> list[StudentStandardScoreModel]:
    """Roll scored rows up by standard.

    An item tagged with two standards counts in full toward both, matching how
    `scoring._aggregate_by_standard` already reports class-level standard
    numbers -- the item really is evidence about both standards, and splitting
    its points between them would understate each.
    """

    accumulators: dict[str, _StandardAccumulator] = defaultdict(_StandardAccumulator)
    for row in rows:
        for standard_id in row.standard_ids:
            accumulators[standard_id].record(row)
    return [
        accumulators[standard_id].to_model(standard_id) for standard_id in sorted(accumulators)
    ]


def build_attempts(
    snapshots: list[AdministeredTestSnapshotModel],
    batches: list[GradingBatchModel],
) -> tuple[dict[str, list[StudentAttemptModel]], int]:
    """Every scored sheet in the gradebook, grouped by student id.

    Returns the grouping and a count of scored sheets that belong to no one on
    the roster -- a page identified only by a hand-written name. Those cannot be
    aggregated across tests (there is nothing stable to join on), so they are
    counted rather than dropped silently.
    """

    snapshots_by_id = {snapshot.id: snapshot for snapshot in snapshots}
    by_student: dict[str, list[StudentAttemptModel]] = defaultdict(list)
    unlinked_sheet_count = 0

    for batch in batches:
        snapshot = snapshots_by_id.get(batch.snapshot_id)
        if snapshot is None:
            continue
        lineage_id = resolve_lineage_id(snapshot)
        keys_by_version = {snapshot.answer_key.version: snapshot.answer_key}
        for alternate in snapshot.alternate_answer_keys:
            keys_by_version[alternate.version] = alternate

        for sheet in batch.sheets:
            if exclusion_reasons(sheet, batch.snapshot_id) or not has_resolved_identity(sheet):
                continue
            if not sheet.student_id:
                unlinked_sheet_count += 1
                continue

            key = keys_by_version.get(sheet.detected_version or "", snapshot.answer_key)
            sheet_score = score_sheet(sheet, key)
            by_student[sheet.student_id].append(
                StudentAttemptModel(
                    lineage_id=lineage_id,
                    test_title=snapshot.title,
                    version=key.version,
                    snapshot_id=snapshot.id,
                    batch_id=batch.id,
                    sheet_id=sheet.id,
                    # Filled in per lineage once every attempt is known.
                    attempt_number=0,
                    printed_at=snapshot.printed_at,
                    scanned_at=batch.created_at,
                    points_earned=sheet_score.points_earned,
                    points_possible=sheet_score.points_possible,
                    percent_correct=sheet_score.percent_correct,
                    flagged_answer_count=sheet_score.flagged_count,
                    contains_unscored_manual_items=sheet_score.contains_unscored_manual_items,
                    by_standard=standards_from_rows(sheet_score.rows),
                )
            )

    return by_student, unlinked_sheet_count


def resolve_lineage(
    attempts: list[StudentAttemptModel], resolution: RetakeResolution
) -> ResolvedLineageScoreModel:
    """Collapse one student's attempts at one test down to the score that counts.

    `most_recent` and `highest` pick a real attempt and carry its numbers and
    its standard breakdown through unchanged, so the exported number is one the
    teacher can point at a specific paper for. `average` synthesises a score
    instead: the mean of the attempt percentages, which is what a teacher means
    by averaging retakes even when the two papers were out of different totals.
    """

    if not attempts:
        raise ValueError("resolve_lineage needs at least one attempt")

    ordered = sorted(attempts, key=_attempt_order)
    # Callers that built the list themselves may not have numbered it yet;
    # source_attempt_numbers is only meaningful once they are numbered.
    for number, attempt in enumerate(ordered, start=1):
        if not attempt.attempt_number:
            attempt.attempt_number = number

    if resolution == "highest":
        chosen = max(ordered, key=lambda attempt: (attempt.percent_correct, _attempt_order(attempt)))
        return _from_single_attempt(chosen, resolution, len(ordered))
    if resolution == "most_recent" or len(ordered) == 1:
        return _from_single_attempt(ordered[-1], resolution, len(ordered))

    return _averaged(ordered)


def build_student_performance(
    students: list[StudentModel],
    snapshots: list[AdministeredTestSnapshotModel],
    batches: list[GradingBatchModel],
    resolution: RetakeResolution = "most_recent",
) -> StudentPerformanceListResponseModel:
    attempts_by_student, unlinked_sheet_count = build_attempts(snapshots, batches)
    snapshots_by_lineage: dict[str, list[AdministeredTestSnapshotModel]] = defaultdict(list)
    for snapshot in snapshots:
        snapshots_by_lineage[resolve_lineage_id(snapshot)].append(snapshot)

    items = [
        _build_one_student(
            student, attempts_by_student.get(student.id, []), snapshots_by_lineage, resolution
        )
        for student in sorted(students, key=lambda s: (s.last_name.casefold(), s.first_name.casefold()))
    ]

    return StudentPerformanceListResponseModel(
        generated_at=datetime.now(UTC),
        retake_resolution=resolution,
        items=items,
        unlinked_sheet_count=unlinked_sheet_count,
    )


def _build_one_student(
    student: StudentModel,
    attempts: list[StudentAttemptModel],
    snapshots_by_lineage: dict[str, list[AdministeredTestSnapshotModel]],
    resolution: RetakeResolution,
) -> StudentPerformanceModel:
    by_lineage: dict[str, list[StudentAttemptModel]] = defaultdict(list)
    for attempt in attempts:
        by_lineage[attempt.lineage_id].append(attempt)

    lineages: list[StudentLineagePerformanceModel] = []
    for lineage_id, lineage_attempts in by_lineage.items():
        ordered = sorted(lineage_attempts, key=_attempt_order)
        for number, attempt in enumerate(ordered, start=1):
            attempt.attempt_number = number
        lineages.append(
            StudentLineagePerformanceModel(
                lineage_id=lineage_id,
                test_title=lineage_title(snapshots_by_lineage.get(lineage_id, []))
                or ordered[0].test_title,
                attempts=ordered,
                resolved=resolve_lineage(ordered, resolution),
            )
        )
    lineages.sort(key=lambda lineage: lineage.test_title.casefold())

    points_earned = sum(lineage.resolved.points_earned for lineage in lineages)
    points_possible = sum(lineage.resolved.points_possible for lineage in lineages)

    return StudentPerformanceModel(
        student=student,
        tests_taken=len(lineages),
        attempt_count=len(attempts),
        points_earned=points_earned,
        points_possible=points_possible,
        percent_correct=(100.0 * points_earned / points_possible if points_possible else 0.0),
        unscored_manual_attempt_count=sum(
            1 for attempt in attempts if attempt.contains_unscored_manual_items
        ),
        by_standard=_pool_standards([lineage.resolved.by_standard for lineage in lineages]),
        lineages=lineages,
    )


def _pool_standards(
    groups: list[list[StudentStandardScoreModel]],
) -> list[StudentStandardScoreModel]:
    """Combine per-test standard entries into one cross-test view.

    Points and item counts are summed. Mastery cannot be summed -- it is already
    an average -- so it is re-averaged across tests weighted by how many items
    each test contributed to that standard, which is the same thing computing it
    from all the rows at once would have produced.
    """

    totals: dict[str, StudentStandardScoreModel] = {}
    mastery_weight: dict[str, float] = defaultdict(float)
    mastery_total: dict[str, float] = defaultdict(float)
    difficulty_total: dict[str, float] = defaultdict(float)

    for group in groups:
        for entry in group:
            running = totals.get(entry.standard_id)
            if running is None:
                totals[entry.standard_id] = entry.model_copy(deep=True)
            else:
                running.items_attempted += entry.items_attempted
                running.items_full_credit += entry.items_full_credit
                running.points_earned += entry.points_earned
                running.points_possible += entry.points_possible
            mastery_total[entry.standard_id] += entry.mastery_estimate * entry.items_attempted
            mastery_weight[entry.standard_id] += entry.items_attempted
            difficulty_total[entry.standard_id] += entry.average_difficulty * entry.items_attempted

    pooled: list[StudentStandardScoreModel] = []
    for standard_id in sorted(totals):
        entry = totals[standard_id]
        weight = mastery_weight[standard_id]
        entry.percent_earned = (
            100.0 * entry.points_earned / entry.points_possible if entry.points_possible else 0.0
        )
        entry.mastery_estimate = mastery_total[standard_id] / weight if weight else 0.0
        entry.average_difficulty = difficulty_total[standard_id] / weight if weight else 0.0
        pooled.append(entry)
    return pooled


def _attempt_order(attempt: StudentAttemptModel) -> tuple[datetime, datetime, str]:
    """Print date first -- that is when the student sat the paper. Two batches
    scanned from one printing share a print date, so the scan date breaks the
    tie, and the sheet id keeps the order stable when even that matches."""

    return (attempt.printed_at, attempt.scanned_at, attempt.sheet_id)


def _from_single_attempt(
    attempt: StudentAttemptModel, resolution: RetakeResolution, attempt_count: int
) -> ResolvedLineageScoreModel:
    return ResolvedLineageScoreModel(
        resolution=resolution,
        attempt_count=attempt_count,
        source_attempt_numbers=[attempt.attempt_number],
        points_earned=attempt.points_earned,
        points_possible=attempt.points_possible,
        percent_correct=attempt.percent_correct,
        by_standard=[entry.model_copy(deep=True) for entry in attempt.by_standard],
    )


def _averaged(attempts: list[StudentAttemptModel]) -> ResolvedLineageScoreModel:
    count = len(attempts)
    percent = sum(attempt.percent_correct for attempt in attempts) / count

    # Per standard, average over the attempts that actually tested it: a
    # standard that only appeared on the retake is reported from the retake,
    # not diluted by tests that never asked about it.
    grouped: dict[str, list[StudentStandardScoreModel]] = defaultdict(list)
    for attempt in attempts:
        for entry in attempt.by_standard:
            grouped[entry.standard_id].append(entry)

    by_standard = [
        StudentStandardScoreModel(
            standard_id=standard_id,
            items_attempted=sum(entry.items_attempted for entry in entries),
            items_full_credit=sum(entry.items_full_credit for entry in entries),
            points_earned=sum(entry.points_earned for entry in entries) / len(entries),
            points_possible=sum(entry.points_possible for entry in entries) / len(entries),
            percent_earned=sum(entry.percent_earned for entry in entries) / len(entries),
            mastery_estimate=sum(entry.mastery_estimate for entry in entries) / len(entries),
            average_difficulty=sum(entry.average_difficulty for entry in entries) / len(entries),
        )
        for standard_id, entries in sorted(grouped.items())
    ]

    return ResolvedLineageScoreModel(
        resolution="average",
        attempt_count=count,
        source_attempt_numbers=[attempt.attempt_number for attempt in attempts],
        points_earned=sum(attempt.points_earned for attempt in attempts) / count,
        points_possible=sum(attempt.points_possible for attempt in attempts) / count,
        percent_correct=percent,
        by_standard=by_standard,
    )
