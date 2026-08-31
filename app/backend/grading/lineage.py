"""Which printings count as the same test.

Course coverage reporting already groups test versions by
`title.strip().casefold()`, and combined score reporting followed it. Attempts
need the same grouping to be *stable* and *overridable*: stable, so a first try
and a retake printed weeks apart line up without the teacher doing anything;
overridable, so a retake titled "Unit 1 Retake" can be linked to "Unit 1" by
hand instead of showing up as a separate test nobody ever passed.

The id is derived from the title rather than assigned at random, which means
snapshots written before `lineage_id` existed resolve to the same id as new
ones with no migration and no rewrite of anything already on disk.
"""

from __future__ import annotations

import hashlib

from ..models import AdministeredTestSnapshotModel


def lineage_key(title: str) -> str:
    return title.strip().casefold()


def lineage_id_for_title(title: str) -> str:
    """A stable 12-hex-character id for a title's lineage.

    Hashed rather than used raw so the id is safe in a URL, a CSV column, and a
    filename without any escaping, and so its length doesn't vary with the title.
    """

    return hashlib.sha1(lineage_key(title).encode("utf-8")).hexdigest()[:12]


def resolve_lineage_id(snapshot: AdministeredTestSnapshotModel) -> str:
    """The explicit link if one was set, else the title's default."""

    return snapshot.lineage_id or lineage_id_for_title(snapshot.title)


def lineage_title(snapshots: list[AdministeredTestSnapshotModel]) -> str:
    """A display title for a group of snapshots that share a lineage.

    They usually all agree; when a retake was linked in under a different title
    the earliest printing's title wins, since that is the one the teacher named
    the test after.
    """

    if not snapshots:
        return ""
    return min(snapshots, key=lambda snapshot: snapshot.printed_at).title
