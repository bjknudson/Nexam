"""The shipped samples are what a new user and a quick manual test both start
from, so their shape is worth asserting: silently losing a version or a roster
turns 'try the grading flow' into 'first build some data'."""

from __future__ import annotations

from pathlib import Path

from app.backend.gradebook_service import GradebookService
from app.backend.service import BankWorkspaceService

REPO_ROOT = Path(__file__).resolve().parents[3]
DEMO_GRADEBOOK = REPO_ROOT / "samples" / "demo-gradebook.nxgb"


def test_demo_bank_ships_two_test_lineages_of_three_versions(
    bank_service: BankWorkspaceService, demo_bok: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    drafts = [item.test for item in bank_service.list_test_drafts().items]

    lineages: dict[str, list[str]] = {}
    for draft in drafts:
        lineages.setdefault(draft.title, []).append(draft.version)

    assert len(lineages) == 2
    for versions in lineages.values():
        assert sorted(versions) == ["A", "B", "C"]


def test_every_demo_version_has_the_same_scannable_shape(
    bank_service: BankWorkspaceService, demo_bok: Path
) -> None:
    """8 multiple choice, 1 numeric, 1 written -- and identical across versions,
    which is what interchangeable sheets require."""

    bank_service.open_bank(str(demo_bok))
    shapes: dict[str, set[tuple[str, ...]]] = {}

    for item in bank_service.list_test_drafts().items:
        questions = {question.id: question for question in item.questions}
        kinds = tuple(
            questions[entry.question_id].type
            for entry in item.test.items
            if entry.question_id in questions
        )
        assert kinds.count("multiple_choice") >= 8
        assert kinds.count("numeric_response") == 1
        assert kinds.count("free_response") == 1
        shapes.setdefault(item.test.title, set()).add(kinds)

    # Same shape across a lineage's versions, or one sheet cannot serve them all.
    for title, variants in shapes.items():
        assert len(variants) == 1, f"{title} versions differ in sheet shape"


def test_one_demo_lineage_is_marked_interchangeable(
    bank_service: BankWorkspaceService, demo_bok: Path
) -> None:
    bank_service.open_bank(str(demo_bok))
    drafts = [item.test for item in bank_service.list_test_drafts().items]
    assert any(draft.interchangeable_sheets for draft in drafts)
    assert any(not draft.interchangeable_sheets for draft in drafts)
    # Every version carries a note explaining why it exists.
    assert all(draft.version_description for draft in drafts)


def test_demo_gradebook_ships_a_roster_and_no_student_work(tmp_path: Path) -> None:
    assert DEMO_GRADEBOOK.exists(), "run scripts/build_demo_gradebook.py"

    service = GradebookService()
    service.open_gradebook(str(DEMO_GRADEBOOK))

    students = service.list_students().items
    assert len(students) >= 20
    assert all(student.first_name and student.last_name for student in students)
    # A shipped sample must not carry scans or scores from anyone.
    assert service.list_administered_tests().items == []


DEMO_BANK_DIR = REPO_ROOT / "samples" / "demo-bank"


def test_demo_questions_with_variables_fill_to_numbers() -> None:
    import json
    import re

    from app.backend.svg_variables import fill_question_text

    templated = 0
    for path in sorted((DEMO_BANK_DIR / "questions").glob("*.json")):
        question = json.loads(path.read_text(encoding="utf-8"))
        variables = question.get("variables") or {}
        if not variables:
            continue
        templated += 1
        answer = question.get("answer") or {}
        texts = [question["prompt"], question.get("explanation") or "", *map(str, answer.get("choices", []))]
        for text in texts:
            filled = fill_question_text(text, variables)
            # Every {{name}} is one of the question's variables, and every calc worked out.
            assert not re.search(r"{{\s*(calc:|[A-Za-z_])", filled), (path.name, filled)
        if "value" in answer:
            float(fill_question_text(str(answer["value"]), variables))

    assert templated >= 8


def test_demo_drawings_render_completely_with_their_samples() -> None:
    from app.backend.asset_metadata import summarize_svg

    service = BankWorkspaceService()
    for path in sorted((DEMO_BANK_DIR / "assets").glob("*.svg")):
        source = path.read_text(encoding="utf-8")
        values = summarize_svg(source).preview_values
        if not values:
            continue
        rendered = service.render_svg(source, values)
        assert "{{" not in rendered.split("</metadata>")[-1], path.name


def test_demo_numeric_answer_key_is_worked_out(tmp_path: Path) -> None:
    from app.backend.grading.answer_key import derive_answer_key
    from app.backend.models import TestDraftModel, TestQuestionItemModel

    service = BankWorkspaceService()
    service.open_bank(str(REPO_ROOT / "samples" / "demo-bank.bok"))
    question = service.get_question("q_num_0008")
    test = TestDraftModel(id="t", title="T", items=[TestQuestionItemModel(question_id="q_num_0008")])

    key = derive_answer_key(test, {"q_num_0008": question})

    assert key.items[0].numeric_value == 5.0
