"""Advisory question "lint" -- completeness checks that never block a save.

`QuestionModel.validate_question_shape` (models.py) enforces structural
invariants only: data that would be malformed or internally inconsistent.
Everything here is a softer judgment -- "this question isn't finished yet" --
and is surfaced to callers as a list of issues instead of raising, so an
in-progress question (a fresh "New", a cleared field, a partially-filled
import row) is never rejected just for being incomplete.

Adding or changing a rule only means editing the `RULES` list below -- nothing
else in the backend or frontend hardcodes rule logic; both sides consume the
resulting `QuestionImportValidationIssueModel` list generically by `location`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .models import QuestionImportValidationIssueModel, QuestionModel


@dataclass
class Rule:
    id: str
    applies_to: Callable[[QuestionModel], bool]
    check: Callable[[QuestionModel], list[QuestionImportValidationIssueModel]]


def _mc_needs_two_choices(question: QuestionModel) -> list[QuestionImportValidationIssueModel]:
    choices = (question.answer or {}).get("choices") or []
    if len(choices) >= 2:
        return []
    return [
        QuestionImportValidationIssueModel(
            code="mc_needs_two_choices",
            message="multiple_choice questions need at least two choices",
            location=["answer", "choices"],
            severity="warning",
        )
    ]


def _mc_needs_correct_answer(question: QuestionModel) -> list[QuestionImportValidationIssueModel]:
    answer = question.answer or {}
    if answer.get("correct_choice_index") is not None or answer.get("correct_choice_indices"):
        return []
    return [
        QuestionImportValidationIssueModel(
            code="mc_needs_correct_answer",
            message="multiple_choice questions need a correct answer designated",
            location=["answer", "correct_choice_index"],
            severity="warning",
        )
    ]


def _mc_choices_need_text_or_image(
    question: QuestionModel,
) -> list[QuestionImportValidationIssueModel]:
    answer = question.answer or {}
    choices = answer.get("choices") or []
    choice_assets = answer.get("choice_assets") or {}
    issues: list[QuestionImportValidationIssueModel] = []
    for index, choice in enumerate(choices):
        has_text = isinstance(choice, str) and choice.strip() != ""
        has_image = str(index) in choice_assets
        if not has_text and not has_image:
            issues.append(
                QuestionImportValidationIssueModel(
                    code="mc_choice_needs_text_or_image",
                    message=f"choice {index + 1} needs text or an image",
                    location=["answer", "choices", index],
                    severity="warning",
                )
            )
    return issues


def _numeric_needs_value(question: QuestionModel) -> list[QuestionImportValidationIssueModel]:
    answer = question.answer or {}
    if "value" in answer:
        return []
    return [
        QuestionImportValidationIssueModel(
            code="numeric_needs_value",
            message="numeric_response questions need an answer value",
            location=["answer", "value"],
            severity="warning",
        )
    ]


def _numeric_needs_tolerance(question: QuestionModel) -> list[QuestionImportValidationIssueModel]:
    answer = question.answer or {}
    if "tolerance" in answer:
        return []
    return [
        QuestionImportValidationIssueModel(
            code="numeric_needs_tolerance",
            message="numeric_response questions need an answer tolerance",
            location=["answer", "tolerance"],
            severity="warning",
        )
    ]


def _short_answer_needs_sample_solution(
    question: QuestionModel,
) -> list[QuestionImportValidationIssueModel]:
    if (question.sample_solution or "").strip():
        return []
    return [
        QuestionImportValidationIssueModel(
            code="short_answer_needs_sample_solution",
            message="short_answer questions need a sample_solution",
            location=["sample_solution"],
            severity="warning",
        )
    ]


def _free_response_needs_rubric(
    question: QuestionModel,
) -> list[QuestionImportValidationIssueModel]:
    if question.rubric:
        return []
    return [
        QuestionImportValidationIssueModel(
            code="free_response_needs_rubric",
            message="free_response questions need at least one rubric row",
            location=["rubric"],
            severity="warning",
        )
    ]


RULES: list[Rule] = [
    Rule("mc_needs_two_choices", lambda q: q.type == "multiple_choice", _mc_needs_two_choices),
    Rule(
        "mc_needs_correct_answer",
        lambda q: q.type == "multiple_choice",
        _mc_needs_correct_answer,
    ),
    Rule(
        "mc_choice_needs_text_or_image",
        lambda q: q.type == "multiple_choice",
        _mc_choices_need_text_or_image,
    ),
    Rule("numeric_needs_value", lambda q: q.type == "numeric_response", _numeric_needs_value),
    Rule(
        "numeric_needs_tolerance",
        lambda q: q.type == "numeric_response",
        _numeric_needs_tolerance,
    ),
    Rule(
        "short_answer_needs_sample_solution",
        lambda q: q.type == "short_answer",
        _short_answer_needs_sample_solution,
    ),
    Rule(
        "free_response_needs_rubric",
        lambda q: q.type == "free_response",
        _free_response_needs_rubric,
    ),
]


def lint_question(question: QuestionModel) -> list[QuestionImportValidationIssueModel]:
    """Run every applicable advisory rule against `question`. Never raises."""

    issues: list[QuestionImportValidationIssueModel] = []
    for rule in RULES:
        if rule.applies_to(question):
            issues.extend(rule.check(question))
    return issues
