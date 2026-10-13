from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.backend.asset_metadata import SvgSummaryCache, parse_preview, split_list, summarize_svg

DRAWING = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 318 200"
  data-nexam-topics="Mechanics; Newton's Laws" data-nexam-tags="free-body"
  data-nexam-preview="arrow_length=40; force=12 N">
  <title>Block on a pulley</title>
  <g data-nexam-stamp="Pulley" data-nexam-stamp-category="Mechanics" transform="translate(10 10)">
    <circle cx="22" cy="38" r="18"/>
  </g>
  <g data-nexam-control="variable-arrow" data-variable="arrow_length" data-label="{{force}} N">
    <line x1="0" y1="0" x2="{{calc: 10 + arrow_length}}" y2="0"/>
  </g>
  <text x="5" y="20">Normal force <tspan>F<tspan>N</tspan></tspan></text>
</svg>"""


def test_summary_collects_stamps_labels_variables_and_topics() -> None:
    summary = summarize_svg(DRAWING)

    assert summary.topics == ["Mechanics", "Newton's Laws"]
    assert summary.tags == ["free-body"]
    assert summary.preview_values == {"arrow_length": "40", "force": "12 N"}
    for term in ["Pulley", "Mechanics", "variable arrow", "arrow length", "Normal force", "Block on a pulley", "free body"]:
        assert term in summary.search_terms, term
    # Placeholders are not search words.
    assert not any("{{" in term for term in summary.search_terms)


def test_summary_is_empty_for_unreadable_or_unsafe_files() -> None:
    assert summarize_svg("<svg").search_terms == []
    assert summarize_svg('<!DOCTYPE x [<!ENTITY a "a">]><svg>&a;</svg>').search_terms == []


def test_list_helpers() -> None:
    assert split_list(" Forces ;; forces; Energy ") == ["Forces", "Energy"]
    assert parse_preview("a=1; bad name=2; b = x y ;c") == {"a": "1", "b": "x y"}


def test_cache_rereads_only_when_the_file_changes(tmp_path: Path) -> None:
    path = tmp_path / "fig.svg"
    path.write_text(DRAWING)
    cache = SvgSummaryCache()
    first = cache.get(path)
    assert cache.get(path) is first
    path.write_text(DRAWING.replace("Pulley", "Spring"))
    assert "Spring" in cache.get(path).search_terms


def test_asset_list_returns_search_terms_and_topics(client: TestClient, demo_bok: Path) -> None:
    assert client.post("/api/banks/open", json={"path": str(demo_bok)}).status_code == 200
    upload = client.post("/api/assets/upload", files={"file": ("pulley-drawing.svg", DRAWING.encode(), "image/svg+xml")})
    assert upload.status_code == 200

    items = {item["path"]: item for item in client.get("/api/assets").json()["items"]}
    item = items[upload.json()["path"]]

    assert item["topics"] == ["Mechanics", "Newton's Laws"]
    assert "Pulley" in item["search_terms"]
    assert item["preview_values"]["force"] == "12 N"
    assert item["modified"] > 0
    # Older drawings without any of this still list fine.
    assert items["assets/sample-svg-template.svg"]["topics"] == []


def test_math_text_is_indexed_as_its_plain_source() -> None:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<text data-nexam-tex="$F_{net}$ = {{force}} N"><tspan>F<tspan>net</tspan></tspan> = {{force}} N</text>'
        '<g data-nexam-control="variable-arrow" data-variable="w" data-label="$\\vec{F}_g$ weight"/>'
        "</svg>"
    )
    terms = summarize_svg(svg).search_terms
    assert "F net = N" in terms
    assert "F g weight" in terms
    assert "net" not in terms


def test_declared_variables_are_searchable_but_their_json_is_not() -> None:
    source = (
        '<svg xmlns="http://www.w3.org/2000/svg"><metadata id="nexam-variables">'
        '{"variables": [{"name": "force", "label": "Applied force", "units": "N"}]}'
        "</metadata><text>{{force}} N</text></svg>"
    )

    terms = summarize_svg(source).search_terms

    assert "Applied force" in terms
    assert "force" in terms
    assert not any("variables" in term for term in terms)
