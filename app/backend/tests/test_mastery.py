"""The mastery calculations, checked against the worked examples in the spec.

Pure arithmetic over Evidence -- no gradebook, no bank, no scans.
"""

from __future__ import annotations

import pytest

from app.backend.grading.mastery import Evidence, apply_reporting, compute_mastery


def _at(level: int, earned: float, possible: float) -> Evidence:
    return Evidence(level=level, points_earned=earned, points_possible=possible)


# -- Level Ladder -------------------------------------------------------------


def test_level_ladder_worked_example() -> None:
    """Level 1 100%, Level 2 100%, Level 3 50% -> 2 + 0.50 = 2.50."""

    result = compute_mastery(
        [_at(1, 4, 4), _at(2, 4, 4), _at(3, 2, 4)],
        calculation="level_ladder",
        reporting="exact",
    )
    assert result.level_exact == pytest.approx(2.50)
    assert result.level == 2.5
    assert result.scale_max == 3
    assert [(e.level, e.mastered) for e in result.levels] == [(1, True), (2, True), (3, False)]


def test_level_ladder_second_worked_example() -> None:
    """50% at Level 2 after mastering Level 1 -> 1.50."""

    result = compute_mastery(
        [_at(1, 4, 4), _at(2, 2, 4)], calculation="level_ladder", reporting="exact"
    )
    assert result.level_exact == pytest.approx(1.50)


def test_level_ladder_stops_at_the_first_unmastered_level() -> None:
    """Mastering Level 3 does not carry you past an unmastered Level 2 -- but
    the fact that you did is reported rather than dropped."""

    result = compute_mastery(
        [_at(1, 4, 4), _at(2, 1, 4), _at(3, 4, 4)],
        calculation="level_ladder",
        reporting="exact",
    )
    assert result.level_exact == pytest.approx(1.25)  # 1 + 0.25
    assert result.inconsistent_evidence is True


def test_level_ladder_consistent_evidence_is_not_flagged() -> None:
    result = compute_mastery(
        [_at(1, 4, 4), _at(2, 1, 4), _at(3, 0, 4)],
        calculation="level_ladder",
        reporting="exact",
    )
    assert result.inconsistent_evidence is False


def test_level_ladder_all_levels_mastered_tops_out_at_the_highest() -> None:
    result = compute_mastery(
        [_at(1, 4, 4), _at(2, 4, 4), _at(3, 4, 4), _at(4, 4, 4)],
        calculation="level_ladder",
        reporting="exact",
    )
    assert result.level_exact == pytest.approx(4.0)
    assert result.scale_max == 4


def test_level_ladder_below_level_one_reports_progress_into_it() -> None:
    result = compute_mastery([_at(1, 2, 4)], calculation="level_ladder", reporting="exact")
    assert result.level_exact == pytest.approx(0.50)


def test_exactly_the_threshold_counts_as_mastered() -> None:
    result = compute_mastery([_at(1, 3, 4)], calculation="level_ladder", reporting="exact")
    assert result.levels[0].mastered is True
    assert result.level_exact == pytest.approx(1.0)


def test_level_gaps_are_flagged() -> None:
    """A ladder missing a rung cannot really say the rung was cleared."""

    result = compute_mastery([_at(1, 4, 4), _at(3, 2, 4)], calculation="level_ladder")
    assert result.has_level_gaps is True

    complete = compute_mastery([_at(1, 4, 4), _at(2, 2, 4)], calculation="level_ladder")
    assert complete.has_level_gaps is False


def test_a_ladder_that_never_starts_at_level_one_is_a_gap() -> None:
    result = compute_mastery([_at(2, 4, 4), _at(3, 2, 4)], calculation="level_ladder")
    assert result.has_level_gaps is True


# -- Difficulty Weighted ------------------------------------------------------


def test_difficulty_weighted_worked_example() -> None:
    """One 15-point Level 4 question, 5 points earned -> (4 * 5) / 15 = 1.33,
    not 3.33."""

    result = compute_mastery(
        [_at(4, 5, 15)], calculation="difficulty_weighted", reporting="exact"
    )
    assert result.level_exact == pytest.approx(1.3333, abs=1e-4)
    assert result.level == 1.33


def test_difficulty_weighted_full_marks_reaches_the_question_level() -> None:
    result = compute_mastery(
        [_at(4, 15, 15)], calculation="difficulty_weighted", reporting="exact"
    )
    assert result.level_exact == pytest.approx(4.0)


