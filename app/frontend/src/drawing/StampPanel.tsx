// The stamp library in the drawing editor's left rail, below the tools:
// search, then collections with collapsible categories (click one to show its
// thumbnails), then "Add stamps…" (SVGs or zip packs, through an import
// review). Click a thumbnail to add it, or drag it onto the canvas.

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import PackFormatDialog from "./PackFormatDialog";
import StampImportReview, { type ImportChoice, type ImportReview, type ImportSummary } from "./StampImportReview";
import { BUILT_IN_STAMPS, groupByCollection, stampThumbnailUrl, type Stamp } from "./stamps";

export interface StampLibraryProps {
  /** The teacher's own stamps (source "mine"). */
  stamps: Stamp[];
  /** Where they live on disk, shown so the folder is easy to find. */
  folder: string | null;
  error: string | null;
  /** Reads chosen SVG and zip files into an import review (nothing saved yet). */
  onPreviewImport: (files: File[]) => Promise<ImportReview>;
  /** A review for loose stamps from before collections. */
  onPreviewUnfiled: () => Promise<ImportReview>;
  /** Files the reviewed stamps and refreshes the library. */
  onCommitImport: (token: string, choices: ImportChoice[]) => Promise<ImportSummary>;
  /** Sets the teacher's own stamps aside (recoverably) and refreshes. */
  onRemove: (stamps: Stamp[]) => Promise<{ removalId: string; removed: number }>;
  /** Puts back what a removal set aside. */
  onRestore: (removalId: string) => Promise<void>;
  /** Saves a text file where the teacher chooses (pack templates); false if cancelled. */
  onSaveFile: (name: string, content: string) => Promise<boolean>;
}

const OPEN_GROUPS_KEY = "nexam:drawing-open-stamp-groups";

