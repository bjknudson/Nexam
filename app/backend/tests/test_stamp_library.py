from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.backend import main
from app.backend.stamp_library import StampLibrary

PULLEY = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="15"/></svg>'


@pytest.fixture
def stamps_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    library = StampLibrary(tmp_path / "Nexam Stamps")
    monkeypatch.setattr(main, "stamp_library", library)
    with TestClient(main.app) as client:
        yield client, library.folder


def test_lists_nothing_before_the_folder_exists(stamps_client) -> None:
    client, folder = stamps_client
    response = client.get("/api/stamps")
    assert response.status_code == 200
    assert response.json() == {"folder": str(folder), "items": []}
    assert not folder.exists()


def test_adds_svg_files_and_lists_them_with_inferred_names(stamps_client) -> None:
    client, folder = stamps_client
    response = client.post(
        "/api/stamps",
        files=[
            ("files", ("incline-plane.svg", PULLEY, "image/svg+xml")),
            ("files", ("incline-plane.svg", PULLEY, "image/svg+xml")),
        ],
    )

    assert response.status_code == 200
    body = response.json()
    assert body["errors"] == []
    assert [stamp["id"] for stamp in body["added"]] == ["incline-plane.svg", "incline-plane-1.svg"]
    assert body["added"][0]["name"] == "Incline plane"
    assert body["added"][0]["category"] == "My stamps"
    assert (folder / "incline-plane.svg").read_bytes() == PULLEY

    listed = client.get("/api/stamps").json()["items"]
    assert [stamp["id"] for stamp in listed] == ["incline-plane-1.svg", "incline-plane.svg"]
    assert listed[1]["svg"] == PULLEY.decode()


def test_sidecar_names_and_categorizes_a_stamp(stamps_client) -> None:
    client, folder = stamps_client
    folder.mkdir(parents=True)
    (folder / "p1.svg").write_bytes(PULLEY)
    (folder / "p1.stamp.json").write_text(json.dumps({"name": "Fixed pulley", "category": "Mechanics"}))

    [stamp] = client.get("/api/stamps").json()["items"]

    assert (stamp["name"], stamp["category"]) == ("Fixed pulley", "Mechanics")


def test_rejects_files_that_are_not_svg_without_stopping_the_rest(stamps_client) -> None:
    client, folder = stamps_client
    bomb = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><svg>&a;</svg>'
    response = client.post(
        "/api/stamps",
        files=[
            ("files", ("notes.txt", b"hello", "text/plain")),
            ("files", ("page.svg", b"<html><body/></html>", "image/svg+xml")),
            ("files", ("broken.svg", b"<svg", "image/svg+xml")),
            ("files", ("bomb.svg", bomb, "image/svg+xml")),
            ("files", ("../escape.svg", PULLEY, "image/svg+xml")),
        ],
    )

    body = response.json()
    assert [stamp["id"] for stamp in body["added"]] == ["escape.svg"]
    assert len(body["errors"]) == 4
    assert body["errors"][0].startswith("notes.txt:")
    assert sorted(path.name for path in folder.iterdir()) == ["escape.svg"]


# ---------------------------------------------------------------------------
# Packs: preview, then commit
# ---------------------------------------------------------------------------

import io
import zipfile

from app.backend.stamp_library import parse_readme

DISK = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" stroke="currentColor" fill="none"/></svg>'
ARROW = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><line x1="0" y1="5" x2="40" y2="5" stroke="currentColor"/></svg>'

README = b"""Physics stamp batch 01
Derived as reusable components from the supplied collision/top-view reference.
Collection: Physics
Category: Mechanics
Topics: Collisions, Momentum

Files:
- disk.svg: outline disk/circle
- vector-arrow.svg: generic editable arrow [category: Vectors; topics: Vectors]
- motion-lines.svg: generic motion streaks

Conventions:
- Uses currentColor for stroke/fill where practical
"""