def test_difficulty_weighted_combines_questions_by_points() -> None:
    # (2*4 + 4*2) / (4 + 8) = 16 / 12
    result = compute_mastery(
        [_at(2, 4, 4), _at(4, 2, 8)], calculation="difficulty_weighted", reporting="exact"
    )
    assert result.level_exact == pytest.approx(16 / 12, abs=1e-4)


def test_difficulty_weighted_does_not_require_a_complete_ladder() -> None:
    """The mode exists for tests with only hard questions, so a missing Level 1
    is not a defect here and is not flagged as one."""

    result = compute_mastery([_at(4, 5, 15)], calculation="difficulty_weighted")
    assert result.has_level_gaps is False
    assert result.inconsistent_evidence is False


# -- Rubric Levels ------------------------------------------------------------


def test_rubric_levels_ladders_the_components() -> None:
    """The spec's rubric: 3pts L1, 4pts L2, 4pts L3, 4pts L4. Full marks on the
    first two, half on the third -> 2 + 0.5."""

    result = compute_mastery(
        [_at(1, 3, 3), _at(2, 4, 4), _at(3, 2, 4), _at(4, 0, 4)],
        calculation="rubric_levels",
        reporting="exact",
    )
    assert result.level_exact == pytest.approx(2.50)


def test_rubric_levels_says_when_it_had_no_components_to_work_with() -> None:
    result = compute_mastery(
        [_at(2, 4, 4)], calculation="rubric_levels", components_unavailable=True
    )
    assert result.components_unavailable is True


# -- Reporting ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("calculated", "reported"),
    [(1.24, 1.0), (1.25, 1.5), (1.74, 1.5), (1.75, 2.0), (0.0, 0.0), (4.0, 4.0)],
)
def test_half_steps_rounding_table(calculated, reported) -> None:
    assert apply_reporting(calculated, "half_steps") == reported


@pytest.mark.parametrize(
    ("calculated", "reported"), [(1.333, 1.33), (2.666, 2.67), (3.8, 3.8), (2.5, 2.5)]
)
def test_exact_rounding_is_two_decimals(calculated, reported) -> None:
    assert apply_reporting(calculated, "exact") == reported


def test_reporting_never_changes_the_underlying_calculation() -> None:
    evidence = [_at(4, 5, 15)]
    exact = compute_mastery(evidence, "difficulty_weighted", "exact")
    halves = compute_mastery(evidence, "difficulty_weighted", "half_steps")

    assert exact.level_exact == halves.level_exact
    assert exact.level == 1.33
    assert halves.level == 1.5


# -- Nothing to go on ---------------------------------------------------------


def test_no_evidence_reports_zero_rather_than_failing() -> None:
    for calculation in ("level_ladder", "difficulty_weighted", "rubric_levels"):
        result = compute_mastery([], calculation=calculation)
        assert result.level == 0.0
        assert result.scale_max == 0


def test_zero_point_items_are_ignored() -> None:
    result = compute_mastery(
        [_at(1, 0, 0), _at(2, 4, 4)], calculation="level_ladder", reporting="exact"
    )
    assert [entry.level for entry in result.levels] == [2]


# -- The scale is the bank's, not a constant ----------------------------------


def test_the_ceiling_comes_from_the_evidence_not_a_hardcoded_scale() -> None:
    """A bank using 1-4 tops out at 4; one using 1-6 tops out at 6. Nothing in
    the calculation assumes a particular ceiling."""

    four = compute_mastery(
        [_at(level, 4, 4) for level in (1, 2, 3, 4)], calculation="level_ladder"
    )
    assert four.level == 4.0
    assert four.scale_max == 4

    six = compute_mastery(
        [_at(level, 4, 4) for level in (1, 2, 3, 4, 5, 6)], calculation="level_ladder"
    )
    assert six.level == 6.0
    assert six.scale_max == 6


def test_a_two_level_scale_still_ladders() -> None:
    result = compute_mastery(
        [_at(1, 4, 4), _at(2, 1, 4)], calculation="level_ladder", reporting="exact"
    )
    assert result.level_exact == pytest.approx(1.25)
    assert result.scale_max == 2
    assert result.has_level_gaps is False


def test_difficulty_weighted_ceiling_is_the_hardest_question_asked() -> None:
    result = compute_mastery([_at(6, 10, 10)], calculation="difficulty_weighted")
    assert result.level_exact == pytest.approx(6.0)


def test_fallback_level_never_guesses_above_what_is_known() -> None:
    from app.backend.grading.mastery import MINIMUM_LEVEL, fallback_level

    assert fallback_level([2, 3, 4]) == 2
    assert fallback_level([4]) == 4
    assert fallback_level([]) == MINIMUM_LEVEL
