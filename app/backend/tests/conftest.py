from __future__ import annotations

from pathlib import Path
import shutil

import pytest
from fastapi.testclient import TestClient

from app.backend import main
from app.backend.gradebook_service import GradebookService
from app.backend.service import BankWorkspaceService


REPO_ROOT = Path(__file__).resolve().parents[3]
SAMPLE_BOK = REPO_ROOT / "samples" / "demo-bank.bok"


@pytest.fixture
def demo_bok(tmp_path: Path) -> Path:
    target = tmp_path / "demo-bank.bok"
    shutil.copyfile(SAMPLE_BOK, target)
    return target


@pytest.fixture
def bank_service() -> BankWorkspaceService:
    return BankWorkspaceService()


@pytest.fixture
def gradebook_service() -> GradebookService:
    return GradebookService()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    test_service = BankWorkspaceService()
    monkeypatch.setattr(main, "service", test_service)
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture
def gradebook_client(monkeypatch: pytest.MonkeyPatch):
    test_service = BankWorkspaceService()
    test_gradebook_service = GradebookService()
    monkeypatch.setattr(main, "service", test_service)
    monkeypatch.setattr(main, "gradebook_service", test_gradebook_service)
    with TestClient(main.app) as test_client:
        yield test_client
