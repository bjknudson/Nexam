"""A new version of a test from AI-edited JSON.

The teacher hands a test's {test, questions} JSON to an AI with a request
("make version B with new values", "replace the questions with new ones on the
same skills") and pastes back what it returns. Each returned question keeps the
id of the question it replaces, so it is matched to its original:

- kept: identical to the original, which the new version reuses;
- changed: a new question, created in that slot;
- new: no matching original, created where it appears;
- restored: left out by the AI, put back from the original where it was
  (unless the teacher says to leave it out).

Slots are not strict: the version may be longer or shorter, unless the test
uses interchangeable sheets, where every version must have the same shape
(count, types and number of choices per position) to share one answer sheet.

Nothing here writes; `plan_test_version` works out the version and the
service creates it in one pass. See docs/ai-test-versions.md.
"""

from __future__ import annotations

import string
from collections.abc import Callable
from typing import Any

from pydantic import ValidationError

from .grading.lineage import lineage_key
from .models import (
    QuestionImportValidationIssueModel,
    QuestionModel,
    TestDraftModel,
    TestPrintSettingsModel,
    TestQuestionItemModel,
    TestSectionItemModel,
    VersionItemModel,
    VersionPreviewModel,
)
from .svg_variables import fill_question_text
from .validation import lint_question

# The id a question takes before it is created; replaced by a real one on create.
PENDING_ID = "q_pending"


def _comparable(question: QuestionModel) -> dict[str, Any]:
    return question.model_dump(mode="json", exclude={"id"})


def _validated(payload: dict[str, Any], question_id: str) -> tuple[QuestionModel | None, str | None]:
    try:
        return QuestionModel.model_validate({**payload, "id": question_id}), None
    except ValidationError as error:
        detail = error.errors()[0] if error.errors() else {}
        where = ".".join(str(part) for part in detail.get("loc", ()))
        return None, f"{where}: {detail.get('msg', 'invalid question')}" if where else str(detail.get("msg", "invalid question"))


def _extra_checks(question: QuestionModel) -> list[QuestionImportValidationIssueModel]:
    """Checks that need the question's values: worked-out answers that are not
    numbers, and choices that come out the same."""
    issues: list[QuestionImportValidationIssueModel] = []
    answer = question.answer or {}
    if question.type == "numeric_response" and "value" in answer:
        filled = fill_question_text(str(answer["value"]), question.variables)
        try:
            float(filled)
        except ValueError:
            issues.append(
                QuestionImportValidationIssueModel(
                    code="numeric_value_not_a_number",
                    message=f"the answer value is not a number with this question's values: {filled}",
                    location=["answer", "value"],
                    severity="warning",
                )
            )
    choices = [fill_question_text(str(choice), question.variables).strip() for choice in answer.get("choices") or []]
    seen: dict[str, int] = {}
    for index, choice in enumerate(choices):
        if choice and choice in seen:
            issues.append(
                QuestionImportValidationIssueModel(
                    code="duplicate_choices",
                    message=f"choices {seen[choice] + 1} and {index + 1} are the same with this question's values ({choice})",
                    location=["answer", "choices", index],
                    severity="warning",
                )
            )
        seen.setdefault(choice, index)
    return issues


def next_version_letter(source_version: str, used_versions: set[str]) -> str:
    """The next unused letter after the source's (A -> B), or the source's
    version with " 2" etc. when it isn't a single letter."""
    letters = string.ascii_uppercase
    current = source_version.strip().upper()
    if len(current) == 1 and current in letters:
        for letter in letters[letters.index(current) + 1 :]:
            if letter not in used_versions:
                return letter
    number = 2
    while f"{source_version} {number}" in used_versions:
        number += 1
    return f"{source_version} {number}"


def _shape(question: QuestionModel) -> tuple[str, int]:
    return question.type, len((question.answer or {}).get("choices") or [])


