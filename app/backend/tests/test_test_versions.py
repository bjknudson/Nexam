"""A new version of a test from AI-edited JSON (app/backend/test_versions.py)."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from app.backend.models import VersionImportRequest
from app.backend.service import BankWorkspaceError, BankWorkspaceService


def _payload(service: BankWorkspaceService, test_id: str) -> dict:
    detail = service.get_test_draft(test_id)
    return {"test": detail.test.model_dump(mode="json"), "questions": [q.model_dump(mode="json") for q in detail.questions]}


def _question(payload: dict, question_id: str) -> dict:
    return next(question for question in payload["questions"] if question["id"] == question_id)


@pytest.fixture
def opened(bank_service: BankWorkspaceService, demo_bok: Path) -> BankWorkspaceService:
    bank_service.open_bank(str(demo_bok))
    return bank_service


def test_new_values_change_one_slot_and_keep_the_rest(opened: BankWorkspaceService) -> None:
    payload = _payload(opened, "test_0001")
    _question(payload, "q_mc_0001")["variables"] = {"a": "4", "t": "5"}

    preview = opened.preview_test_version("test_0001", VersionImportRequest(payload=payload))

    statuses = {item.original_id: item.status for item in preview.items if item.kind == "question"}
    assert statuses["q_mc_0001"] == "changed"
    assert set(statuses.values()) == {"changed", "kept"}
    assert preview.errors == []
    changed = next(item for item in preview.items if item.original_id == "q_mc_0001")
    assert changed.question.id != "q_mc_0001"
    assert changed.question.variables == {"a": "4", "t": "5"}


def test_creating_the_version_writes_only_changed_questions(opened: BankWorkspaceService) -> None:
    source = opened.get_test_draft("test_0001")
    payload = _payload(opened, "test_0001")
    _question(payload, "q_mc_0001")["variables"] = {"a": "4", "t": "5"}

    detail = opened.create_test_version("test_0001", VersionImportRequest(payload=payload))

    assert detail.test.id != "test_0001"
    assert detail.test.title == source.test.title
    assert detail.test.version not in {test.test.version for test in opened.list_test_drafts().items if test.test.id != detail.test.id and test.test.title == source.test.title}
    new_ids = [item.question_id for item in detail.test.items if getattr(item, "question_id", None)]
    old_ids = [item.question_id for item in source.test.items if getattr(item, "question_id", None)]
    assert len(new_ids) == len(old_ids)
    # Only the changed question is new; the others are shared with the original.
    assert [new for new, old in zip(new_ids, old_ids) if new != old] == [new_ids[old_ids.index("q_mc_0001")]]
    assert opened.get_question(new_ids[old_ids.index("q_mc_0001")]).variables == {"a": "4", "t": "5"}
    # The original test is untouched.
    assert [item.question_id for item in opened.get_test_draft("test_0001").test.items if getattr(item, "question_id", None)] == old_ids


def test_interchangeable_sheets_need_the_same_shape(opened: BankWorkspaceService) -> None:
    payload = _payload(opened, "test_0001")
    first_mc = next(question for question in payload["questions"] if question["type"] == "multiple_choice")
    first_mc["answer"]["choices"] = first_mc["answer"]["choices"][:3]

    preview = opened.preview_test_version("test_0001", VersionImportRequest(payload=payload))

    assert any("interchangeable sheets" in error and "choices" in error for error in preview.errors)
    with pytest.raises(BankWorkspaceError):
        opened.create_test_version("test_0001", VersionImportRequest(payload=payload))


def test_left_out_questions_are_kept_and_extras_added_when_sheets_are_not_shared(opened: BankWorkspaceService) -> None:
    source = opened.get_test_draft("test_0001").test
    opened.update_test_draft("test_0001", source.model_copy(update={"interchangeable_sheets": False}))
    payload = _payload(opened, "test_0001")
    dropped = payload["questions"].pop(1)["id"]
    payload["test"]["items"] = [item for item in payload["test"]["items"] if item.get("question_id") != dropped]
    extra = copy.deepcopy(_question(payload, "q_mc_0001"))
    extra.pop("id")
    extra["prompt"] = "A bonus question: a cart starts at {{a}} m/s^2. What is its speed after 1 s?"
    payload["questions"].append(extra)

    preview = opened.preview_test_version("test_0001", VersionImportRequest(payload=payload))

    restored = [item for item in preview.items if item.status == "restored"]
    assert [item.original_id for item in restored] == [dropped]
    assert preview.items[-1].status == "new"
    assert any("left out" in warning for warning in preview.warnings)
    leaving_out = opened.preview_test_version("test_0001", VersionImportRequest(payload=payload, keep_missing=False))
    assert all(item.status != "restored" for item in leaving_out.items)


def test_reviews_flag_choices_that_come_out_the_same(opened: BankWorkspaceService) -> None:
    payload = _payload(opened, "test_0001")
    _question(payload, "q_mc_0001")["answer"]["choices"] = ["{{calc: a * t}} m/s", "{{calc: t * a}} m/s", "1 m/s", "2 m/s"]

    preview = opened.preview_test_version("test_0001", VersionImportRequest(payload=payload))

    changed = next(item for item in preview.items if item.original_id == "q_mc_0001")
    assert any(issue.code == "duplicate_choices" for issue in changed.issues)


def test_the_next_version_letter_skips_used_ones() -> None:
    from app.backend.test_versions import next_version_letter

    assert next_version_letter("A", {"A"}) == "B"
    assert next_version_letter("A", {"A", "B", "C"}) == "D"
    assert next_version_letter("Form 1", {"Form 1"}) == "Form 1 2"


def test_each_review_item_points_at_its_pasted_question(opened: BankWorkspaceService) -> None:
    payload = _payload(opened, "test_0001")
    _question(payload, "q_mc_0001")["prompt"] += " (version B)"
    added = copy.deepcopy(_question(payload, "q_mc_0002"))
    del added["id"]
    added["prompt"] = "Which particle carries no charge?"
    payload["questions"].append(added)
    left_out = payload["questions"].pop(payload["questions"].index(_question(payload, "q_mc_0008")))

    preview = opened.preview_test_version("test_0001", VersionImportRequest(payload=payload))

    by_status = {item.status: item for item in preview.items if item.kind == "question"}
    changed = next(item for item in preview.items if item.original_id == "q_mc_0001")
    assert payload["questions"][changed.payload_index]["id"] == "q_mc_0001"
    assert payload["questions"][by_status["new"].payload_index] == added
    # Still named by the test's items, so it is kept, with nothing pasted to point at.
    missing = next(item for item in preview.items if item.original_id == left_out["id"])
    assert missing.status == "kept" and missing.payload_index is None
