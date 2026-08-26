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
