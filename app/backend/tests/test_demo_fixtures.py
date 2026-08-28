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