def plan_test_version(
    source: TestDraftModel,
    originals: dict[str, QuestionModel],
    payload: dict[str, Any],
    *,
    keep_missing: bool,
    used_versions: set[str],
    next_id: Callable[[str, set[str]], str],
) -> VersionPreviewModel:
    """Work out the version: which questions are kept, changed, new or
    restored, the new test's items, and what to check. `next_id(type,
    reserved)` assigns ids to the questions to create."""

    errors: list[str] = []
    warnings: list[str] = []
    test_payload = payload.get("test") if isinstance(payload.get("test"), dict) else {}
    returned = payload.get("questions") if isinstance(payload.get("questions"), list) else []
    if not returned and not test_payload:
        errors.append("The pasted JSON has no \"test\" and no \"questions\".")

    returned_by_id: dict[str, dict[str, Any]] = {}
    unmatched: list[dict[str, Any]] = []
    # Where each pasted question sits in the array, by object identity.
    payload_index = {id(item): index for index, item in enumerate(returned)}
    for index, item in enumerate(returned):
        if not isinstance(item, dict):
            errors.append(f"Question {index + 1} in the pasted JSON is not an object.")
            continue
        question_id = str(item.get("id") or "").strip()
        if question_id and question_id in originals and question_id not in returned_by_id:
            returned_by_id[question_id] = item
        else:
            unmatched.append(item)

    # The order: the AI's items if it gave them, else the original order.
    raw_items = test_payload.get("items") if isinstance(test_payload.get("items"), list) else None
    if raw_items is None:
        raw_items = [item.model_dump(mode="json") for item in source.items]

    reserved: set[str] = set()
    items: list[VersionItemModel] = []
    used_originals: set[str] = set()

    def question_item(original_id: str | None, payload_item: dict[str, Any] | None) -> VersionItemModel | None:
        original = originals.get(original_id) if original_id else None
        if payload_item is None and original is not None:
            return VersionItemModel(position=0, kind="question", status="kept", original_id=original_id, question=original, original=original)
        assert payload_item is not None
        index = payload_index.get(id(payload_item))
        candidate, problem = _validated(payload_item, original_id or PENDING_ID)
        label = f"question {original_id}" if original_id else "a new question"
        if candidate is None:
            errors.append(f"The pasted {label} is not valid ({problem}).")
            return None
        if original is not None and _comparable(candidate) == _comparable(original):
            return VersionItemModel(
                position=0, kind="question", status="kept", original_id=original_id, question=original, original=original, payload_index=index
            )
        new_id = next_id(candidate.type, reserved)
        reserved.add(new_id)
        created = candidate.model_copy(update={"id": new_id})
        issues = lint_question(created) + _extra_checks(created)
        return VersionItemModel(
            position=0,
            kind="question",
            status="changed" if original is not None else "new",
            original_id=original_id,
            question=created,
            original=original,
            issues=issues,
            payload_index=index,
        )

    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        if raw.get("item_type") == "section":
            try:
                section = TestSectionItemModel.model_validate(raw)
            except ValidationError:
                warnings.append("A section without a title was left out.")
                continue
            items.append(VersionItemModel(position=0, kind="section", status="section", title=section.title))
            continue
        question_id = str(raw.get("question_id") or "").strip()
        if question_id in used_originals:
            warnings.append(f"Question {question_id} appeared twice; it is used once.")
            continue
        if question_id in originals:
            used_originals.add(question_id)
            made = question_item(question_id, returned_by_id.get(question_id))
        else:
            # An item for a question the AI wrote: find it among the unmatched ones by id.
            match = next((item for item in unmatched if str(item.get("id") or "").strip() == question_id and question_id), None)
            if match is None:
                warnings.append(f"An item names a question that isn't in the pasted JSON ({question_id or 'no id'}); it was left out.")
                continue
            unmatched.remove(match)
            made = question_item(None, match)
        if made:
            items.append(made)

    # Returned questions that no item placed: added at the end.
    for item in unmatched:
        made = question_item(None, item)
        if made:
            items.append(made)
    for original_id, payload_item in returned_by_id.items():
        if original_id not in used_originals:
            used_originals.add(original_id)
            made = question_item(original_id, payload_item)
            if made:
                items.append(made)

    # Originals the AI left out entirely.
    original_order = [item.question_id for item in source.items if isinstance(item, TestQuestionItemModel)]
    missing = [question_id for question_id in original_order if question_id not in used_originals]
    if missing:
        if keep_missing:
            for question_id in missing:
                index = original_order.index(question_id)
                # Back where it was among the questions (sections count as positions too).
                question_positions = [i for i, item in enumerate(items) if item.kind == "question"]
                at = question_positions[index] if index < len(question_positions) else len(items)
                original = originals[question_id]
                items.insert(at, VersionItemModel(position=0, kind="question", status="restored", original_id=question_id, question=original, original=original))
            warnings.append(f"The AI left out {len(missing)} question(s); they are kept from the original: {', '.join(missing)}.")
        else:
            warnings.append(f"Left out of this version: {', '.join(missing)}.")

    for position, item in enumerate(items, start=1):
        item.position = position

    questions = [item for item in items if item.kind == "question"]
    if not questions:
        errors.append("The version has no questions.")

    # Interchangeable sheets: every version shares one answer sheet, so the shape must match.
    if source.interchangeable_sheets:
        original_shapes = [_shape(originals[question_id]) for question_id in original_order if question_id in originals]
        new_shapes = [_shape(item.question) for item in questions if item.question]
        if len(new_shapes) != len(original_shapes):
            errors.append(
                f"This test uses interchangeable sheets, so every version needs {len(original_shapes)} questions; this one has {len(new_shapes)}."
            )
        else:
            for number, (before, after) in enumerate(zip(original_shapes, new_shapes), start=1):
                if before != after:
                    errors.append(
                        f"This test uses interchangeable sheets: question {number} must stay {before[0]}"
                        + (f" with {before[1]} choices" if before[1] else "")
                        + f" (it is {after[0]}" + (f" with {after[1]} choices)." if after[1] else ").")
                    )

    title = str(test_payload.get("title") or source.title).strip() or source.title
    requested = str(test_payload.get("version") or "").strip()
    used_here = used_versions if lineage_key(title) == lineage_key(source.title) else set()
    version = requested if requested and requested != source.version and requested not in used_here else next_version_letter(source.version, used_here | {source.version})
    description = test_payload.get("version_description")
    return VersionPreviewModel(
        title=title,
        version=version,
        version_description=str(description) if isinstance(description, str) and description.strip() else f"Made from version {source.version} with AI.",
        items=items,
        errors=errors,
        warnings=warnings,
    )


