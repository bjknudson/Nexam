"""What an SVG asset is about, for searching and previewing the bank's assets.

Drawings made in Nexam's drawing tool carry useful words that aren't in the
file name: stamp names (``data-nexam-stamp``), labels, variable names, and the
topics/tags a teacher gives the drawing (``data-nexam-topics`` /
``data-nexam-tags`` on the root, separated by ``;``). The tool also records the
preview values it was last saved with (``data-nexam-preview="a=1; b=x"``), so
thumbnails can show a drawing rather than ``{{placeholders}}``.
See "Asset search" and "Topics and tags on assets" in docs/svg-editor-plan.md.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree

from .svg_variables import read_declarations

PLACEHOLDER = re.compile(r"\{\{[^{}]*\}\}")
WORD_SPLIT = re.compile(r"[^\w'’-]+", re.UNICODE)
MAX_TERMS = 200

# Elements whose text is worth searching.
TEXT_TAGS = {"text", "tspan", "title", "desc"}
# Attributes whose values describe the drawing.
DESCRIPTIVE_ATTRS = (
    "data-nexam-stamp",
    "data-nexam-stamp-category",
    "data-nexam-stamp-topics",
    "data-variable",
    "data-angle-variable",
    "data-label",
    "data-nexam-control",
    "data-nexam-shape",
)


@dataclass
class SvgSummary:
    search_terms: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    preview_values: dict[str, str] = field(default_factory=dict)


def split_list(value: str | None) -> list[str]:
    """"Forces; Newton's Laws" -> ["Forces", "Newton's Laws"]."""
    if not value:
        return []
    seen: dict[str, None] = {}
    for item in value.split(";"):
        item = item.strip()
        if item and item.lower() not in {existing.lower() for existing in seen}:
            seen[item] = None
    return list(seen)


def parse_preview(value: str | None) -> dict[str, str]:
    """"arrow_length=40; force=12 N" -> {"arrow_length": "40", "force": "12 N"}."""
    values: dict[str, str] = {}
    for part in (value or "").split(";"):
        name, separator, raw = part.partition("=")
        name = name.strip()
        if separator and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            values[name] = raw.strip()
    return values


def plain_math(text: str) -> str:
    """"$\\vec{F}_g$ = {{force}}" -> "F g =": LaTeX markup removed for searching."""
    text = PLACEHOLDER.sub(" ", text)
    text = re.sub(r"\\[A-Za-z]+", " ", text)
    return re.sub(r"[$_^{}\\]", " ", text)


def summarize_svg(source: str) -> SvgSummary:
    # Entity declarations are how XML bombs work; real drawings don't use them.
    if "<!ENTITY" in source:
        return SvgSummary()
    try:
        root = ElementTree.fromstring(source)
    except ElementTree.ParseError:
        return SvgSummary()

    terms: dict[str, None] = {}
    # Math text keeps its typed source in data-nexam-tex; index that (cleaned)
    # as one phrase instead of the generated <tspan> fragments.
    skip: set[int] = set()
    for element in root.iter():
        if element.get("data-nexam-tex") is not None:
            skip.update(id(child) for child in element.iter())

    def add(text: str | None) -> None:
        if not text:
            return
        cleaned = PLACEHOLDER.sub(" ", text).replace("-", " ").replace("_", " ")
        phrase = " ".join(cleaned.split())
        if phrase and len(terms) < MAX_TERMS:
            terms.setdefault(phrase, None)

    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1] if isinstance(element.tag, str) else ""
        tex = element.get("data-nexam-tex")
        if tex is not None:
            add(plain_math(tex))
        elif tag in TEXT_TAGS and id(element) not in skip:
            add(element.text)
        for name in DESCRIPTIVE_ATTRS:
            value = element.get(name)
            if name == "data-nexam-shape" and value in {"arrow", "line"}:
                add(value)
            elif name == "data-nexam-control" and value:
                add(value.replace("-", " "))
            elif name == "data-nexam-stamp-topics":
                for topic in split_list(value):
                    add(topic)
            elif name == "data-label" and value:
                add(plain_math(value))
            elif value:
                add(value)

    # Declared variables (svg_variables.py): their names and labels, so
    # "applied force" finds a drawing driven by it.
    for item in read_declarations(source):
        add(str(item["name"]))
        if isinstance(item.get("label"), str):
            add(item["label"])

    topics = split_list(root.get("data-nexam-topics"))
    tags = split_list(root.get("data-nexam-tags"))
    for item in [*topics, *tags]:
        add(item)
    return SvgSummary(
        search_terms=list(terms),
        topics=topics,
        tags=tags,
        preview_values=parse_preview(root.get("data-nexam-preview")),
    )


class SvgSummaryCache:
    """Summaries keyed by file content, so listing a large bank doesn't
    re-parse every drawing each time the asset list refreshes.

    Reading a file and hashing it is cheap next to parsing it. The content is
    the key, not the modification time and size: a quick edit that keeps the
    size (e.g. renaming "Pulley" to "Spring") can leave the time unchanged on
    some file systems, which would serve the old summary."""

    def __init__(self) -> None:
        self._entries: dict[Path, tuple[str, SvgSummary]] = {}

    def get(self, path: Path) -> SvgSummary:
        try:
            data = path.read_bytes()
        except OSError:
            return SvgSummary()
        digest = hashlib.sha256(data).hexdigest()
        cached = self._entries.get(path)
        if cached and cached[0] == digest:
            return cached[1]
        try:
            summary = summarize_svg(data.decode("utf-8"))
        except UnicodeDecodeError:
            summary = SvgSummary()
        self._entries[path] = (digest, summary)
        return summary
