"""Build samples/demo-gradebook.nxgb: an empty-of-scans gradebook with a roster.

A gradebook is a separate document from a bank and holds student names, so this
sample exists to make grading testable without inventing a class first. It is
sample data, not anyone's real roster.

Run:
    python scripts/build_demo_gradebook.py
"""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.backend.gradebook_service import GradebookService  # noqa: E402
from app.backend.models import UpsertStudentRequest  # noqa: E402

OUTPUT_FILE = ROOT / "samples" / "demo-gradebook.nxgb"

# Deliberately invented names, spread across the alphabet so sorting and
# roster-matching are visible at a glance. Two sections and a few groupings so
# the section/group filters have something real to filter.
DEMO_ROSTER = [
    ("Amara", "Baptiste", "Period 2", "EL"),
    ("Bao", "Chen", "Period 2", ""),
    ("Camila", "Duarte", "Period 2", ""),
    ("Dmitri", "Eriksson", "Period 2", ""),
    ("Elena", "Farouk", "Period 2", ""),
    ("Femi", "Gonzalez", "Period 2", "EL"),
    ("Grace", "Haddad", "Period 2", ""),
    ("Hana", "Ito", "Period 2", "Extended time"),
    ("Ivan", "Jankovic", "Period 2", ""),
    ("Jamal", "Keita", "Period 2", ""),
    ("Kiara", "Lindqvist", "Period 4", "EL"),
    ("Liam", "Moreau", "Period 4", ""),
    ("Mei", "Nakamura", "Period 4", ""),
    ("Noor", "Okonkwo", "Period 4", ""),
    ("Oscar", "Petrov", "Period 4", "Extended time"),
    ("Priya", "Quintero", "Period 4", "EL"),
    ("Rafael", "Rossi", "Period 4", ""),
    ("Sofia", "Svensson", "Period 4", ""),
    ("Tomas", "Ueda", "Period 4", ""),
    ("Yara", "Volkov", "Period 4", ""),
]


def build_demo_gradebook() -> None:
    if OUTPUT_FILE.exists():
        OUTPUT_FILE.unlink()

    service = GradebookService()
    service.create_gradebook(
        title="Demo Period 2 - Fall 2026",
        description="Sample roster for trying out response sheets, scanning, and reports.",
        destination_path=str(OUTPUT_FILE),
    )
    for first_name, last_name, section, grouping in DEMO_ROSTER:
        service.upsert_student(
            None,
            UpsertStudentRequest(
                first_name=first_name,
                last_name=last_name,
                section=section,
                grouping=grouping or None,
            ),
        )
    service.save_gradebook()


if __name__ == "__main__":
    build_demo_gradebook()
    print(f"Wrote {OUTPUT_FILE} with {len(DEMO_ROSTER)} students")
