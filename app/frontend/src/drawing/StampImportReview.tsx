// The import review for stamps: every SVG from the chosen files and zip packs,
// filed by collection › category (not by pack name) before anything is saved.
// See "Stamp packs" in docs/svg-editor-plan.md. The caller does the network
// calls; these types mirror app/backend/stamp_library.py.

import { useEffect, useMemo, useState } from "react";

import { stampThumbnailUrl } from "./stamps";

export interface ImportRow {
  row_id: string;
  file: string;
  name: string;
  collection: string;
  category: string;
  topics: string[];
  tags: string[];
  description: string;
  source_pack: string;
  status: "new" | "duplicate" | "update" | "invalid" | "missing";
  reason: string;
  svg: string;
  move_from: string;
}

export interface ImportReview {
  token: string;
  packs: { name: string; description: string; notes: string }[];
  rows: ImportRow[];
  collections: Record<string, string[]>;
}

export interface ImportChoice {
  row_id: string;
  include: boolean;
  name: string;
  collection: string;
  category: string;
  topics: string[];
  tags: string[];
  description: string;
  on_conflict: "replace" | "keep_both" | "skip";
}

export interface ImportSummary {
  added: number;
  updated: number;
  skipped: number;
  merged: number;
  filed: number;
  messages: string[];
}

interface Draft {
  include: boolean;
  name: string;
  collection: string;
  category: string;
  topics: string;
  on_conflict: ImportChoice["on_conflict"];
}

const STATUS_TEXT: Record<ImportRow["status"], string> = {
  new: "New",
  duplicate: "Already have it",
  update: "Updated version",
  invalid: "Can't use",
  missing: "Missing from zip",
};

const splitTopics = (text: string) =>
  text
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);

