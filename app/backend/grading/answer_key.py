"""Pure derivation of an answer key from a live test draft.

Mirrors the choice-letter/order logic in app/frontend/src/TestPrintPreview.tsx
(CHOICE_LABELS, questionNumber, getChoices) exactly, so the sheet a student
fills in and the key used to grade it always agree on ordering, without the
frontend and backend needing to talk to each other about it.
"""

from __future__ import annotations

from ..models import (
    AnswerKeyItemModel,
    AnswerKeyModel,
    QuestionModel,
    TestDraftModel,
    TestQuestionItemModel,
)


def derive_answer_key(
    test: TestDraftModel, questions_by_id: dict[str, QuestionModel]
) -> AnswerKeyModel:
    items: list[AnswerKeyItemModel] = []
    total_points = 0.0
    item_number = 0

    for item in test.items:
        if not isinstance(item, TestQuestionItemModel):
            continue
        item_number += 1

        question = questions_by_id.get(item.question_id)
        if question is None:
            # Dangling question reference: keep the slot numbered so the
            # printed booklet's numbering still lines up, but nothing to key.
            continue

        points = question.points if question.points is not None else 1.0
        total_points += points

        standard_ids = [reference.standard_id for reference in question.standards]
        if question.type == "multiple_choice":
            answer_key_item = _derive_multiple_choice(question, item_number, points, standard_ids)
        elif question.type == "numeric_response":
            answer_key_item = _derive_numeric_response(question, item_number, points, standard_ids)
        else:
            answer_key_item = AnswerKeyItemModel(
                question_id=question.id,
                test_item_number=item_number,
                sheet_item_number=item_number,
                row_kind="manual_capture",
                points=points,
                standard_ids=standard_ids,
            )
        items.append(answer_key_item)

    return AnswerKeyModel(
        test_id=test.id,
        version=test.version,
        items=items,
        total_points=total_points,
    )


def _derive_multiple_choice(
    question: QuestionModel, item_number: int, points: float, standard_ids: list[str]
) -> AnswerKeyItemModel:
    answer = question.answer or {}
    choices = answer.get("choices") or []
    correct_indices = answer.get("correct_choice_indices")
    if correct_indices is None:
        single_index = answer.get("correct_choice_index")
        correct_indices = [single_index] if single_index is not None else []

    return AnswerKeyItemModel(
        question_id=question.id,
        test_item_number=item_number,
        sheet_item_number=item_number,
        row_kind="multiple_choice",
        points=points,
        standard_ids=standard_ids,
        choice_count=len(choices),
        correct_choice_indices=list(correct_indices),
    )


def _derive_numeric_response(
    question: QuestionModel, item_number: int, points: float, standard_ids: list[str]
) -> AnswerKeyItemModel:
    answer = question.answer or {}
    value = float(answer["value"])
    tolerance = float(answer["tolerance"])

    allow_negative = bool(answer.get("allow_negative", value < 0))
    allow_decimal = bool(answer.get("allow_decimal", not float(value).is_integer()))

    if "grid_digits" in answer:
        grid_digits = int(answer["grid_digits"])
    else:
        digits_text = (
            f"{abs(value):g}".replace(".", "") if allow_decimal else str(int(round(abs(value))))
        )
        grid_digits = max(len(digits_text), 1)

    return AnswerKeyItemModel(
        question_id=question.id,
        test_item_number=item_number,
        sheet_item_number=item_number,
        row_kind="numeric_response",
        points=points,
        standard_ids=standard_ids,
        numeric_value=value,
        numeric_tolerance=tolerance,
        grid_digits=grid_digits,
        allow_decimal=allow_decimal,
        allow_negative=allow_negative,
    )
