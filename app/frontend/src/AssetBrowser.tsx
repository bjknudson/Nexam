import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { getAssetFileUrl, inspectAssets } from "./api";
import {
  NO_FILTERS,
  activeFilterCount,
  assetName,
  filterAssets,
  type AssetFilters,
  type AssetMatch,
  type AssetSort,
} from "./assetSearch";
import { openDrawingWindow } from "./desktop";
import type { AssetListItemModel, AssetModel } from "./types";

/** The Bank Assets browser, used in the docked sidebar and the popped-out
 *  window. It adapts to its own width (CSS container queries): compact rows
 *  when narrow, a thumbnail grid when wide, with a details panel either way.
 *  See "Bank Assets pane: redesign" in docs/svg-editor-plan.md. */
export interface AssetBrowserProps {
  hasBank: boolean;
  assets: AssetListItemModel[];
  search: string;
  onSearchChange: (value: string) => void;
  selectedQuestionId: string | null;
  /** The current question's attached assets, with their variable values. */
  attachedAssets: AssetModel[];
  /** The current question's topic, offered as a one-click filter. */
  questionTopic: string | null;
  onAttach: (asset: AssetListItemModel) => void;
  onOpenQuestion: (questionId: string) => void;
}

export const ASSET_DRAG_TYPE = "application/x-nexam-asset";

