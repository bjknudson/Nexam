"""The teacher's own drawing stamps ("My Stamps"). See docs/svg-editor-plan.md.

Stamps live in a plain folder on disk, shared by every bank, filed by what they
are rather than by how they arrived:

    Nexam Stamps/<Collection>/<Category>/<file>.svg
    Nexam Stamps/<Collection>/<Category>/<file>.stamp.json   (name, topics, ...)
    Nexam Stamps/.packs/<pack>-<time>/README.txt|stamps.json (provenance only)
    Nexam Stamps/.replaced/<time>/...                        (older versions)

Packs (zips of SVGs plus a ``stamps.json`` manifest or a README with
``Collection:`` / ``Category:`` / ``Topics:`` fields) are often small batches
of one larger set, so the pack name is never used as a heading. Importing is
two steps: ``preview_import`` reads everything into a review the teacher can
edit; ``commit_import`` files the chosen stamps. Built-in stamps ship with the
frontend and never touch this folder.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

from .models import (
    AddStampsResponseModel,
    StampImportCommitRequest,
    StampImportPreviewModel,
    StampImportResultModel,
    StampImportRowModel,
    StampListResponseModel,
    StampModel,
    StampPackInfoModel,
    StampRemovalResultModel,
)

DEFAULT_CATEGORY = "My stamps"
UNFILED_COLLECTION = "Unfiled"
MANIFEST_NAMES = {"stamps.json"}
README_NAMES = {"readme", "readme.txt", "readme.md"}


class StampLibraryError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def default_stamp_folder() -> Path:
    override = os.environ.get("NEXAM_STAMPS_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Documents" / "Nexam Stamps"


def safe_folder_name(name: str) -> str:
    """A collection/category name as a folder name filesystems accept."""
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", name).strip().strip(".")
    return cleaned or "Untitled"


def split_list(value: object) -> list[str]:
    """A list, or "a; b, c", as unique trimmed strings."""
    items = value if isinstance(value, list) else re.split(r"[;,]", value) if isinstance(value, str) else []
    seen: dict[str, str] = {}
    for item in items:
        text = str(item).strip()
        if text and text.lower() not in seen:
            seen[text.lower()] = text
    return list(seen.values())


def name_from_file(filename: str) -> str:
    stem = Path(filename).stem
    return stem.replace("-", " ").replace("_", " ").strip().capitalize() or stem


@dataclass
class PackInfo:
    name: str = ""
    description: str = ""
    notes: str = ""
    defaults: dict = field(default_factory=dict)
    # file name (lower case) -> per-stamp settings
    stamps: dict[str, dict] = field(default_factory=dict)
    # Original manifest/README to keep for provenance.
    originals: dict[str, bytes] = field(default_factory=dict)


@dataclass
class StagedImport:
    rows: dict[str, StampImportRowModel]
    contents: dict[str, bytes]
    packs: list[PackInfo]


def parse_manifest(data: bytes) -> PackInfo:
    try:
        manifest = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise StampLibraryError(f"stamps.json isn't valid JSON ({error}).") from error
    if not isinstance(manifest, dict):
        raise StampLibraryError("stamps.json should be a JSON object.")
    defaults = manifest.get("defaults") if isinstance(manifest.get("defaults"), dict) else {}
    stamps: dict[str, dict] = {}
    for entry in manifest.get("stamps") or []:
        if isinstance(entry, dict) and isinstance(entry.get("file"), str):
            stamps[PurePosixPath(entry["file"]).name.lower()] = entry
    conventions = manifest.get("conventions")
    notes = "\n".join(str(item) for item in conventions) if isinstance(conventions, list) else ""
    return PackInfo(
        name=str(manifest.get("pack") or ""),
        description=str(manifest.get("description") or ""),
        notes=notes,
        defaults=defaults,
        stamps=stamps,
    )


FIELD_LINE = re.compile(r"^\s*(collection|category|topics|tags)\s*:\s*(.+?)\s*$", re.IGNORECASE)
FILE_LINE = re.compile(r"^\s*[-*]\s*([^\s:]+\.svg)\s*(?::\s*(.*?))?\s*$", re.IGNORECASE)
OVERRIDES = re.compile(r"\[([^\]]*)\]\s*$")


def parse_readme(data: bytes) -> PackInfo:
    """The forgiving README fallback: first line is the pack name, `Key: value`
    fields set defaults, `- file.svg: description [category: X; topics: a, b]`
    lines describe stamps, and other sections are kept as notes."""
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    info = PackInfo()
    description: list[str] = []
    notes: list[str] = []
    seen_name = False
    in_intro = True
    for line in lines:
        stripped = line.strip()
        field_match = FIELD_LINE.match(line)
        file_match = FILE_LINE.match(line)
        if not seen_name:
            if stripped:
                info.name = stripped.lstrip("#").strip()
                seen_name = True
            continue
        if field_match:
            info.defaults[field_match.group(1).lower()] = field_match.group(2)
            continue
        if file_match:
            in_intro = False
            entry: dict = {"file": file_match.group(1)}
            rest = file_match.group(2) or ""
            override = OVERRIDES.search(rest)
            if override:
                rest = rest[: override.start()].strip()
                for part in override.group(1).split(";"):
                    key, _, value = part.partition(":")
                    if key.strip() and value.strip():
                        entry[key.strip().lower()] = value.strip()
            if rest:
                entry["description"] = rest
            info.stamps[PurePosixPath(entry["file"]).name.lower()] = entry
            continue
        if not stripped:
            if description:
                in_intro = False
            continue
        if in_intro and not stripped.endswith(":"):
            description.append(stripped)
        elif not re.match(r"^files\s*:$", stripped, re.IGNORECASE):
            in_intro = False
            notes.append(line.rstrip())
    info.description = " ".join(description)
    info.notes = "\n".join(notes).strip()
    return info


class StampLibrary:
    # Stamps are small diagrams; anything bigger is almost certainly not one.
    MAX_STAMP_BYTES = 512 * 1024
    MAX_PACK_FILES = 200
    MAX_PACK_BYTES = 20 * 1024 * 1024

    def __init__(self, folder: Path | None = None) -> None:
        self._folder = folder
        self._staged: dict[str, StagedImport] = {}

    @property
    def folder(self) -> Path:
        return self._folder if self._folder is not None else default_stamp_folder()

    # ------------------------------------------------------------------
    # Listing
    # ------------------------------------------------------------------

    def _stamp_files(self) -> list[Path]:
        folder = self.folder
        if not folder.is_dir():
            return []
        files = []
        for path in folder.rglob("*.svg"):
            relative = path.relative_to(folder)
            if any(part.startswith(".") for part in relative.parts):
                continue
            files.append(path)
        return sorted(files, key=lambda item: item.relative_to(folder).as_posix().lower())

    def list_stamps(self) -> StampListResponseModel:
        items = [stamp for path in self._stamp_files() if (stamp := self._read_stamp(path)) is not None]
        return StampListResponseModel(folder=str(self.folder), items=items)

    def collections(self) -> dict[str, list[str]]:
        found: dict[str, set[str]] = {}
        for stamp in self.list_stamps().items:
            if not stamp.unfiled:
                found.setdefault(stamp.collection, set()).add(stamp.category)
        return {name: sorted(categories) for name, categories in sorted(found.items())}

    def _read_sidecar(self, path: Path) -> dict:
        sidecar = path.with_name(f"{path.stem}.stamp.json")
        if not sidecar.is_file():
            return {}
        try:
            meta = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return meta if isinstance(meta, dict) else {}

    def _read_stamp(self, path: Path) -> StampModel | None:
        try:
            if path.stat().st_size > self.MAX_STAMP_BYTES:
                return None
            svg = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None
        relative = path.relative_to(self.folder)
        meta = self._read_sidecar(path)
        parts = relative.parts
        # A file moved by hand is listed by its sidecar if it has one, else its folders.
        collection = str(meta.get("collection") or (parts[0] if len(parts) >= 3 else parts[0] if len(parts) == 2 else ""))
        category = str(meta.get("category") or (parts[1] if len(parts) >= 3 else ""))
        unfiled = not collection
        if len(parts) == 2 and not meta.get("category"):
            category = DEFAULT_CATEGORY
        name = str(meta.get("name") or "").strip() or name_from_file(path.name)
        return StampModel(
            id=relative.as_posix(),
            name=name,
            collection=collection or UNFILED_COLLECTION,
            category=category or DEFAULT_CATEGORY,
            topics=split_list(meta.get("topics")),
            tags=split_list(meta.get("tags")),
            description=str(meta.get("description") or ""),
            source_pack=str(meta.get("source_pack") or ""),
            unfiled=unfiled,
            svg=svg,
        )

    # ------------------------------------------------------------------
    # Checking files
    # ------------------------------------------------------------------

    def _check_svg(self, filename: str, content: bytes) -> str | None:
        if Path(filename).suffix.lower() != ".svg":
            return "only .svg files can be stamps."
        if len(content) > self.MAX_STAMP_BYTES:
            return "this file is too large to be a stamp (over 512 KB)."
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            return "this file isn't readable text."
        # Entity declarations are how XML bombs work, and real drawings don't need them.
        if "<!ENTITY" in text:
            return "SVG files with entity declarations aren't supported."
        try:
            root = ElementTree.fromstring(text)
        except ElementTree.ParseError:
            return "this file isn't valid SVG."
        if root.tag.rsplit("}", 1)[-1] != "svg":
            return "this file isn't an SVG drawing."
        return None

    def _read_zip(self, filename: str, content: bytes) -> tuple[list[tuple[str, bytes]], PackInfo, list[str]]:
        """SVGs, pack info and problems from a zip, within safety limits."""
        problems: list[str] = []
        try:
            archive = zipfile.ZipFile(io.BytesIO(content))
        except zipfile.BadZipFile as error:
            raise StampLibraryError(f"{filename}: this isn't a readable zip file.") from error
        entries = [info for info in archive.infolist() if not info.is_dir()]
        if len(entries) > self.MAX_PACK_FILES:
            raise StampLibraryError(f"{filename}: too many files (over {self.MAX_PACK_FILES}).")
        if sum(info.file_size for info in entries) > self.MAX_PACK_BYTES:
            raise StampLibraryError(f"{filename}: too large once unpacked (over 20 MB).")

        # Allow one wrapper folder (zips made by "Compress folder" have one).
        tops = {PurePosixPath(info.filename).parts[0] for info in entries if len(PurePosixPath(info.filename).parts) > 1}
        loose = [info for info in entries if len(PurePosixPath(info.filename).parts) == 1]
        wrapper = next(iter(tops)) if len(tops) == 1 and not loose else None

        svgs: list[tuple[str, bytes]] = []
        manifest: bytes | None = None
        readme: tuple[str, bytes] | None = None
        for info in entries:
            path = PurePosixPath(info.filename)
            if path.is_absolute() or ".." in path.parts:
                problems.append(f"{info.filename}: skipped (unsafe path).")
                continue
            parts = path.parts[1:] if wrapper and path.parts[0] == wrapper else path.parts
            if not parts or parts[0] == "__MACOSX" or any(part.startswith(".") for part in parts):
                continue
            if len(parts) > 1:
                problems.append(f"{info.filename}: skipped (in a nested folder).")
                continue
            name = parts[0]
            data = archive.read(info)
            if name.lower() in MANIFEST_NAMES:
                manifest = data
            elif name.lower() in README_NAMES:
                readme = (name, data)
            elif name.lower().endswith(".svg"):
                svgs.append((name, data))
        pack = parse_manifest(manifest) if manifest is not None else parse_readme(readme[1]) if readme else PackInfo()
        if manifest is not None:
            pack.originals["stamps.json"] = manifest
            if readme:
                readme_info = parse_readme(readme[1])
                pack.notes = pack.notes or readme_info.notes
        if readme:
            pack.originals[readme[0]] = readme[1]
        if not pack.name:
            pack.name = Path(filename).stem
        return svgs, pack, problems

    # ------------------------------------------------------------------
    # Import: preview, then commit
    # ------------------------------------------------------------------

    def _canonical(self, value: str, existing: list[str]) -> str:
        """The library's spelling wins: "mechanics" files under "Mechanics"."""
        value = value.strip()
        return next((item for item in existing if item.lower() == value.lower()), value)

    def _status(self, collection: str, category: str, filename: str, content: bytes) -> str:
        if not collection or not category:
            return "new"
        target = self.folder / safe_folder_name(collection) / safe_folder_name(category) / filename
        if not target.is_file():
            return "new"
        same = hashlib.sha256(target.read_bytes()).hexdigest() == hashlib.sha256(content).hexdigest()
        return "duplicate" if same else "update"

    def _row(
        self,
        filename: str,
        content: bytes,
        pack: PackInfo | None,
        collections: dict[str, list[str]],
        move_from: str = "",
        meta: dict | None = None,
    ) -> StampImportRowModel:
        entry = (pack.stamps.get(filename.lower()) if pack else None) or {}
        defaults = pack.defaults if pack else {}
        meta = meta or {}

        def pick(key: str) -> object:
            # A stamp's own value wins even when empty, so "topics": [] opts
            # out of the pack's default topics.
            if key in entry:
                return entry[key] or ""
            return meta.get(key) or defaults.get(key) or ""

        collection = self._canonical(str(pick("collection")), list(collections))
        category = self._canonical(str(pick("category")), collections.get(collection, []))
        problem = self._check_svg(filename, content)
        row = StampImportRowModel(
            row_id=uuid.uuid4().hex,
            file=filename,
            name=str(entry.get("name") or meta.get("name") or "").strip() or name_from_file(filename),
            collection=collection,
            category=category,
            topics=split_list(pick("topics")),
            tags=split_list(pick("tags")),
            description=str(entry.get("description") or meta.get("description") or ""),
            source_pack=(pack.name if pack else str(meta.get("source_pack") or "")),
            move_from=move_from,
        )
        if problem:
            row.status, row.reason = "invalid", problem
        else:
            row.svg = content.decode("utf-8")
            row.status = self._status(collection, category, filename, content)
        return row

    def _stage(self, rows: list[StampImportRowModel], contents: dict[str, bytes], packs: list[PackInfo]) -> StampImportPreviewModel:
        token = uuid.uuid4().hex
        self._staged[token] = StagedImport({row.row_id: row for row in rows}, contents, packs)
        # Keep only a few recent reviews in memory.
        for old in list(self._staged)[:-5]:
            del self._staged[old]
        return StampImportPreviewModel(
            token=token,
            packs=[StampPackInfoModel(name=pack.name, description=pack.description, notes=pack.notes) for pack in packs],
            rows=rows,
            collections=self.collections(),
        )

    def preview_import(self, files: list[tuple[str, bytes]]) -> StampImportPreviewModel:
        """Reads SVGs and zip packs into a review; nothing is written yet."""
        if not files:
            raise StampLibraryError("Choose at least one SVG or zip file to add.")
        collections = self.collections()
        rows: list[StampImportRowModel] = []
        contents: dict[str, bytes] = {}
        packs: list[PackInfo] = []
        for filename, content in files:
            safe_name = Path(filename or "").name
            if safe_name.lower().endswith(".zip"):
                svgs, pack, problems = self._read_zip(safe_name, content)
                packs.append(pack)
                for name, data in svgs:
                    row = self._row(name, data, pack, collections)
                    rows.append(row)
                    contents[row.row_id] = data
                present = {name.lower() for name, _ in svgs}
                for listed, entry in pack.stamps.items():
                    if listed not in present:
                        rows.append(
                            StampImportRowModel(
                                row_id=uuid.uuid4().hex,
                                file=str(entry.get("file", listed)),
                                name=name_from_file(listed),
                                status="missing",
                                reason=f"listed in {pack.name or 'the pack'} but not in the zip.",
                            )
                        )
                for problem in problems:
                    rows.append(
                        StampImportRowModel(row_id=uuid.uuid4().hex, file=problem.split(":")[0], status="invalid", reason=problem)
                    )
            else:
                row = self._row(safe_name, content, None, collections)
                rows.append(row)
                contents[row.row_id] = content
        return self._stage(rows, contents, packs)

    def preview_unfiled(self) -> StampImportPreviewModel:
        """A review for loose stamps from before collections, so they can be filed."""
        rows: list[StampImportRowModel] = []
        contents: dict[str, bytes] = {}
        collections = self.collections()
        for path in self._stamp_files():
            stamp = self._read_stamp(path)
            if stamp is None or not stamp.unfiled:
                continue
            data = path.read_bytes()
            row = self._row(path.name, data, None, collections, move_from=stamp.id, meta=self._read_sidecar(path))
            # The sidecar's old "category" was a heading, not a filing; ask again.
            row.collection = ""
            row.category = ""
            row.status = "new"
            rows.append(row)
            contents[row.row_id] = data
        return self._stage(rows, contents, [])

    def commit_import(self, request: StampImportCommitRequest) -> StampImportResultModel:
        staged = self._staged.pop(request.token, None)
        if staged is None:
            raise StampLibraryError("This import review has expired. Choose the files again.", status_code=404)
        folder = self.folder
        stamp_time = datetime.now(timezone.utc)
        replaced_dir = folder / ".replaced" / stamp_time.strftime("%Y%m%d-%H%M%S")
        result = StampImportResultModel()
        collections = self.collections()

        for choice in request.rows:
            row = staged.rows.get(choice.row_id)
            content = staged.contents.get(choice.row_id)
            if row is None or content is None or row.status in {"invalid", "missing"} or not choice.include:
                if row is not None and row.status not in {"invalid", "missing"}:
                    result.skipped += 1
                continue
            collection = self._canonical(choice.collection, list(collections))
            category = self._canonical(choice.category, collections.get(collection, []))
            if not collection or not category:
                result.messages.append(f"{row.file}: skipped (no collection or category).")
                result.skipped += 1
                continue
            # Later rows in this import match the spelling of earlier ones.
            filed = collections.setdefault(collection, [])
            if category not in filed:
                filed.append(category)
            target_dir = folder / safe_folder_name(collection) / safe_folder_name(category)
            target = target_dir / row.file
            sha = hashlib.sha256(content).hexdigest()
            meta = {
                "name": choice.name.strip() or row.name,
                "collection": collection,
                "category": category,
                "topics": split_list(choice.topics),
                "tags": split_list(choice.tags),
                "description": choice.description.strip(),
                "source_pack": row.source_pack,
                "imported_at": stamp_time.isoformat(timespec="seconds"),
                "sha256": sha,
            }
            if target.is_file():
                if hashlib.sha256(target.read_bytes()).hexdigest() == sha:
                    # Same stamp again (e.g. in a later batch): add any new topics/tags.
                    existing = self._read_sidecar(target)
                    existing["topics"] = split_list([*split_list(existing.get("topics")), *meta["topics"]])
                    existing["tags"] = split_list([*split_list(existing.get("tags")), *meta["tags"]])
                    self._write_sidecar(target, {**meta, **existing})
                    result.merged += 1
                    self._retire_loose(row, folder, replaced_dir)
                    continue
                if choice.on_conflict == "skip":
                    result.skipped += 1
                    continue
                if choice.on_conflict == "keep_both":
                    target = target_dir / self._dedupe_name(target_dir, row.file)
                else:
                    self._move_aside(target, folder, replaced_dir)
                    result.updated += 1
            else:
                result.added += 1
            target_dir.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            self._write_sidecar(target, meta)
            if self._retire_loose(row, folder, replaced_dir):
                result.filed += 1
                result.added -= 1

        for pack in staged.packs:
            if pack.originals:
                pack_dir = folder / ".packs" / f"{safe_folder_name(pack.name or 'pack')}-{stamp_time.strftime('%Y%m%d-%H%M%S')}"
                pack_dir.mkdir(parents=True, exist_ok=True)
                for name, data in pack.originals.items():
                    (pack_dir / Path(name).name).write_bytes(data)
        return result

    def _write_sidecar(self, svg_path: Path, meta: dict) -> None:
        svg_path.with_name(f"{svg_path.stem}.stamp.json").write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    def _move_aside(self, path: Path, folder: Path, replaced_dir: Path) -> None:
        """Older versions are kept in .replaced/, never deleted."""
        destination = replaced_dir / path.relative_to(folder)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), destination)
        sidecar = path.with_name(f"{path.stem}.stamp.json")
        if sidecar.is_file():
            shutil.move(str(sidecar), destination.with_name(sidecar.name))

    def _retire_loose(self, row: StampImportRowModel, folder: Path, replaced_dir: Path) -> bool:
        """After filing a loose stamp, set the loose original aside."""
        if not row.move_from:
            return False
        original = folder / row.move_from
        if original.is_file() and original.resolve().is_relative_to(folder.resolve()):
            self._move_aside(original, folder, replaced_dir)
            return True
        return False

    # ------------------------------------------------------------------
    # Removing (recoverably) and restoring
    # ------------------------------------------------------------------

    def _stamp_path(self, stamp_id: str) -> Path | None:
        """The SVG for a stamp id, only if it is a stamp inside the folder."""
        folder = self.folder.resolve()
        relative = PurePosixPath(stamp_id)
        if relative.is_absolute() or ".." in relative.parts or any(part.startswith(".") for part in relative.parts):
            return None
        path = (folder / relative).resolve()
        if path.suffix.lower() != ".svg" or not path.is_relative_to(folder) or not path.is_file():
            return None
        return path

    def remove_stamps(self, ids: list[str]) -> StampRemovalResultModel:
        """Moves stamps (and their sidecars) to .removed/<id>/, keeping their
        place in the folder so restore_removal can put them back."""
        if not ids:
            raise StampLibraryError("Choose at least one stamp to remove.")
        folder = self.folder.resolve()
        removal_id = f"{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        removed_dir = folder / ".removed" / removal_id
        result = StampRemovalResultModel(removal_id=removal_id)
        emptied: set[Path] = set()
        for stamp_id in ids:
            path = self._stamp_path(stamp_id)
            if path is None:
                result.missing.append(stamp_id)
                continue
            self._move_aside(path, folder, removed_dir)
            emptied.add(path.parent)
            result.removed += 1
        # Tidy folders left empty (a removed category or collection).
        for directory in sorted(emptied, key=lambda item: len(item.parts), reverse=True):
            current = directory
            while current != folder and current.is_dir() and not any(current.iterdir()):
                current.rmdir()
                current = current.parent
        if result.removed == 0:
            result.removal_id = ""
        return result

    def restore_removal(self, removal_id: str) -> StampRemovalResultModel:
        if not re.fullmatch(r"[0-9A-Za-z-]+", removal_id or ""):
            raise StampLibraryError("That removal can't be found.", status_code=404)
        folder = self.folder.resolve()
        removed_dir = folder / ".removed" / removal_id
        if not removed_dir.is_dir():
            raise StampLibraryError("That removal can't be found.", status_code=404)
        result = StampRemovalResultModel(removal_id=removal_id)
        for path in sorted(removed_dir.rglob("*.svg")):
            relative = path.relative_to(removed_dir)
            target = folder / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                # Something new took its place since; keep both.
                target = target.parent / self._dedupe_name(target.parent, target.name)
            sidecar = path.with_name(f"{path.stem}.stamp.json")
            shutil.move(str(path), target)
            if sidecar.is_file():
                shutil.move(str(sidecar), target.with_name(f"{target.stem}.stamp.json"))
            result.removed += 1
        shutil.rmtree(removed_dir, ignore_errors=True)
        return result

    # ------------------------------------------------------------------
    # Adding single files straight into the folder (older endpoint)
    # ------------------------------------------------------------------

    def add_stamps(self, files: list[tuple[str, bytes]]) -> AddStampsResponseModel:
        """Copy SVG files into the folder unfiled. Kept for compatibility; the
        drawing tool now uses preview_import / commit_import."""
        if not files:
            raise StampLibraryError("Choose at least one SVG file to add.")
        folder = self.folder
        added: list[StampModel] = []
        errors: list[str] = []
        for filename, content in files:
            safe_name = Path(filename or "").name
            problem = self._check_svg(safe_name, content)
            if problem:
                errors.append(f"{safe_name or 'File'}: {problem}")
                continue
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / self._dedupe_name(folder, safe_name)
            target.write_bytes(content)
            stamp = self._read_stamp(target)
            if stamp is not None:
                added.append(stamp)
        return AddStampsResponseModel(folder=str(folder), added=added, errors=errors)

    @staticmethod
    def _dedupe_name(folder: Path, filename: str) -> str:
        candidate = filename
        stem = Path(filename).stem
        suffix = Path(filename).suffix
        counter = 1
        while (folder / candidate).exists():
            candidate = f"{stem}-{counter}{suffix}"
            counter += 1
        return candidate
