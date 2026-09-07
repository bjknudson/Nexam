"""Math in the shipped questions must be delimited.

A choice like `\\lim_{x \\to c} f(x) = f(c)` written without `$...$` relied on
the renderer guessing that it was math. It guessed wrong -- a subscripted
command was invisible to the detector -- and the choice printed as raw LaTeX on
a real answer sheet. The renderer is fixed, but sample data a teacher copies
from should not depend on the guess at all.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
QUESTION_DIR = REPO_ROOT / "samples" / "demo-bank" / "questions"

# The commands the renderer knows about, plus \to, which shows up inside limits.
LATEX_COMMANDS = (
    "frac|sqrt|sum|int|lim|theta|pi|alpha|beta|gamma|delta|Delta|lambda|mu|sigma"
    "|omega|cdot|times|div|pm|leq|geq|neq|approx|implies|sin|cos|tan|left|right|to"
)
# A command name ends at the first non-letter -- `\b` would not do here, because
# it treats the `_` in `\lim_` as part of the word. This mirrors COMMAND_END in
# MathPreview.tsx; the two must agree about where a command ends.
COMMAND = re.compile(rf"\\(?:{LATEX_COMMANDS})(?![A-Za-z])")


def _outside_math_delimiters(text: str) -> str:
    """Whatever is left after removing $...$, \\(...\\) and \\[...\\] spans."""

    without = re.sub(r"\$[^$]*\$", " ", text)
    without = re.sub(r"\\\(.*?\\\)", " ", without, flags=re.S)
    without = re.sub(r"\\\[.*?\\\]", " ", without, flags=re.S)
    return without


def _question_texts(question: dict) -> list[tuple[str, str]]:
    texts = [
        ("prompt", question.get("prompt") or ""),
        ("explanation", question.get("explanation") or ""),
        ("sample_solution", question.get("sample_solution") or ""),
    ]
    choices = (question.get("answer") or {}).get("choices") or []
    texts.extend((f"choice[{index}]", str(choice)) for index, choice in enumerate(choices))
    return texts


def _question_files() -> list[Path]:
    return sorted(QUESTION_DIR.glob("*.json"))


def test_the_sample_questions_are_present() -> None:
    assert _question_files(), f"no sample questions under {QUESTION_DIR}"


@pytest.mark.parametrize("path", _question_files(), ids=lambda path: path.stem)
def test_sample_question_math_is_delimited(path: Path) -> None:
    question = json.loads(path.read_text())

    offenders = [
        (field, text)
        for field, text in _question_texts(question)
        if COMMAND.search(_outside_math_delimiters(text))
    ]

    assert not offenders, (
        f"{path.name} has LaTeX outside math delimiters: {offenders}. "
        "Wrap it in $...$ so it does not depend on the renderer guessing."
    )