def build_version_test(
    source: TestDraftModel,
    plan: VersionPreviewModel,
    payload: dict[str, Any],
    new_id: str,
) -> TestDraftModel:
    """The new test draft for `plan`: the source's settings and courses, the
    plan's title, version and items, and the pasted print settings if valid."""
    test_payload = payload.get("test") if isinstance(payload.get("test"), dict) else {}
    sections = iter(
        TestSectionItemModel.model_validate(raw)
        for raw in (test_payload.get("items") or [item.model_dump(mode="json") for item in source.items])
        if isinstance(raw, dict) and raw.get("item_type") == "section" and raw.get("title")
    )
    items: list[TestQuestionItemModel | TestSectionItemModel] = []
    for item in plan.items:
        if item.kind == "section":
            items.append(next(sections))
        elif item.question:
            items.append(TestQuestionItemModel(question_id=item.question.id))
    print_settings = source.print_settings
    if isinstance(test_payload.get("print_settings"), dict):
        try:
            print_settings = TestPrintSettingsModel.model_validate(test_payload["print_settings"])
        except ValidationError:
            pass
    return source.model_copy(
        deep=True,
        update={
            "id": new_id,
            "title": plan.title,
            "version": plan.version,
            "version_description": plan.version_description,
            "items": items,
            "print_settings": print_settings,
            "performance_runs": [],
            "finished": False,
            "has_generated_sheets": False,
        },
    )