export default function StampImportReview({
  review,
  knownCollections = {},
  onCancel,
  onImport,
}: {
  review: ImportReview;
  /** Collections the library doesn't hold on disk but the editor shows (built-in stamps). */
  knownCollections?: Record<string, string[]>;
  onCancel: () => void;
  onImport: (choices: ImportChoice[]) => Promise<void>;
}) {
  // The folder's collections plus built-in ones, so "physics" files under "Physics".
  const collectionsByName = useMemo(() => {
    const merged: Record<string, string[]> = { ...knownCollections };
    for (const [name, categories] of Object.entries(review.collections)) {
      const existing = Object.keys(merged).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
      merged[existing] = [...new Set([...(merged[existing] ?? []), ...categories])];
    }
    return merged;
  }, [knownCollections, review.collections]);
  const usable = review.rows.filter((row) => row.status !== "invalid" && row.status !== "missing");
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      usable.map((row) => [
        row.row_id,
        {
          // Identical files are skipped by default (their topics still merge if included).
          include: row.status !== "duplicate",
          name: row.name,
          collection: row.collection,
          category: row.category,
          topics: row.topics.join("; "),
          on_conflict: "replace",
        },
      ]),
    ),
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulk, setBulk] = useState({ collection: "", category: "", topics: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const thumbnails = useMemo(
    () =>
      new Map(
        usable.map((row) => [row.row_id, stampThumbnailUrl({ id: row.row_id, name: row.name, category: "", svg: row.svg, source: "mine" })]),
      ),
    // Rows don't change during a review.
    [review.token],
  );

  const update = (rowId: string, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [rowId]: { ...current[rowId], ...patch } }));
  const needsFiling = (rowId: string) => {
    const draft = drafts[rowId];
    return draft.include && (!draft.collection.trim() || !draft.category.trim());
  };
  const included = usable.filter((row) => drafts[row.row_id].include);
  const unfiledCount = usable.filter((row) => needsFiling(row.row_id)).length;
  // Stamps that still need a collection and category come first.
  const ordered = [...usable].sort((a, b) => Number(needsFiling(b.row_id)) - Number(needsFiling(a.row_id)));
  const problems = review.rows.filter((row) => row.status === "invalid" || row.status === "missing");
  const collectionNames = Object.keys(collectionsByName);
  const canonicalCollection = (value: string) =>
    collectionNames.find((name) => name.toLowerCase() === value.trim().toLowerCase()) ?? value.trim();
  const canonicalCategory = (collection: string, value: string) =>
    (collectionsByName[collection] ?? []).find((name) => name.toLowerCase() === value.trim().toLowerCase()) ?? value.trim();

  function applyBulk() {
    setDrafts((current) => {
      const next = { ...current };
      for (const rowId of selected) {
        const draft = next[rowId];
        next[rowId] = {
          ...draft,
          collection: bulk.collection.trim() || draft.collection,
          category: bulk.category.trim() || draft.category,
          topics: bulk.topics.trim() ? [...new Set([...splitTopics(draft.topics), ...splitTopics(bulk.topics)])].join("; ") : draft.topics,
        };
      }
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onImport(
        usable.map((row) => {
          const draft = drafts[row.row_id];
          const collection = canonicalCollection(draft.collection);
          return {
            row_id: row.row_id,
            include: draft.include,
            name: draft.name,
            collection,
            category: canonicalCategory(collection, draft.category),
            topics: splitTopics(draft.topics),
            tags: row.tags,
            description: row.description,
            on_conflict: draft.on_conflict,
          };
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The import didn't finish.");
      setBusy(false);
    }
  }

  return (
    <div className="drawing-dialog-backdrop">
      <div className="drawing-dialog stamp-review" role="dialog" aria-modal="true" aria-labelledby="stamp-review-title">
        <h2 id="stamp-review-title">Import stamps</h2>
        {review.packs.map((pack) => (
          <div key={pack.name} className="stamp-review-pack">
            <strong>{pack.name}</strong>
            {pack.description ? <span> — {pack.description}</span> : null}
            {pack.notes ? (
              <details>
                <summary>Pack notes</summary>
                <pre>{pack.notes}</pre>
              </details>
            ) : null}
          </div>
        ))}
        <p className="drawing-muted">
          Stamps are filed by <strong>collection › category</strong> (e.g. Physics › Mechanics), so later batches land beside
          earlier ones. Nothing is saved until you press Import.
        </p>

        <datalist id="stamp-review-collections">
          {collectionNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {collectionNames.map((name, index) => (
          <datalist key={name} id={`stamp-review-categories-${index}`}>
            {collectionsByName[name].map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
        ))}

        <div className="stamp-review-bulk">
          <span>{selected.size > 0 ? `${selected.size} selected:` : "Select rows to file several at once:"}</span>
          <input
            list="stamp-review-collections"
            placeholder="Collection"
            value={bulk.collection}
            onChange={(event) => setBulk({ ...bulk, collection: event.target.value })}
          />
          <input
            list={categoryListId(bulk.collection, collectionNames)}
            placeholder="Category"
            value={bulk.category}
            onChange={(event) => setBulk({ ...bulk, category: event.target.value })}
          />
          <input placeholder="Add topics" value={bulk.topics} onChange={(event) => setBulk({ ...bulk, topics: event.target.value })} />
          <button type="button" disabled={selected.size === 0} onClick={applyBulk}>
            Apply to selected
          </button>
        </div>

        <div className="stamp-review-table-wrap">
          <table className="stamp-review-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === usable.length && usable.length > 0}
                    onChange={(event) => setSelected(event.target.checked ? new Set(usable.map((row) => row.row_id)) : new Set())}
                  />
                </th>
                <th />
                <th>Name</th>
                <th>Collection</th>
                <th>Category</th>
                <th>Topics</th>
                <th>Status</th>
                <th>Import</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((row) => {
                const draft = drafts[row.row_id];
                const missing = needsFiling(row.row_id);
                return (
                  <tr key={row.row_id} className={missing ? "needs-filing" : draft.include ? "" : "excluded"}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.file}`}
                        checked={selected.has(row.row_id)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.row_id);
                            else next.delete(row.row_id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <span className="stamp-review-thumb">
                        {thumbnails.get(row.row_id) ? <img src={thumbnails.get(row.row_id)} alt="" /> : null}
                      </span>
                    </td>
                    <td>
                      <input aria-label={`Name of ${row.file}`} value={draft.name} onChange={(event) => update(row.row_id, { name: event.target.value })} />
                      <span className="stamp-review-file" title={row.description || row.file}>
                        {row.file}
                        {row.description ? ` · ${row.description}` : ""}
                      </span>
                    </td>
                    <td>
                      <input
                        aria-label={`Collection of ${row.file}`}
                        list="stamp-review-collections"
                        placeholder="Required"
                        value={draft.collection}
                        onChange={(event) => update(row.row_id, { collection: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Category of ${row.file}`}
                        list={categoryListId(draft.collection, collectionNames)}
                        placeholder="Required"
                        value={draft.category}
                        onChange={(event) => update(row.row_id, { category: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Topics of ${row.file}`}
                        placeholder="a; b"
                        value={draft.topics}
                        onChange={(event) => update(row.row_id, { topics: event.target.value })}
                      />
                    </td>
                    <td>
                      <span className={`stamp-review-status ${row.status}`}>{row.move_from ? "File it" : STATUS_TEXT[row.status]}</span>
                      {row.status === "update" ? (
                        <select
                          aria-label={`If ${row.file} is already there`}
                          value={draft.on_conflict}
                          onChange={(event) => update(row.row_id, { on_conflict: event.target.value as Draft["on_conflict"] })}
                        >
                          <option value="replace">Replace (keep old aside)</option>
                          <option value="keep_both">Keep both</option>
                          <option value="skip">Skip</option>
                        </select>
                      ) : null}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Import ${row.file}`}
                        checked={draft.include}
                        onChange={(event) => update(row.row_id, { include: event.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {problems.length > 0 ? (
          <details className="stamp-review-problems" open={problems.length <= 3}>
            <summary>{problems.length} file{problems.length === 1 ? "" : "s"} can't be imported</summary>
            <ul>
              {problems.map((row) => (
                <li key={row.row_id}>
                  <strong>{row.file}</strong>: {row.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {error ? <p className="drawing-error">{error}</p> : null}
        <div className="stamp-review-footer">
          <span className={unfiledCount > 0 ? "drawing-error" : "drawing-muted"}>
            {unfiledCount > 0
              ? `${unfiledCount} stamp${unfiledCount === 1 ? " needs" : "s need"} a collection and category.`
              : `${included.length} stamp${included.length === 1 ? "" : "s"} to import.`}
          </span>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy || unfiledCount > 0 || included.length === 0} onClick={() => void submit()}>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

function categoryListId(collection: string, collectionNames: string[]): string | undefined {
  const index = collectionNames.findIndex((name) => name.toLowerCase() === collection.trim().toLowerCase());
  return index >= 0 ? `stamp-review-categories-${index}` : undefined;
}