def make_zip(files: dict[str, bytes], wrapper: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in files.items():
            archive.writestr(f"{wrapper}/{name}" if wrapper else name, data)
    return buffer.getvalue()


def preview(client, files):
    response = client.post("/api/stamps/import/preview", files=[("files", file) for file in files])
    assert response.status_code == 200, response.text
    return response.json()


def commit(client, review, overrides=None):
    rows = []
    for row in review["rows"]:
        if row["status"] in {"invalid", "missing"}:
            continue
        choice = {key: row[key] for key in ("row_id", "name", "collection", "category", "topics", "tags", "description")}
        choice.update((overrides or {}).get(row["file"], {}))
        rows.append(choice)
    response = client.post("/api/stamps/import/commit", json={"token": review["token"], "rows": rows})
    assert response.status_code == 200, response.text
    return response.json()


def test_readme_fields_file_lines_and_notes() -> None:
    info = parse_readme(README)
    assert info.name == "Physics stamp batch 01"
    assert info.description.startswith("Derived as reusable")
    assert info.defaults == {"collection": "Physics", "category": "Mechanics", "topics": "Collisions, Momentum"}
    assert info.stamps["vector-arrow.svg"] == {
        "file": "vector-arrow.svg",
        "description": "generic editable arrow",
        "category": "Vectors",
        "topics": "Vectors",
    }
    assert "currentColor" in info.notes


def test_pack_is_filed_by_collection_and_category_not_pack_name(stamps_client) -> None:
    client, folder = stamps_client
    pack = make_zip({"README.txt": README, "disk.svg": DISK, "vector-arrow.svg": ARROW}, wrapper="batch-01")
    review = preview(client, [("batch-01.zip", pack, "application/zip")])

    assert review["packs"][0]["name"] == "Physics stamp batch 01"
    rows = {row["file"]: row for row in review["rows"]}
    assert rows["disk.svg"]["collection"] == "Physics"
    assert rows["disk.svg"]["category"] == "Mechanics"
    assert rows["disk.svg"]["topics"] == ["Collisions", "Momentum"]
    assert rows["vector-arrow.svg"]["category"] == "Vectors"
    assert rows["motion-lines.svg"]["status"] == "missing"

    result = commit(client, review)
    assert result["added"] == 2
    assert (folder / "Physics" / "Mechanics" / "disk.svg").read_bytes() == DISK
    sidecar = json.loads((folder / "Physics" / "Mechanics" / "disk.stamp.json").read_text())
    assert sidecar["source_pack"] == "Physics stamp batch 01"
    assert sidecar["description"] == "outline disk/circle"
    assert any((folder / ".packs").iterdir())

    listed = {stamp["id"]: stamp for stamp in client.get("/api/stamps").json()["items"]}
    assert listed["Physics/Vectors/vector-arrow.svg"]["collection"] == "Physics"
    assert listed["Physics/Mechanics/disk.svg"]["topics"] == ["Collisions", "Momentum"]


def test_a_later_batch_merges_into_the_same_collections(stamps_client) -> None:
    client, folder = stamps_client
    manifest = json.dumps(
        {
            "format": "nexam-stamp-pack/1",
            "pack": "Physics stamp batch 01",
            "defaults": {"collection": "Physics", "category": "Mechanics", "topics": ["Collisions"]},
            "stamps": [{"file": "disk.svg", "name": "Disk"}],
        }
    ).encode()
    commit(client, preview(client, [("b1.zip", make_zip({"stamps.json": manifest, "disk.svg": DISK}), "application/zip")]))

    # Batch 02: same disk with an extra topic and lower-case spelling, plus a changed arrow.
    manifest2 = json.dumps(
        {
            "pack": "Physics stamp batch 02",
            "defaults": {"collection": "physics", "category": "mechanics", "topics": ["Momentum"]},
            "stamps": [{"file": "disk.svg"}, {"file": "arrow.svg"}],
        }
    ).encode()
    review = preview(client, [("b2.zip", make_zip({"stamps.json": manifest2, "disk.svg": DISK, "arrow.svg": ARROW}), "application/zip")])
    rows = {row["file"]: row for row in review["rows"]}
    assert rows["disk.svg"]["collection"] == "Physics"  # the library's spelling wins
    assert rows["disk.svg"]["status"] == "duplicate"
    assert rows["arrow.svg"]["status"] == "new"
    result = commit(client, review)
    assert result["merged"] == 1 and result["added"] == 1
    disk = json.loads((folder / "Physics" / "Mechanics" / "disk.stamp.json").read_text())
    assert disk["topics"] == ["Collisions", "Momentum"]

    # An updated arrow replaces the old one, which is kept in .replaced/.
    changed = ARROW.replace(b'y1="5"', b'y1="6"')
    review = preview(client, [("b3.zip", make_zip({"stamps.json": manifest2, "arrow.svg": changed}), "application/zip")])
    assert {row["file"]: row["status"] for row in review["rows"]}["arrow.svg"] == "update"
    assert commit(client, review)["updated"] == 1
    assert (folder / "Physics" / "Mechanics" / "arrow.svg").read_bytes() == changed
    assert list((folder / ".replaced").rglob("arrow.svg"))


def test_single_files_need_filing_and_keep_both_on_conflict(stamps_client) -> None:
    client, folder = stamps_client
    review = preview(client, [("disk.svg", DISK, "image/svg+xml")])
    assert review["rows"][0]["collection"] == ""
    result = commit(client, review)
    assert result["skipped"] == 1 and "no collection" in result["messages"][0]

    review = preview(client, [("disk.svg", DISK, "image/svg+xml")])
    commit(client, review, {"disk.svg": {"collection": "Physics", "category": "Shapes"}})
    review = preview(client, [("disk.svg", ARROW, "image/svg+xml")])
    commit(client, review, {"disk.svg": {"collection": "Physics", "category": "Shapes", "on_conflict": "keep_both"}})
    assert sorted(path.name for path in (folder / "Physics" / "Shapes").glob("*.svg")) == ["disk-1.svg", "disk.svg"]


def test_unfiled_stamps_can_be_filed(stamps_client) -> None:
    client, folder = stamps_client
    client.post("/api/stamps", files=[("files", ("old.svg", DISK, "image/svg+xml"))])
    [stamp] = client.get("/api/stamps").json()["items"]
    assert stamp["unfiled"] is True and stamp["collection"] == "Unfiled"

    review = client.post("/api/stamps/import/unfiled").json()
    assert review["rows"][0]["move_from"] == "old.svg"
    result = commit(client, review, {"old.svg": {"collection": "Physics", "category": "Mechanics"}})
    assert result["filed"] == 1
    [stamp] = client.get("/api/stamps").json()["items"]
    assert stamp["id"] == "Physics/Mechanics/old.svg" and stamp["unfiled"] is False


def test_zip_safety(stamps_client) -> None:
    client, _ = stamps_client
    bad = make_zip({"../escape.svg": DISK, "nested/deep/x.svg": DISK, "__MACOSX/._disk.svg": b"junk", "ok.svg": DISK})
    review = preview(client, [("bad.zip", bad, "application/zip")])
    statuses = {row["file"]: row["status"] for row in review["rows"]}
    assert statuses["ok.svg"] == "new"
    assert all(status == "invalid" for name, status in statuses.items() if name != "ok.svg")
    assert client.post("/api/stamps/import/preview", files=[("files", ("x.zip", b"not a zip", "application/zip"))]).status_code == 400


def test_spelling_matches_rows_filed_earlier_in_the_same_import(stamps_client) -> None:
    client, folder = stamps_client
    review = preview(client, [("a.svg", DISK, "image/svg+xml"), ("b.svg", ARROW, "image/svg+xml")])
    commit(
        client,
        review,
        {
            "a.svg": {"collection": "Physics", "category": "Mechanics"},
            "b.svg": {"collection": "physics", "category": "mechanics"},
        },
    )
    listed = {stamp["id"]: stamp for stamp in client.get("/api/stamps").json()["items"]}
    assert listed["Physics/Mechanics/b.svg"]["collection"] == "Physics"
    assert listed["Physics/Mechanics/b.svg"]["category"] == "Mechanics"


# ---------------------------------------------------------------------------
# The pack template in docs/stamp-packs/ must stay importable as documented.
# ---------------------------------------------------------------------------

DOCS = Path(__file__).resolve().parents[3] / "docs" / "stamp-packs"


def test_documented_example_pack_imports_fully_filed(stamps_client) -> None:
    client, folder = stamps_client
    manifest = (DOCS / "stamps.example.json").read_bytes()
    files = {entry["file"]: DISK for entry in json.loads(manifest)["stamps"]}
    review = preview(client, [("batch.zip", make_zip({"stamps.json": manifest, **files}), "application/zip")])

    rows = {row["file"]: row for row in review["rows"]}
    assert set(rows) == set(files)
    assert all(row["status"] == "new" and row["collection"] and row["category"] for row in rows.values())
    # Per-stamp fields replace the defaults; an empty list means none.
    assert rows["vector-arrow.svg"]["category"] == "Vectors"
    assert rows["vector-arrow.svg"]["topics"] == ["Vectors", "Collisions", "Momentum"]
    assert rows["vector-arrow.svg"]["tags"] == []
    assert rows["disk.svg"]["topics"] == ["Collisions", "Momentum"]
    assert rows["disk-filled-light.svg"]["name"] == "Disk (light fill)"

    result = commit(client, review)
    assert result["added"] == len(files)
    assert (folder / "Physics" / "Guides" / "dashed-guide.svg").is_file()


def test_documented_readme_template_shape_parses() -> None:
    filled = (DOCS / "README.template.txt").read_text().replace("<", "").replace(">", "")
    info = parse_readme(filled.encode())
    assert set(info.defaults) == {"collection", "category", "topics", "tags"}
    assert len(info.stamps) == 2
    assert "category" in next(entry for entry in info.stamps.values() if "category" in entry)


def test_documented_example_matches_the_schema() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((DOCS / "stamps.schema.json").read_text())
    jsonschema.validate(json.loads((DOCS / "stamps.example.json").read_text()), schema)


def test_removing_stamps_sets_them_aside_and_undo_restores_them(stamps_client) -> None:
    client, folder = stamps_client
    review = preview(client, [("a.svg", DISK, "image/svg+xml"), ("b.svg", ARROW, "image/svg+xml")])
    commit(
        client,
        review,
        {
            "a.svg": {"collection": "Physics", "category": "Shapes", "topics": ["Collisions"]},
            "b.svg": {"collection": "Physics", "category": "Vectors"},
        },
    )

    removed = client.post("/api/stamps/remove", json={"ids": ["Physics/Vectors/b.svg", "../escape.svg", "Physics/x.svg"]}).json()
    assert removed["removed"] == 1
    assert removed["missing"] == ["../escape.svg", "Physics/x.svg"]
    assert [stamp["id"] for stamp in client.get("/api/stamps").json()["items"]] == ["Physics/Shapes/a.svg"]
    # The emptied category folder is tidied away; the file is kept aside, not deleted.
    assert not (folder / "Physics" / "Vectors").exists()
    assert list((folder / ".removed").rglob("b.svg"))

    restored = client.post("/api/stamps/restore", json={"removal_id": removed["removal_id"]}).json()
    assert restored["removed"] == 1
    ids = [stamp["id"] for stamp in client.get("/api/stamps").json()["items"]]
    assert ids == ["Physics/Shapes/a.svg", "Physics/Vectors/b.svg"]
    assert client.post("/api/stamps/restore", json={"removal_id": "../../etc"}).status_code == 404


def test_removed_stamps_keep_their_sidecars(stamps_client) -> None:
    client, folder = stamps_client
    commit(client, preview(client, [("a.svg", DISK, "image/svg+xml")]), {"a.svg": {"collection": "Physics", "category": "Shapes", "topics": ["Optics"]}})
    removal = client.post("/api/stamps/remove", json={"ids": ["Physics/Shapes/a.svg"]}).json()
    client.post("/api/stamps/restore", json={"removal_id": removal["removal_id"]})
    [stamp] = client.get("/api/stamps").json()["items"]
    assert stamp["topics"] == ["Optics"]
