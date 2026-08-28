from __future__ import annotations

from pathlib import Path

import pytest

from app.backend.gradebook_service import GradebookService
from app.backend.service import BankWorkspaceError


def test_create_gradebook_writes_manifest_and_empty_roster(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    destination = tmp_path / "period-2.nxgb"
    summary = gradebook_service.create_gradebook("Period 2 - Fall 2026", None, str(destination))

    assert destination.exists()
    assert summary.manifest.title == "Period 2 - Fall 2026"
    assert gradebook_service.list_students().items == []


def test_create_gradebook_rejects_wrong_extension(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    with pytest.raises(BankWorkspaceError):
        gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.bok"))


def test_create_gradebook_rejects_empty_title(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    with pytest.raises(BankWorkspaceError):
        gradebook_service.create_gradebook("   ", None, str(tmp_path / "period-2.nxgb"))


def test_open_gradebook_round_trips_saved_roster(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    destination = tmp_path / "period-2.nxgb"
    gradebook_service.create_gradebook("Period 2", None, str(destination))
    student = gradebook_service.upsert_student(
        None, _upsert_request("Ada", "Lovelace", "S-100")
    )
    gradebook_service.save_gradebook()

    reopened = GradebookService()
    reopened.open_gradebook(str(destination))
    students = reopened.list_students().items
    assert len(students) == 1
    assert students[0].id == student.id
    assert students[0].first_name == "Ada"
    assert students[0].external_id == "S-100"


def test_roster_crud(gradebook_service: GradebookService, tmp_path: Path) -> None:
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))

    created = gradebook_service.upsert_student(None, _upsert_request("Grace", "Hopper"))
    assert created.external_id is None

    updated = gradebook_service.upsert_student(
        created.id, _upsert_request("Grace", "Hopper", "S-200")
    )
    assert updated.id == created.id
    assert updated.external_id == "S-200"
    assert len(gradebook_service.list_students().items) == 1

    gradebook_service.delete_student(created.id)
    assert gradebook_service.list_students().items == []


def test_upsert_student_missing_id_raises(gradebook_service: GradebookService, tmp_path: Path) -> None:
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))
    with pytest.raises(BankWorkspaceError):
        gradebook_service.upsert_student("does-not-exist", _upsert_request("Ada", "Lovelace"))


def test_delete_student_missing_id_raises(gradebook_service: GradebookService, tmp_path: Path) -> None:
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))
    with pytest.raises(BankWorkspaceError):
        gradebook_service.delete_student("does-not-exist")


def test_operations_require_open_gradebook(gradebook_service: GradebookService) -> None:
    with pytest.raises(BankWorkspaceError):
        gradebook_service.list_students()


def _upsert_request(first_name: str, last_name: str, external_id: str | None = None):
    from app.backend.models import UpsertStudentRequest

    return UpsertStudentRequest(first_name=first_name, last_name=last_name, external_id=external_id)


def test_create_gradebook_appends_the_extension_when_it_is_missing(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    # A teacher typing a destination should not have to remember ".nxgb".
    summary = gradebook_service.create_gradebook(
        "Period 3", None, str(tmp_path / "period-3")
    )

    assert (tmp_path / "period-3.nxgb").exists()
    assert summary.source_path.endswith("period-3.nxgb")


def test_create_gradebook_leaves_a_correct_extension_alone(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    summary = gradebook_service.create_gradebook(
        "Period 4", None, str(tmp_path / "period-4.nxgb")
    )

    assert summary.source_path.endswith("period-4.nxgb")
    assert not (tmp_path / "period-4.nxgb.nxgb").exists()


def test_create_gradebook_still_refuses_a_different_extension(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    # Silently renaming someone's .bok would be worse than refusing it.
    with pytest.raises(BankWorkspaceError) as exc_info:
        gradebook_service.create_gradebook("Period 5", None, str(tmp_path / "bank.bok"))

    assert exc_info.value.status_code == 400
    assert ".bok" in exc_info.value.message


def test_saving_to_a_new_path_appends_the_extension_too(
    gradebook_service: GradebookService, tmp_path: Path
) -> None:
    gradebook_service.create_gradebook("Period 6", None, str(tmp_path / "period-6.nxgb"))

    saved_to = gradebook_service.save_gradebook(str(tmp_path / "period-6-copy"))

    assert saved_to.endswith("period-6-copy.nxgb")
    assert (tmp_path / "period-6-copy.nxgb").exists()
