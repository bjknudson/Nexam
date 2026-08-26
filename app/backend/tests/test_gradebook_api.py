from __future__ import annotations

from pathlib import Path


def test_create_open_save_close_lifecycle(gradebook_client, tmp_path: Path) -> None:
    destination = tmp_path / "period-2.nxgb"

    create_response = gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(destination)},
    )
    assert create_response.status_code == 200
    assert destination.exists()

    current_response = gradebook_client.get("/api/gradebook/current")
    assert current_response.status_code == 200
    assert current_response.json()["manifest"]["title"] == "Period 2"

    update_response = gradebook_client.put(
        "/api/gradebook/current", json={"title": "Period 2 - Renamed"}
    )
    assert update_response.json()["manifest"]["title"] == "Period 2 - Renamed"

    save_response = gradebook_client.post("/api/gradebook/save", json={})
    assert save_response.status_code == 200

    close_response = gradebook_client.post("/api/gradebook/close")
    assert close_response.status_code == 200

    after_close_response = gradebook_client.get("/api/gradebook/current")
    assert after_close_response.status_code == 400

    reopen_response = gradebook_client.post(
        "/api/gradebook/open", json={"path": str(destination)}
    )
    assert reopen_response.status_code == 200
    assert reopen_response.json()["manifest"]["title"] == "Period 2 - Renamed"


def test_roster_routes(gradebook_client, tmp_path: Path) -> None:
    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )

    create_response = gradebook_client.post(
        "/api/gradebook/students",
        json={"first_name": "Ada", "last_name": "Lovelace", "external_id": "S-100"},
    )
    assert create_response.status_code == 200
    student_id = create_response.json()["id"]

    list_response = gradebook_client.get("/api/gradebook/students")
    assert len(list_response.json()["items"]) == 1

    update_response = gradebook_client.put(
        f"/api/gradebook/students/{student_id}",
        json={"first_name": "Ada", "last_name": "Byron", "external_id": "S-100"},
    )
    assert update_response.json()["last_name"] == "Byron"

    delete_response = gradebook_client.delete(f"/api/gradebook/students/{student_id}")
    assert delete_response.status_code == 204
    assert gradebook_client.get("/api/gradebook/students").json()["items"] == []


def test_open_bank_and_gradebook_independently(gradebook_client, demo_bok: Path, tmp_path: Path) -> None:
    """A bank and a gradebook can be open at the same time, or either alone."""
    bank_response = gradebook_client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert bank_response.status_code == 200

    gradebook_response = gradebook_client.get("/api/gradebook/current")
    assert gradebook_response.status_code == 400  # no gradebook open yet, bank open is fine

    gradebook_client.post(
        "/api/gradebook/create",
        json={"title": "Period 2", "destination_path": str(tmp_path / "period-2.nxgb")},
    )
    assert gradebook_client.get("/api/gradebook/current").status_code == 200
    assert gradebook_client.get("/api/banks/current").status_code == 200
