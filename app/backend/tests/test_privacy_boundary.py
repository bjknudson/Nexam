"""A bank saved to disk must never contain gradebook data.

This is the core guarantee behind the two-package split described in
docs/grading-plan.md: student rosters, scans, and scores must be
structurally incapable of riding along inside a .bok file that gets shared
between teachers. If this test ever fails, the privacy boundary has broken,
not just some incidental behavior.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from app.backend.gradebook_service import GradebookService
from app.backend.models import UpsertStudentRequest
from app.backend.service import BankWorkspaceService


def test_saved_bank_contains_no_gradebook_data(demo_bok: Path, tmp_path: Path) -> None:
    bank_service = BankWorkspaceService()
    bank_service.open_bank(str(demo_bok))

    gradebook_service = GradebookService()
    gradebook_service.create_gradebook("Period 2", None, str(tmp_path / "period-2.nxgb"))
    student_name = "Ada Lovelace"
    student_external_id = "S-100-SECRET"
    gradebook_service.upsert_student(
        None,
        UpsertStudentRequest(first_name="Ada", last_name="Lovelace", external_id=student_external_id),
    )
    gradebook_service.save_gradebook()

    saved_bank_path = tmp_path / "resaved-demo-bank.bok"
    bank_service.save_bank(str(saved_bank_path))

    with zipfile.ZipFile(saved_bank_path) as archive:
        names = archive.namelist()
        assert not any("roster" in name for name in names)
        assert not any("gradebook" in name.lower() for name in names)
        for name in names:
            if name.endswith("/"):
                continue
            content = archive.read(name)
            assert student_external_id.encode() not in content
            assert student_name.encode() not in content
            assert b"Lovelace" not in content

    # The two packages' on-disk workspaces are fully disjoint directories.
    _, bank_workspace = bank_service.ensure_open()
    _, gradebook_workspace = gradebook_service.ensure_open()
    assert bank_workspace != gradebook_workspace
    assert gradebook_workspace not in bank_workspace.parents
    assert bank_workspace not in gradebook_workspace.parents
