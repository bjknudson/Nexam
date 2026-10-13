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

import ast
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


# ---------------------------------------------------------------------------
# {{calc: ...}} expressions (shared by drawings and question text)
# ---------------------------------------------------------------------------

# min/max take any number of arguments; sin/cos take one, in degrees;
# round(x, places) and sig(x, figures) round half away from zero. As the
# whole expression, round/sig also keep trailing zeros ("30.0").
EXPR_FUNCTIONS = {
    "min": min,
    "max": max,
    "sin": lambda values: math.sin(math.radians(values[0])),
    "cos": lambda values: math.cos(math.radians(values[0])),
    "round": lambda values: round_to(values[0], int(values[1]) if len(values) > 1 else 0),
    "sig": lambda values: round_sig(values[0], int(values[1]) if len(values) > 1 else 3),
}

CALC_PATTERN = re.compile(r"{{\s*calc:\s*([^{}]+?)\s*}}")
PLACEHOLDER_PATTERN = re.compile(r"{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}")


def eval_expression_ast(node: ast.AST, variables: dict[str, str]) -> float:
    if isinstance(node, ast.BinOp):
        left = eval_expression_ast(node.left, variables)
        right = eval_expression_ast(node.right, variables)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right if right != 0 else 0
        raise ValueError("unsupported binary operator")

    if isinstance(node, ast.UnaryOp):
        value = eval_expression_ast(node.operand, variables)
        if isinstance(node.op, ast.UAdd):
            return value
        if isinstance(node.op, ast.USub):
            return -value
        raise ValueError("unsupported unary operator")

    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)

    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in EXPR_FUNCTIONS
        and node.args
        and not node.keywords
    ):
        values = [eval_expression_ast(argument, variables) for argument in node.args]
        return float(EXPR_FUNCTIONS[node.func.id](values))

    if isinstance(node, ast.Name):
        raw_value = variables.get(node.id, "0").strip()
        try:
            return float(raw_value)
        except ValueError:
            return 0

    raise ValueError("unsupported expression node")


def evaluate_expression(
    expression: str,
    variables: dict[str, str],
    show_kind: str | None = None,
    places: int = 0,
) -> str:
    """An expression's value as text. Unknown or non-numeric variables count
    as 0 and a bad expression gives "0". round()/sig() as the whole
    expression (or `show_kind`) fix the digits."""
    try:
        parsed = ast.parse(expression, mode="eval")
        value = eval_expression_ast(parsed.body, variables)
        body = parsed.body
        if (
            show_kind is None
            and isinstance(body, ast.Call)
            and isinstance(body.func, ast.Name)
            and body.func.id in ("round", "sig")
        ):
            show_kind = "decimals" if body.func.id == "round" else "sig"
            default = 0 if show_kind == "decimals" else 3
            places = int(eval_expression_ast(body.args[1], variables)) if len(body.args) > 1 else default
    except Exception:
        return "0"

    if show_kind in ("decimals", "sig") and math.isfinite(value):
        return format_rounded(value, show_kind, places)

    if float(value).is_integer():
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def fill_question_text(text: str, variables: dict[str, str]) -> str:
    """Question text (prompt, choices, answers) with its variables filled in:
    every {{calc: ...}}, and each {{name}} the question defines. Other {{...}}
    is left as typed, so LaTeX braces and unset names stay visible."""
    if "{{" not in text:
        return text
    text = CALC_PATTERN.sub(lambda match: evaluate_expression(match.group(1), variables), text)
    return PLACEHOLDER_PATTERN.sub(lambda match: variables.get(match.group(1), match.group(0)), text)
