"""A drawing's declared variables, kept in the SVG itself:

    <metadata id="nexam-variables">{"variables": [
      {"name": "force", "label": "Force", "units": "N", "sample": "40"},
      {"name": "Fx", "formula": "force * cos(angle)", "units": "N",
       "show": {"kind": "decimals", "places": 1}}
    ]}</metadata>

Inputs (no formula) are the values a question supplies. Derived variables
(with a formula) are worked out from the inputs, and earlier derived ones,
whenever the drawing renders, so a question never sets them. "show" is
optional: decimals or significant figures, keeping trailing zeros.
See "Question-driven variables" in docs/svg-editor-plan.md.
"""

from __future__ import annotations

import html
import json
import math
import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

VARIABLES_BLOCK = re.compile(r'<metadata\b[^>]*\bid="nexam-variables"[^>]*>(.*?)</metadata>', re.S)
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_PLACES = 10


@dataclass(frozen=True)
class Derived:
    name: str
    formula: str
    show_kind: str | None = None  # "decimals" or "sig"
    places: int = 0


def read_declarations(source: str) -> list[dict]:
    """The declared variables, or [] when there are none or the block can't be read."""
    match = VARIABLES_BLOCK.search(source)
    if not match:
        return []
    try:
        data = json.loads(html.unescape(match.group(1)))
    except (ValueError, TypeError):
        return []
    items = data.get("variables") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and NAME.match(str(item.get("name", "")))]


def derived_variables(source: str) -> list[Derived]:
    derived: list[Derived] = []
    for item in read_declarations(source):
        formula = item.get("formula")
        if not isinstance(formula, str) or not formula.strip():
            continue
        show = item.get("show") if isinstance(item.get("show"), dict) else {}
        kind = show.get("kind") if show.get("kind") in ("decimals", "sig") else None
        try:
            places = max(0, min(MAX_PLACES, int(show.get("places", 0))))
        except (TypeError, ValueError):
            places = 0
        if kind == "sig":
            places = max(1, places)
        derived.append(Derived(name=str(item["name"]), formula=formula.strip(), show_kind=kind, places=places))
    return derived


def _half_up(value: float, decimals: int) -> Decimal:
    # Half away from zero (2.5 -> 3, -2.5 -> -3), as people round by hand;
    # str() first so 1.005 is treated as typed, not as its binary neighbour.
    return Decimal(str(value)).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def round_to(value: float, places: int) -> float:
    return float(_half_up(value, max(0, places)))


def sig_decimals(value: float, figures: int) -> int:
    """Decimal places that leave `figures` significant figures (may be negative)."""
    if value == 0 or not math.isfinite(value):
        return figures - 1
    return figures - 1 - math.floor(math.log10(abs(value)))


def round_sig(value: float, figures: int) -> float:
    figures = max(1, figures)
    decimals = sig_decimals(value, figures)
    if decimals >= 0:
        return float(_half_up(value, decimals))
    step = Decimal(10) ** (-decimals)
    return float((Decimal(str(value)) / step).quantize(Decimal(1), rounding=ROUND_HALF_UP) * step)


def format_rounded(value: float, kind: str, places: int) -> str:
    """The value as a teacher would write it: fixed decimals, or significant
    figures, keeping trailing zeros ("30.0" for 3 s.f. of 30)."""
    if kind == "sig":
        figures = max(1, places)
        rounded = round_sig(value, figures)
        decimals = max(0, sig_decimals(rounded, figures))
    else:
        decimals = max(0, places)
        rounded = round_to(value, decimals)
    text = f"{rounded:.{decimals}f}"
    return "0" + text[2:] if text.startswith("-0") and float(text) == 0 else text
