"""Turning scored evidence into a mastery level.

Two words, used precisely:

    difficulty  what an author assigns to a question or rubric component
    level       a rung on the mastery ladder, which a student reaches

A question's difficulty is the level it gives evidence about, so the two share a
numbering -- but only one of them is a claim about a student. This module takes
difficulties in (as `Evidence.level`) and reports a level out.

Mastery is a *level*, not a percentage. "2.50" says the student has shown Level 2
and is halfway through Level 3. That is a different claim from "50% correct", and
it is the one a standards-based report is actually making.

The scale is whatever difficulties the bank uses -- nothing here assumes a
ceiling. A bank using 1-4 tops out at 4, one using 1-6 at 6, and `scale_max`
reports the highest level the evidence actually reached, so a reader is never
left guessing what "2.50" is out of.

Three calculations, because assessments differ in what evidence they carry:

    level_ladder         The test walks the levels in sequence. Mastery is the
                         last level cleared, plus progress into the next.
    difficulty_weighted  The test has hard questions but not a full ladder.
                         Partial credit on a hard question counts as partial
                         evidence of that level, without assuming every level
                         below it was cleared.
    rubric_levels        A multipart task whose components carry their own
                         levels. The ladder, applied to components.

Pure functions over `Evidence` -- no models, no persistence, no notion of which
student or test the evidence came from.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

from ..models import (
    MasteryCalculation,
    MasteryLevelBreakdownModel,
    MasteryReporting,
    MasteryResultModel,
)

# A level counts as mastered at 75% of its points. High enough that a student
# who half-understands a level does not get carried up the ladder by partial
# credit; low enough that one slip does not hold them back.
MASTERY_THRESHOLD = 0.75

# The floor of any scale. Levels are ordinal and the ladder reads 0 as "has not
# reached Level 1", so 1 is the lowest rung that can mean anything.
MINIMUM_LEVEL = 1


def fallback_level(known_levels: list[int]) -> int:
    """The level to assume for an item that records none.

    QuestionModel.difficulty is required, so this only arises for answer keys
    frozen before difficulty was carried onto them. Such an item is credited at
    the *lowest* level its neighbours record, never higher: a mastery report that
    guesses upward claims the student cleared a rung nobody has evidence for,
    which is the one direction this must not err in. With nothing to go on at
    all, the bottom of the scale.

    Deliberately derived rather than a constant: any fixed number is only
    "middling" on one particular scale, and the scale is the bank's to choose.
    """

    return min(known_levels) if known_levels else MINIMUM_LEVEL


@dataclass(frozen=True)
class Evidence:
    """One scorable thing at one level: a question, or one rubric component.

    `level` is the item's difficulty, read as the level it gives evidence about.
    """

    level: int
    points_earned: float
    points_possible: float


def compute_mastery(
    evidence: list[Evidence],
    calculation: MasteryCalculation = "level_ladder",
    reporting: MasteryReporting = "half_steps",
    components_unavailable: bool = False,
) -> MasteryResultModel:
    scored = [item for item in evidence if item.points_possible > 0]

    if not scored:
        return MasteryResultModel(
            calculation=calculation,
            reporting=reporting,
            level=0.0,
            level_exact=0.0,
            scale_max=0,
            components_unavailable=components_unavailable,
        )

    breakdown = _breakdown(scored)
    scale_max = max(item.level for item in scored)

    if calculation == "difficulty_weighted":
        exact = _difficulty_weighted(scored)
        inconsistent = False
        gaps = False
    else:
        # rubric_levels is the ladder applied to components rather than to whole
        # questions; the caller has already exploded them, so the arithmetic is
        # identical from here.
        exact, inconsistent = _level_ladder(breakdown)
        gaps = _has_gaps([entry.level for entry in breakdown])

    return MasteryResultModel(
        calculation=calculation,
        reporting=reporting,
        level=apply_reporting(exact, reporting),
        level_exact=round(exact, 4),
        scale_max=scale_max,
        levels=breakdown,
        inconsistent_evidence=inconsistent,
        has_level_gaps=gaps,
        components_unavailable=components_unavailable,
    )


def apply_reporting(value: float, reporting: MasteryReporting) -> float:
    """`half_steps` rounds to the nearest 0.5, halves rounding up: 1.24 -> 1.0,
    1.25 -> 1.5, 1.74 -> 1.5, 1.75 -> 2.0."""

    if reporting == "half_steps":
        return math.floor(value * 2 + 0.5) / 2
    return round(value, 2)


def _breakdown(evidence: list[Evidence]) -> list[MasteryLevelBreakdownModel]:
    earned: dict[int, float] = defaultdict(float)
    possible: dict[int, float] = defaultdict(float)
    for item in evidence:
        earned[item.level] += item.points_earned
        possible[item.level] += item.points_possible

    rows = []
    for level in sorted(possible):
        accuracy = earned[level] / possible[level] if possible[level] else 0.0
        rows.append(
            MasteryLevelBreakdownModel(
                level=level,
                points_earned=earned[level],
                points_possible=possible[level],
                accuracy=100.0 * accuracy,
                mastered=accuracy >= MASTERY_THRESHOLD,
            )
        )
    return rows


def _level_ladder(breakdown: list[MasteryLevelBreakdownModel]) -> tuple[float, bool]:
    """The last level cleared, plus progress into the first one that was not.

    Returns (mastery, evidence_was_inconsistent). Climbing stops at the first
    unmastered level even when a higher level was mastered -- the ladder's whole
    claim is that levels are cleared in order. That higher performance is
    reported as inconsistent evidence rather than quietly dropped: in practice
    it usually means the level labels need revisiting, not the student.
    """

    cleared = 0
    progress = 0.0
    first_unmastered_index: int | None = None

    for index, entry in enumerate(breakdown):
        if entry.mastered:
            cleared = entry.level
            continue
        first_unmastered_index = index
        progress = entry.accuracy / 100.0
        break

    inconsistent = first_unmastered_index is not None and any(
        entry.mastered for entry in breakdown[first_unmastered_index + 1 :]
    )
    return cleared + progress, inconsistent


def _difficulty_weighted(evidence: list[Evidence]) -> float:
    """sum(level * points earned) / sum(points possible).

    A 15-point Level 4 question worth 5 earned points reads as (4 * 5) / 15 =
    1.33 -- evidence of Level 1 mastery with a third of Level 2, not of Level
    3.33. Scoring full marks on it would read as exactly 4.0, so the ceiling is
    still the question's own level.
    """

    possible = sum(item.points_possible for item in evidence)
    if not possible:
        return 0.0
    return sum(item.level * item.points_earned for item in evidence) / possible


def _has_gaps(levels: list[int]) -> bool:
    """True when the levels present skip a rung or do not start at 1.

    The ladder assumes a complete sequence; without one, "cleared Level 2" may
    only mean "was never asked a Level 2 question". Difficulty Weighted exists
    for exactly these tests, so this is worth saying rather than hiding.
    """

    if not levels:
        return False
    return sorted(levels) != list(range(1, max(levels) + 1))