function readOpenGroups(): Set<string> {
  try {
    const raw = window.localStorage.getItem(OPEN_GROUPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeOpenGroups(groups: Set<string>) {
  try {
    window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // Remembering open groups is a convenience; storage may be unavailable.
  }
}

/** Every word typed must match the start of a word in the stamp's name,
 *  collection, category, topics, tags, description or file name. */
export function stampMatches(stamp: Stamp, query: string): boolean {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize(
    [
      stamp.name,
      stamp.collection ?? "",
      stamp.category,
      ...(stamp.topics ?? []),
      ...(stamp.tags ?? []),
      stamp.description ?? "",
      stamp.id.replace(/^[a-z-]+:/, "").replace(/\.svg$/i, ""),
    ].join(" "),
  )
    .split(" ")
    .filter(Boolean);
  return words.every((word) => haystack.some((candidate) => candidate.startsWith(word) || candidate.startsWith(singular(word))));
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_./›]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "");
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function summarize(result: ImportSummary): string {
  const parts = [
    result.added ? `${result.added} added` : "",
    result.filed ? `${result.filed} filed` : "",
    result.updated ? `${result.updated} updated` : "",
    result.merged ? `${result.merged} already there (topics merged)` : "",
    result.skipped ? `${result.skipped} skipped` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(", ")}.` : "Nothing was imported.";
}

export default function StampPanel({
  library,
  onPointerDownStamp,
}: {
  library?: StampLibraryProps;
  /** Starts a press on a stamp tile: a click inserts it, a drag drops it on the canvas. */
  onPointerDownStamp: (stamp: Stamp, event: ReactPointerEvent) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<{ text: string; error: boolean }[]>([]);
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(readOpenGroups);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [manage, setManage] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; stamps: Stamp[] } | null>(null);
  const [undo, setUndo] = useState<{ removalId: string; text: string } | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);

  const myStamps = library?.stamps ?? [];
  const allStamps = useMemo(() => [...BUILT_IN_STAMPS, ...myStamps], [myStamps]);
  const thumbnails = useMemo(() => {
    const urls = new Map<string, string>();
    for (const stamp of allStamps) urls.set(stamp.id, stampThumbnailUrl(stamp));
    return urls;
  }, [allStamps]);
  const collections = groupByCollection(allStamps);
  const matches = query.trim() ? allStamps.filter((stamp) => stampMatches(stamp, query)) : null;

  function toggleGroup(key: string) {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeOpenGroups(next);
      return next;
    });
  }

  async function removeConfirmed() {
    if (!library || !confirm) return;
    setBusy(true);
    try {
      const { removalId, removed } = await library.onRemove(confirm.stamps);
      setUndo(removalId ? { removalId, text: `Removed ${removed} stamp${removed === 1 ? "" : "s"}.` } : null);
      setMessages([]);
    } catch (error) {
      setMessages([{ text: error instanceof Error ? error.message : "Couldn't remove those stamps.", error: true }]);
    } finally {
      setConfirm(null);
      setBusy(false);
    }
  }

  async function undoRemoval() {
    if (!library || !undo) return;
    setBusy(true);
    try {
      await library.onRestore(undo.removalId);
      setUndo(null);
      setMessages([{ text: "Put back.", error: false }]);
    } catch (error) {
      setMessages([{ text: error instanceof Error ? error.message : "Couldn't put them back.", error: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function openReview(load: () => Promise<ImportReview>) {
    setBusy(true);
    setMessages([]);
    try {
      setReview(await load());
    } catch (error) {
      setMessages([{ text: error instanceof Error ? error.message : "Could not read those files.", error: true }]);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const renderTiles = (stamps: Stamp[], withNames: boolean) => (
    <div className={`drawing-stamp-grid ${withNames ? "with-names" : ""}`}>
      {stamps.map((stamp) => (
        <button
          key={stamp.id}
          type="button"
          className={`drawing-stamp-tile ${manage ? "managing" : ""} ${manage && stamp.source === "built-in" ? "locked" : ""}`}
          title={
            manage
              ? stamp.source === "built-in"
                ? `${stamp.name}: built-in stamps can't be removed`
                : `Remove ${stamp.name}`
              : `${stamp.name}${stamp.description ? ` — ${stamp.description}` : ""}\nClick to add, or drag onto the canvas`
          }
          aria-label={manage && stamp.source === "mine" ? `Remove ${stamp.name}` : stamp.name}
          onPointerDown={(event) => {
            if (event.button === 0 && !manage) onPointerDownStamp(stamp, event);
          }}
          onClick={() => {
            if (manage && stamp.source === "mine") {
              setConfirm({ text: `Remove ${stamp.name} from ${stamp.collection ?? ""} › ${stamp.category}?`, stamps: [stamp] });
            }
          }}
        >
          {manage && stamp.source === "mine" ? (
            <span className="drawing-stamp-remove" aria-hidden="true">
              ×
            </span>
          ) : null}
          <span className="drawing-stamp-thumb">
            {thumbnails.get(stamp.id) ? <img src={thumbnails.get(stamp.id)} alt="" draggable={false} /> : null}
          </span>
          {withNames ? (
            <>
              <span className="drawing-stamp-name">{stamp.name}</span>
              <span className="drawing-stamp-where">
                {stamp.collection ? `${stamp.collection} › ` : ""}
                {stamp.category}
              </span>
            </>
          ) : null}
        </button>
      ))}
    </div>
  );

  return (
    <div className="drawing-stamp-panel">
      <div className="drawing-stamp-heading">
        <h4 className="drawing-tools-heading">Stamps</h4>
        {library && myStamps.length > 0 ? (
          <button
            type="button"
            className={`drawing-link-button ${manage ? "active" : ""}`}
            onClick={() => {
              setManage(!manage);
              setConfirm(null);
            }}
          >
            {manage ? "Done" : "Manage"}
          </button>
        ) : null}
      </div>
      {manage ? <p className="drawing-muted">Click one of your stamps to remove it. Built-in stamps stay.</p> : null}
      {confirm ? (
        <div className="drawing-stamp-confirm" role="alertdialog" aria-label="Confirm removal">
          <span>{confirm.text}</span>
          <span className="drawing-muted">Drawings that already use {confirm.stamps.length === 1 ? "it" : "them"} don't change, and you can undo.</span>
          <div>
            <button type="button" className="danger" disabled={busy} onClick={() => void removeConfirmed()}>
              Remove
            </button>
            <button type="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {undo ? (
        <div className="drawing-stamp-undo" role="status">
          <span>{undo.text}</span>
          <button type="button" disabled={busy} onClick={() => void undoRemoval()}>
            Undo
          </button>
        </div>
      ) : null}
      <input
        type="search"
        className="drawing-stamp-search"
        placeholder="Search stamps, topics…"
        aria-label="Search stamps"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setQuery("");
        }}
      />

      {matches ? (
        matches.length > 0 ? (
          renderTiles(matches, true)
        ) : (
          <p className="drawing-muted">No stamps match “{query.trim()}”.</p>
        )
      ) : (
        collections.map(([collection, categories]) => (
          <section key={collection} className="drawing-stamp-collection">
            <h5 className="drawing-stamp-collection-name">{collection}</h5>
            {collection === "Unfiled" && library ? (
              <div className="drawing-stamp-unfiled">
                <span className="drawing-muted">Added before collections. File them so they sort with the rest.</span>
                <button type="button" disabled={busy} onClick={() => void openReview(library.onPreviewUnfiled)}>
                  File these…
                </button>
              </div>
            ) : null}
            {categories.map(([category, stamps]) => {
              const key = `${collection}/${category}`;
              const open = openGroups.has(key);
              return (
                <div key={key} className="drawing-stamp-group">
                  <button
                    type="button"
                    className={`drawing-stamp-group-header ${open ? "open" : ""}`}
                    aria-expanded={open}
                    onClick={() => toggleGroup(key)}
                  >
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                    <span className="drawing-stamp-group-name">{category}</span>
                    <span className="drawing-stamp-count">{stamps.length}</span>
                  </button>
                  {manage && stamps.some((stamp) => stamp.source === "mine") ? (
                    <button
                      type="button"
                      className="drawing-link-button drawing-stamp-remove-category"
                      onClick={() => {
                        const mine = stamps.filter((stamp) => stamp.source === "mine");
                        setConfirm({
                          text: `Remove your ${mine.length} stamp${mine.length === 1 ? "" : "s"} in ${collection} › ${category}?`,
                          stamps: mine,
                        });
                      }}
                    >
                      Remove {stamps.filter((stamp) => stamp.source === "mine").length} of yours
                    </button>
                  ) : null}
                  {open ? renderTiles(stamps, false) : null}
                </div>
              );
            })}
          </section>
        ))
      )}

      {library?.error ? <p className="drawing-error">{library.error}</p> : null}
      {library ? (
        <>
          <button type="button" className="drawing-stamp-add" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            {busy ? "Reading…" : "Add stamps (SVG or zip)…"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".svg,.zip,image/svg+xml,application/zip"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) void openReview(() => library.onPreviewImport(files));
            }}
          />
          <button type="button" className="drawing-link-button" onClick={() => setFormatOpen(true)}>
            Pack format & template…
          </button>
          {library.folder ? (
            <p className="drawing-muted drawing-stamp-folder" title={library.folder}>
              Your stamps are saved in the “{library.folder.split(/[\\/]/).filter(Boolean).pop()}” folder.
            </p>
          ) : null}
        </>
      ) : null}
      {messages.map((message, index) => (
        <p key={index} className={message.error ? "drawing-error" : "drawing-muted"}>
          {message.text}
        </p>
      ))}

      {formatOpen && library ? <PackFormatDialog onSaveFile={library.onSaveFile} onClose={() => setFormatOpen(false)} /> : null}
      {review && library ? (
        <StampImportReview
          review={review}
          knownCollections={Object.fromEntries(
            groupByCollection(BUILT_IN_STAMPS).map(([collection, categories]) => [collection, categories.map(([category]) => category)]),
          )}
          onCancel={() => setReview(null)}
          onImport={async (choices) => {
            const result = await library.onCommitImport(review.token, choices);
            setReview(null);
            setMessages([
              { text: summarize(result), error: false },
              ...result.messages.map((text) => ({ text, error: true })),
            ]);
          }}
        />
      ) : null}
    </div>
  );
}