export default function AssetBrowser({
  hasBank,
  assets,
  search,
  onSearchChange,
  selectedQuestionId,
  attachedAssets,
  questionTopic,
  onAttach,
  onOpenQuestion,
}: AssetBrowserProps) {
  const [filters, setFilters] = useState<AssetFilters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<AssetSort>("name");
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  const attachedPaths = attachedAssets.map((asset) => asset.path);
  const matches = useMemo(
    () => filterAssets(assets, search, filters, attachedPaths, sort),
    // attachedPaths is derived from attachedAssets.
    [assets, search, filters, attachedAssets, sort],
  );
  const previews = useAssetPreviews(assets, attachedAssets);
  const topics = useMemo(
    () => [...new Set(assets.flatMap((asset) => asset.topics ?? []))].sort((a, b) => a.localeCompare(b)),
    [assets],
  );
  const detail = detailPath ? assets.find((asset) => asset.path === detailPath) ?? null : null;
  const filterCount = activeFilterCount(filters);

  useEffect(() => {
    if (activeIndex >= matches.length) setActiveIndex(Math.max(0, matches.length - 1));
  }, [activeIndex, matches.length]);

  function onListKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    const current = matches[activeIndex]?.asset;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(matches.length - 1, index + 1));
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && current) {
      setDetailPath(current.path);
    } else if (event.key.toLowerCase() === "a" && current && selectedQuestionId) {
      onAttach(current);
    } else if (event.key.toLowerCase() === "e" && current?.kind === "svg") {
      void openDrawingWindow(current.path, selectedQuestionId ?? undefined);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!hasBank) {
    return (
      <div className="asset-browser">
        <div className="ab-empty">
          <strong>No bank open</strong>
          <p>Open a bank to browse its assets.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="asset-browser">
      <div className="ab-toolbar">
        <label className="ab-search">
          <input
            type="search"
            value={search}
            placeholder="Search names, labels, topics…"
            aria-label="Search assets"
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.focus();
              }
            }}
          />
          <span className="ab-count" aria-live="polite">
            {matches.length === assets.length ? assets.length : `${matches.length} of ${assets.length}`}
          </span>
        </label>
        <button
          type="button"
          className={`ab-icon-button ${filterCount > 0 ? "active" : ""}`}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
          title="Filter assets"
        >
          Filter{filterCount > 0 ? ` (${filterCount})` : ""}
        </button>
        <select className="ab-sort" value={sort} aria-label="Sort assets" onChange={(event) => setSort(event.target.value as AssetSort)}>
          <option value="name">Name</option>
          <option value="recent">Recently changed</option>
          <option value="uses">Most used</option>
        </select>
        <button type="button" className="ab-primary" onClick={() => void openDrawingWindow()} title="Draw a new diagram">
          + Drawing
        </button>
      </div>

      {filtersOpen ? (
        <div className="ab-filters" role="group" aria-label="Filters">
          <div className="ab-segmented">
            {(["all", "svg", "image"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={filters.kind === kind ? "active" : ""}
                onClick={() => setFilters((current) => ({ ...current, kind }))}
              >
                {kind === "all" ? "All" : kind === "svg" ? "Drawings" : "Images"}
              </button>
            ))}
          </div>
          <FilterChip label="Unused" on={filters.unusedOnly} onToggle={() => setFilters((current) => ({ ...current, unusedOnly: !current.unusedOnly }))} />
          {selectedQuestionId ? (
            <FilterChip
              label="On this question"
              on={filters.onQuestionOnly}
              onToggle={() => setFilters((current) => ({ ...current, onQuestionOnly: !current.onQuestionOnly }))}
            />
          ) : null}
          <FilterChip
            label="Has variables"
            on={filters.withVariablesOnly}
            onToggle={() => setFilters((current) => ({ ...current, withVariablesOnly: !current.withVariablesOnly }))}
          />
          <select
            className="ab-topic"
            value={filters.topic ?? ""}
            aria-label="Asset topic"
            onChange={(event) => setFilters((current) => ({ ...current, topic: event.target.value || null }))}
          >
            <option value="">Any topic</option>
            {questionTopic && !topics.includes(questionTopic) ? <option value={questionTopic}>{questionTopic}</option> : null}
            {topics.map((topic) => (
              <option key={topic} value={topic}>
                {topic}
              </option>
            ))}
          </select>
          {questionTopic && filters.topic !== questionTopic ? (
            <button type="button" className="ab-link" onClick={() => setFilters((current) => ({ ...current, topic: questionTopic }))}>
              Show {questionTopic}
            </button>
          ) : null}
          {filterCount > 0 ? (
            <button type="button" className="ab-link" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={`ab-main ${detail ? "with-detail" : ""}`}>
        {assets.length === 0 ? (
          <div className="ab-empty">
            <strong>No assets yet</strong>
            <p>Draw a diagram, or upload an image from a question's Assets section.</p>
            <button type="button" className="ab-primary" onClick={() => void openDrawingWindow()}>
              + New drawing
            </button>
          </div>
        ) : matches.length === 0 ? (
          <div className="ab-empty">
            <strong>No assets match{search.trim() ? ` “${search.trim()}”` : ""}</strong>
            <p>
              {search.trim() ? (
                <button type="button" className="ab-link" onClick={() => onSearchChange("")}>
                  Clear search
                </button>
              ) : null}
              {filterCount > 0 ? (
                <button type="button" className="ab-link" onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
                </button>
              ) : null}
            </p>
          </div>
        ) : (
          <ul
            ref={listRef}
            className="ab-items"
            tabIndex={0}
            role="listbox"
            aria-label="Assets"
            aria-activedescendant={matches[activeIndex] ? `asset-${activeIndex}` : undefined}
            onKeyDown={onListKeyDown}
          >
            {matches.map((match, index) => (
              <AssetItem
                key={match.asset.path}
                index={index}
                match={match}
                preview={previews.get(match.asset.path)}
                active={index === activeIndex}
                selected={detailPath === match.asset.path}
                attached={attachedPaths.includes(match.asset.path)}
                canAttach={selectedQuestionId !== null}
                questionId={selectedQuestionId}
                onSelect={() => {
                  setActiveIndex(index);
                  setDetailPath(detailPath === match.asset.path ? null : match.asset.path);
                }}
                onAttach={() => onAttach(match.asset)}
              />
            ))}
          </ul>
        )}

        {detail ? (
          <AssetDetails
            asset={detail}
            preview={previews.get(detail.path)}
            attached={attachedPaths.includes(detail.path)}
            canAttach={selectedQuestionId !== null}
            questionId={selectedQuestionId}
            onAttach={() => onAttach(detail)}
            onOpenQuestion={onOpenQuestion}
            onClose={() => setDetailPath(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function FilterChip({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`ab-chip ${on ? "active" : ""}`} aria-pressed={on} onClick={onToggle}>
      {label}
    </button>
  );
}

function AssetItem({
  index,
  match,
  preview,
  active,
  selected,
  attached,
  canAttach,
  questionId,
  onSelect,
  onAttach,
}: {
  index: number;
  match: AssetMatch;
  preview: string | undefined;
  active: boolean;
  selected: boolean;
  attached: boolean;
  canAttach: boolean;
  questionId: string | null;
  onSelect: () => void;
  onAttach: () => void;
}) {
  const { asset, reason } = match;
  const uses = asset.referenced_by.length;
  return (
    <li
      id={`asset-${index}`}
      data-index={index}
      role="option"
      aria-selected={selected}
      className={`ab-item ${active ? "active" : ""} ${selected ? "selected" : ""}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.path);
        event.dataTransfer.setData("text/plain", asset.path);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
    >
      <span className="ab-thumb">{preview ? <img src={preview} alt="" draggable={false} /> : null}</span>
      <span className="ab-body">
        <span className="ab-name" title={asset.path}>
          {assetName(asset)}
        </span>
        <span className="ab-meta">
          {asset.kind === "svg" ? "drawing" : asset.kind}
          {asset.svg_placeholders.length > 0 ? ` · ${asset.svg_placeholders.length} var${asset.svg_placeholders.length === 1 ? "" : "s"}` : ""}
          {" · "}
          {uses === 0 ? <span className="ab-unused">unused</span> : `${uses} use${uses === 1 ? "" : "s"}`}
        </span>
        {reason ? <span className="ab-reason">{reason}</span> : null}
      </span>
      <span className="ab-actions" onClick={(event) => event.stopPropagation()}>
        {canAttach ? (
          <button
            type="button"
            className={`ab-icon-button ${attached ? "done" : ""}`}
            disabled={attached}
            title={attached ? "Attached to this question" : "Attach to this question (A)"}
            aria-label={attached ? "Attached" : "Attach"}
            onClick={onAttach}
          >
            {attached ? "✓" : "＋"}
          </button>
        ) : null}
        {asset.kind === "svg" ? (
          <button
            type="button"
            className="ab-icon-button"
            title="Edit drawing (E)"
            aria-label="Edit drawing"
            onClick={() => void openDrawingWindow(asset.path, questionId ?? undefined)}
          >
            ✎
          </button>
        ) : null}
      </span>
    </li>
  );
}

function AssetDetails({
  asset,
  preview,
  attached,
  canAttach,
  questionId,
  onAttach,
  onOpenQuestion,
  onClose,
}: {
  asset: AssetListItemModel;
  preview: string | undefined;
  attached: boolean;
  canAttach: boolean;
  questionId: string | null;
  onAttach: () => void;
  onOpenQuestion: (questionId: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="ab-details" aria-label={`Details for ${assetName(asset)}`}>
      <div className="ab-details-header">
        <strong title={asset.path}>{assetName(asset)}</strong>
        <button type="button" className="ab-icon-button" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="ab-details-preview">{preview ? <img src={preview} alt={`Preview of ${assetName(asset)}`} /> : null}</div>
      <div className="ab-details-actions">
        {canAttach ? (
          <button type="button" className="ab-primary" disabled={attached} onClick={onAttach}>
            {attached ? "Attached" : "Attach to question"}
          </button>
        ) : null}
        {asset.kind === "svg" ? (
          <>
            <button type="button" onClick={() => void openDrawingWindow(asset.path, questionId ?? undefined)}>
              Edit drawing
            </button>
            <button type="button" onClick={() => void openDrawingWindow(undefined, undefined, { copyFrom: asset.path })}>
              Copy to new drawing
            </button>
          </>
        ) : null}
      </div>
      {(asset.topics ?? []).length + (asset.tags ?? []).length > 0 ? (
        <div className="ab-chips">
          {(asset.topics ?? []).map((topic) => (
            <span key={`t-${topic}`} className="ab-tag topic">
              {topic}
            </span>
          ))}
          {(asset.tags ?? []).map((tag) => (
            <span key={`g-${tag}`} className="ab-tag">
              #{tag}
            </span>
          ))}
        </div>
      ) : asset.kind === "svg" ? (
        <p className="ab-muted">No topics yet. Add them under “Topics” in the drawing tool.</p>
      ) : null}
      {asset.svg_placeholders.length > 0 ? (
        <div className="ab-section">
          <h4>Variables</h4>
          <p className="ab-vars">
            {asset.svg_placeholders.map((name) => (
              <code key={name}>{name}</code>
            ))}
          </p>
        </div>
      ) : null}
      <div className="ab-section">
        <h4>Used by</h4>
        {asset.referenced_by.length === 0 ? (
          <p className="ab-muted">Not used by any question.</p>
        ) : (
          <ul className="ab-used-by">
            {asset.referenced_by.map((id) => (
              <li key={id}>
                <button type="button" className="ab-link" onClick={() => onOpenQuestion(id)}>
                  {id}
                </button>
                {id === questionId ? <span className="ab-muted"> (this question)</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="ab-muted ab-path">{asset.path}</p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Thumbnails rendered with real values
// ---------------------------------------------------------------------------

const previewCache = new Map<string, string>();

/** Image URLs for each asset. Drawings are rendered by the backend with
 *  values: the current question's if it uses the drawing, otherwise the
 *  drawing's own saved preview values, so thumbnails show a picture, not
 *  {{placeholders}}. Cached by path, file time and values. */
function useAssetPreviews(assets: AssetListItemModel[], attachedAssets: AssetModel[]): Map<string, string> {
  const [version, setVersion] = useState(0);
  const requests = useMemo(
    () =>
      assets
        .filter((asset) => asset.kind === "svg")
        .map((asset) => {
          const values =
            attachedAssets.find((attached) => attached.path === asset.path)?.svg_variables ?? asset.preview_values ?? {};
          return { asset, values, key: `${asset.path}|${asset.modified ?? 0}|${JSON.stringify(values)}` };
        }),
    [assets, attachedAssets],
  );

  useEffect(() => {
    const missing = requests.filter((request) => !previewCache.has(request.key));
    if (missing.length === 0) return;
    let cancelled = false;
    inspectAssets(missing.map(({ asset, values }) => ({ path: asset.path, kind: "svg", svg_variables: values })))
      .then((response) => {
        response.items.forEach((item, index) => {
          if (item.rendered_svg) {
            previewCache.set(missing[index].key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.rendered_svg)}`);
          }
        });
        if (!cancelled) setVersion((value) => value + 1);
      })
      .catch(() => {
        // Thumbnails fall back to the raw file below.
      });
    return () => {
      cancelled = true;
    };
  }, [requests]);

  return useMemo(() => {
    const urls = new Map<string, string>();
    for (const asset of assets) {
      const request = requests.find((item) => item.asset.path === asset.path);
      const rendered = request ? previewCache.get(request.key) : undefined;
      const fileUrl = getAssetFileUrl(asset.path);
      urls.set(asset.path, rendered ?? (asset.kind === "svg" ? `${fileUrl}&v=${asset.modified ?? 0}` : fileUrl));
    }
    return urls;
    // `version` changes when new renders arrive.
  }, [assets, requests, version]);
}
