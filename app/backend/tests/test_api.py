from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient


def test_healthcheck(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_api_accepts_question_json_updates(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    question_response = client.get("/api/questions/q_sa_0001")
    assert question_response.status_code == 200
    payload = question_response.json()
    payload["prompt"] = "State Ohm's law using one sentence and one equation."
    payload["tags"] = ["circuits", "raw-json"]

    update_response = client.put("/api/questions/q_sa_0001", json=payload)

    assert update_response.status_code == 200
    assert update_response.json()["prompt"] == "State Ohm's law using one sentence and one equation."

    list_response = client.get("/api/questions", params={"search": "raw-json"})
    assert list_response.status_code == 200
    assert [item["id"] for item in list_response.json()["items"]] == ["q_sa_0001"]


def test_api_creates_question_from_json_with_automatic_id(
    client: TestClient,
    demo_bok: Path,
) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    question_response = client.get("/api/questions/q_sa_0001")
    payload = question_response.json()
    payload.pop("id")
    payload["prompt"] = "AI-generated short answer JSON can be added as a new question."

    create_response = client.post("/api/questions/from-json", json=payload)

    assert create_response.status_code == 200
    assert create_response.json()["id"] == "q_sa_0011"

    list_response = client.get("/api/questions", params={"search": "AI-generated"})
    assert list_response.status_code == 200
    assert [item["id"] for item in list_response.json()["items"]] == ["q_sa_0011"]


def test_api_returns_next_question_id_for_type(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    response = client.get("/api/questions/next-id", params={"type": "numeric_response"})

    assert response.status_code == 200
    assert response.json() == {"id": "q_num_0008"}


def test_api_rejects_invalid_question_json(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    question_response = client.get("/api/questions/q_sa_0001")
    payload = question_response.json()
    payload["sample_solution"] = ""

    update_response = client.put("/api/questions/q_sa_0001", json=payload)

    assert update_response.status_code == 422
    assert "short_answer questions need a sample_solution" in str(update_response.json()["detail"])


def test_api_stages_question_json_import(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    question_response = client.get("/api/questions/q_num_0001")
    payload = question_response.json()
    payload.pop("id")
    payload["prompt"] = "Question import JSON can be staged before promotion."

    stage_response = client.post(
        "/api/question-imports/stage",
        files={
            "file": (
                "questions.json",
                json.dumps({"questions": [payload]}),
                "application/json",
            )
        },
    )

    assert stage_response.status_code == 200
    stage = stage_response.json()
    assert stage["rows"][0]["status"] == "valid"
    assert stage["rows"][0]["proposed_id"] == "q_num_0008"

    list_response = client.get("/api/question-imports")
    assert list_response.status_code == 200
    assert [item["id"] for item in list_response.json()["items"]] == [stage["id"]]


def test_api_stages_question_csv_import(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    csv_content = "\n".join(
        [
            "id,type,topic,difficulty,prompt,sample_solution",
            ",short_answer,Waves,2,Define amplitude.,Amplitude is maximum displacement.",
        ]
    )

    stage_response = client.post(
        "/api/question-imports/stage",
        files={
            "file": (
                "questions.csv",
                csv_content,
                "text/csv",
            )
        },
    )

    assert stage_response.status_code == 200
    stage = stage_response.json()
    assert stage["source_filename"] == "questions.csv"
    assert stage["rows"][0]["status"] == "valid"
    assert stage["rows"][0]["proposed_id"] == "q_sa_0011"


def test_api_promotes_staged_question_import(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    question_response = client.get("/api/questions/q_sa_0001")
    payload = question_response.json()
    payload.pop("id")
    payload["prompt"] = "API promotion writes staged rows to questions."

    stage_response = client.post(
        "/api/question-imports/stage",
        files={
            "file": (
                "questions.json",
                json.dumps([payload]),
                "application/json",
            )
        },
    )
    assert stage_response.status_code == 200
    stage = stage_response.json()

    promote_response = client.post(
        f"/api/question-imports/{stage['id']}/promote",
        json={"row_ids": [stage["rows"][0]["row_id"]], "id_policy": "auto"},
    )

    assert promote_response.status_code == 200
    promoted = promote_response.json()
    assert promoted["promoted_question_ids"] == ["q_sa_0011"]
    assert promoted["stage"]["rows"][0]["status"] == "promoted"

    question_after_response = client.get("/api/questions/q_sa_0011")
    assert question_after_response.status_code == 200
    assert question_after_response.json()["prompt"] == "API promotion writes staged rows to questions."


def test_api_updates_staged_question_import_row(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    question_response = client.get("/api/questions/q_sa_0001")
    payload = question_response.json()
    payload.pop("id")
    payload["sample_solution"] = ""

    stage_response = client.post(
        "/api/question-imports/stage",
        files={
            "file": (
                "invalid.json",
                json.dumps([payload]),
                "application/json",
            )
        },
    )
    stage = stage_response.json()
    assert stage["rows"][0]["status"] == "invalid"

    payload["sample_solution"] = "Ohm's law is V = IR."
    update_response = client.put(
        f"/api/question-imports/{stage['id']}/rows/{stage['rows'][0]['row_id']}",
        json={"question": payload},
    )

    assert update_response.status_code == 200
    updated_stage = update_response.json()
    assert updated_stage["rows"][0]["status"] == "valid"
    assert updated_stage["rows"][0]["selected"] is True
    assert updated_stage["rows"][0]["issues"] == []


def test_api_creates_standards_manually(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    create_response = client.post(
        "/api/standards/manual",
        json={
            "source_list_id": "hand-entered-2026",
            "title": "Hand Entered Standards",
            "issuer": "Classroom Teacher",
            "subject": "Physics",
            "standards": [
                {
                    "id": "HAND-01",
                    "statement": "Describe the relationship between force and acceleration.",
                    "tags": ["forces"],
                },
                {
                    "id": "HAND-02",
                    "code": "HAND-2",
                    "statement": "Interpret a position versus time graph.",
                    "grade_band": "9-12",
                    "tags": [],
                },
            ],
        },
    )

    assert create_response.status_code == 200
    created = create_response.json()
    assert created["imported_count"] == 2
    assert created["source_list"]["id"] == "hand-entered-2026"

    list_response = client.get("/api/standards", params={"source_list_id": "hand-entered-2026"})
    assert list_response.status_code == 200
    items = {item["id"]: item for item in list_response.json()["items"]}
    assert set(items) == {"HAND-01", "HAND-02"}
    assert items["HAND-01"]["code"] == "HAND-01"
    assert items["HAND-01"]["subject"] == "Physics"
    assert items["HAND-02"]["code"] == "HAND-2"


def test_api_rejects_manual_standards_with_duplicate_id(client: TestClient, demo_bok: Path) -> None:
    open_response = client.post("/api/banks/open", json={"path": str(demo_bok)})
    assert open_response.status_code == 200

    response = client.post(
        "/api/standards/manual",
        json={
            "source_list_id": "physics-core-2026",
            "standards": [
                {"id": "PHY-KIN-01", "statement": "Duplicate of a saved standard.", "tags": []}
            ],
        },
    )

    assert response.status_code == 409
    assert "PHY-KIN-01" in response.json()["detail"]


def test_api_health_reports_version_and_build(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["build"] == "source"
    # A real version, not the "unknown" fallback the frontend stays quiet on.
    assert payload["version"] != "unknown"
    assert payload["version"].count(".") == 2


def test_api_exposes_course_detail_and_test_course_assignment(
    client: TestClient, demo_bok: Path
) -> None:
    assert client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200

    created = client.post(
        "/api/tests",
        json={"title": "Course API Test", "version": "A", "course_ids": ["physics-1"]},
    )
    assert created.status_code == 200
    test_id = created.json()["test"]["id"]
    assert created.json()["test"]["course_ids"] == ["physics-1"]

    detail = client.get("/api/courses/physics-1")
    assert detail.status_code == 200
    payload = detail.json()
    assert test_id in [item["test_id"] for item in payload["tests"]]
    assert payload["uncovered_standards"]

    reassigned = client.put(
        f"/api/tests/{test_id}/courses",
        json={"course_ids": ["physics-1", "chemistry-1"]},
    )
    assert reassigned.status_code == 200
    assert reassigned.json()["test"]["course_ids"] == ["physics-1", "chemistry-1"]

    assert client.delete("/api/courses/chemistry-1").status_code == 204
    assert client.get("/api/courses/chemistry-1").status_code == 404
    assert client.get(f"/api/tests/{test_id}").json()["test"]["course_ids"] == ["physics-1"]


def test_api_inspects_a_standards_import_before_asking_for_a_source(
    client: TestClient, demo_bok: Path
) -> None:
    assert client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200

    response = client.post(
        "/api/standards/import/inspect",
        files={"file": ("silent.csv", b"id,code,statement\nZ-01,Z-01,Something.\n", "text/csv")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_rows"] == 1
    assert payload["needs_source_input"] is True


def test_api_lists_standards_by_strand(client: TestClient, demo_bok: Path) -> None:
    assert client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200

    created = client.post(
        "/api/standards/manual",
        json={
            "standards": [
                {
                    "id": "API-STRAND-01",
                    "statement": "Filed under its own new source.",
                    "strand": "Number Sense",
                    "tags": [],
                    "source_list_id": "api-source-2026",
                    "source_title": "API Source",
                    "source_issuer": "Local District",
                }
            ]
        },
    )
    assert created.status_code == 200
    assert created.json()["source_list"]["id"] == "api-source-2026"

    assert "Number Sense" in client.get("/api/standards/strands").json()["items"]
    filtered = client.get("/api/standards", params={"strand": "Number Sense"})
    assert [item["id"] for item in filtered.json()["items"]] == ["API-STRAND-01"]


def test_api_seeds_a_new_course_from_an_existing_one(
    client: TestClient, demo_bok: Path
) -> None:
    assert client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200
    shared = client.post(
        "/api/tests", json={"title": "Unit 1", "version": "A", "course_ids": ["physics-1"]}
    )
    assert shared.status_code == 200
    shared_id = shared.json()["test"]["id"]

    assert (
        client.put(
            "/api/courses/physics-1-2027",
            json={"title": "Physics 1 (2027)", "description": None, "standard_refs": []},
        ).status_code
        == 200
    )

    response = client.post(
        "/api/courses/physics-1-2027/seed",
        json={"source_course_id": "physics-1", "include_standards": True, "include_tests": True},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["course"]["standard_refs"]
    assert shared_id in [item["test_id"] for item in payload["tests"]]
    assert client.get(f"/api/tests/{shared_id}").json()["test"]["course_ids"] == [
        "physics-1",
        "physics-1-2027",
    ]


def test_api_rejects_seeding_a_course_from_itself(client: TestClient, demo_bok: Path) -> None:
    assert client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200

    response = client.post(
        "/api/courses/physics-1/seed", json={"source_course_id": "physics-1"}
    )

    assert response.status_code == 400


def test_api_copies_a_shared_test_and_restores_the_original(
    client: TestClient, demo_bok: Path
) -> None:
    assert client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200
    created = client.post(
        "/api/tests",
        json={"title": "Unit 1", "version": "A", "course_ids": ["physics-1", "algebra-1"]},
    )
    test_id = created.json()["test"]["id"]
    snapshot = client.get(f"/api/tests/{test_id}").json()["test"]

    edited = client.post(f"/api/tests/{test_id}/items", json={"question_id": "q_fr_0001"})
    assert edited.status_code == 200

    response = client.post(
        f"/api/tests/{test_id}/copy",
        json={
            "title": "Unit 1 (2027)",
            "course_ids": ["algebra-1"],
            "detach_courses_from_source": True,
            "source_restore": snapshot,
        },
    )

    assert response.status_code == 200
    copy = response.json()["test"]
    assert copy["id"] != test_id
    assert copy["course_ids"] == ["algebra-1"]
    assert [item["question_id"] for item in copy["items"]] == ["q_fr_0001"]

    original = client.get(f"/api/tests/{test_id}").json()["test"]
    assert original["items"] == []
    assert original["course_ids"] == ["physics-1"]
