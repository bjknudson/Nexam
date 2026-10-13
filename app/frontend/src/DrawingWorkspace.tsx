import { useEffect, useRef, useState } from "react";

import {
  commitStampImport,
  fetchAssetText,
  getQuestion,
  listAssets,
  listQuestions,
  listStamps,
  previewStampImport,
  previewUnfiledStamps,
  removeStamps,
  restoreStamps,
  updateQuestion,
  uploadAsset,
  writeSvgAsset,
} from "./api";
import { drawingInputSamples, resolveAssetVariables, withSeededVariables } from "./questionVariables";
import { assetUsesIn, swapAssetPath } from "./assetSwap";
import { isDesktopShell, saveBytesDialog } from "./desktop";
import DrawingEditor from "./drawing/DrawingEditor";
import { listVariables } from "./drawing/scene";
import type { Stamp } from "./drawing/stamps";
import { parseSvg } from "./drawing/svgIO";
import type { StampModel } from "./types";

/** The drawing window (`?pane=drawing`, optionally `#asset=assets/x.svg&question=q_id`).
 *  Connects the self-contained editor in ./drawing to the open bank:
 *  - a new drawing is uploaded as a new asset on first save;
 *  - an existing one is overwritten in place, unless other questions use it,
 *    in which case the teacher chooses between a copy and updating them all
 *    (see "Editing existing assets" in docs/svg-editor-plan.md). */
export default function DrawingWorkspace() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const [assetPath, setAssetPath] = useState<string | null>(() => hashParams.get("asset"));
  // The question the drawing was opened from, if any. Fixed for the window's life.
  const [questionId] = useState<string | null>(() => hashParams.get("question"));
  // "Copy to new drawing": start from this asset's content, but save as a new file.
  const [copyFrom] = useState<string | null>(() => (hashParams.get("asset") ? null : hashParams.get("copy")));
  // undefined while loading; null for a new drawing.
  const [source, setSource] = useState<string | null | undefined>(assetPath || copyFrom ? undefined : null);
  const [questionValues, setQuestionValues] = useState<Record<string, string> | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState(() =>
    copyFrom ? `${(copyFrom.split("/").pop() ?? "drawing.svg").replace(/\.svg$/i, "")}-copy.svg` : "drawing.svg",
  );
  const [myStamps, setMyStamps] = useState<Stamp[]>([]);
  const [stampFolder, setStampFolder] = useState<string | null>(null);
  const [stampError, setStampError] = useState<string | null>(null);
  const [saveChoice, setSaveChoice] = useState<SaveChoiceRequest | null>(null);
  /** Shown after a save added the drawing's new inputs to its question. */
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const [topicSuggestions, setTopicSuggestions] = useState<{ bank: string[]; fromQuestions: string[] }>({
    bank: [],
    fromQuestions: [],
  });

  async function refreshStamps() {
    try {
      const response = await listStamps();
      setMyStamps(response.items.map(toStamp));
      setStampFolder(response.folder);
      setStampError(null);
    } catch (error) {
      setStampError(error instanceof Error ? error.message : "Could not read the stamp folder.");
    }
  }

  useEffect(() => {
    void refreshStamps();
  }, []);

  // Topic suggestions: the bank's question topics and subtopics, and first of
  // all those of the questions that use this drawing.
  useEffect(() => {
    void (async () => {
      try {
        const { items } = await listQuestions({});
        const bank = uniqueSorted(items.flatMap((item) => [item.topic, item.subtopic ?? ""]));
        let fromQuestions: string[] = [];
        if (assetPath) {
          const usedBy = (await listAssets()).items.find((item) => item.path === assetPath)?.referenced_by ?? [];
          const ids = new Set([...(questionId ? [questionId] : []), ...usedBy]);
          fromQuestions = uniqueSorted(items.filter((item) => ids.has(item.id)).flatMap((item) => [item.topic, item.subtopic ?? ""]));
        }
        setTopicSuggestions({ bank, fromQuestions });
      } catch {
        // Suggestions are a convenience; typing topics still works without them.
      }
    })();
  }, [assetPath, questionId]);

  useEffect(() => {
    if (copyFrom && source === undefined) {
      fetchAssetText(copyFrom)
        .then(setSource)
        .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Could not load the drawing to copy."));
      return;
    }
    if (!assetPath || source !== undefined) return;
    // Opened from a question: start the preview with that question's values,
    // so the drawing looks the way it does in the question.
    const values = questionId
      ? getQuestion(questionId)
          .then((detail) => {
            const use = assetUsesIn(detail.question, assetPath)[0];
            return use ? resolveAssetVariables(detail.question.variables, use.svg_variables) : detail.question.variables;
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
    Promise.all([fetchAssetText(assetPath), values])
      .then(([text, svgVariables]) => {
        setQuestionValues(svgVariables);
        setSource(text);
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Could not load the drawing."));
    // Only on first load: after a save the editor already holds the content.
  }, []);

  useEffect(() => {
    const name = assetPath?.split("/").pop();
    document.title = name ? `Drawing — ${name}` : "New Drawing";
  }, [assetPath]);

  function switchToAsset(path: string) {
    setAssetPath(path);
    // Reloading the window reopens the saved file instead of a blank drawing.
    const url = new URL(window.location.href);
    url.hash = new URLSearchParams({ asset: path, ...(questionId ? { question: questionId } : {}) }).toString();
    window.history.replaceState(null, "", url);
  }

  /** Opened from a question: give it this drawing's new inputs. Never blocks a save. */
  async function seedQuestion(path: string, svg: string): Promise<void> {
    if (!questionId) return;
    try {
      const added = await addNewInputsToQuestion(questionId, path, svg);
      if (added > 0) setSeedNote(`Added ${added} new variable${added === 1 ? "" : "s"} to ${questionId}, with this drawing's sample values.`);
    } catch {
      // The drawing is saved; the question just doesn't get the new inputs yet.
    }
  }

  async function handleSave(svg: string): Promise<void | "cancelled"> {
    if (!assetPath) {
      const uploaded = await uploadAsset(svgFile(svg, normalizeFileName(fileName)));
      switchToAsset(uploaded.path);
      announceAssetsChanged();
      return;
    }

    const usedBy = (await listAssets()).items.find((item) => item.path === assetPath)?.referenced_by ?? [];
    const others = usedBy.filter((id) => id !== questionId);
    if (others.length === 0) {
      await writeSvgAsset(assetPath, svg);
      await seedQuestion(assetPath, svg);
      announceAssetsChanged();
      return;
    }

    const warnings = await variableWarnings(svg, assetPath, usedBy);
    const choice = await new Promise<SaveChoice>((resolve) =>
      setSaveChoice({ assetPath, questionId, usedBy, warnings, resolve }),
    );
    setSaveChoice(null);
    if (choice === "cancel") return "cancelled";

    if (choice === "update-all") {
      await writeSvgAsset(assetPath, svg);
      await seedQuestion(assetPath, svg);
      announceAssetsChanged();
      return;
    }

    // A copy: the upload picks a free name next to the original (fig.svg -> fig-1.svg).
    const original = assetPath;
    const uploaded = await uploadAsset(svgFile(svg, original.split("/").pop() ?? "drawing.svg"));
    if (questionId && usedBy.includes(questionId)) {
      await pointQuestionAtCopy(questionId, original, uploaded.path);
      await seedQuestion(uploaded.path, svg);
    }
    switchToAsset(uploaded.path);
    announceAssetsChanged();
  }

  if (loadError) {
    return (
      <main className="drawing-load-message">
        <p>{loadError}</p>
      </main>
    );
  }
  if (source === undefined) {
    return (
      <main className="drawing-load-message">
        <p>Loading drawing…</p>
      </main>
    );
  }

  return (
    <>
      <DrawingEditor
        initialSource={source}
        initialPreviewValues={questionValues}
        topicSuggestions={topicSuggestions}
        onSave={handleSave}
        stampLibrary={{
          stamps: myStamps,
          folder: stampFolder,
          error: stampError,
          onPreviewImport: previewStampImport,
          onPreviewUnfiled: previewUnfiledStamps,
          onCommitImport: async (token, choices) => {
            const result = await commitStampImport(token, choices);
            await refreshStamps();
            return result;
          },
          onRemove: async (stamps) => {
            const result = await removeStamps(stamps.map((stamp) => stamp.id.replace(/^mine:/, "")));
            await refreshStamps();
            return { removalId: result.removal_id, removed: result.removed };
          },
          onRestore: async (removalId) => {
            await restoreStamps(removalId);
            await refreshStamps();
          },
          onSaveFile: saveTextFile,
        }}
        headerStart={
          <div className="drawing-file-field">
            {assetPath ? (
              <strong title={assetPath}>{assetPath.split("/").pop()}</strong>
            ) : (
              <label>
                File name
                <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
              </label>
            )}
            <span className="drawing-file-note">
              {seedNote ?? `${questionId ? `For ${questionId}. ` : ""}Saves into the open bank's assets. Save the bank to keep it.`}
            </span>
          </div>
        }
      />
      {saveChoice ? <SaveChoiceDialog request={saveChoice} /> : null}
    </>
  );
}

type SaveChoice = "copy" | "update-all" | "cancel";

interface SaveChoiceRequest {
  assetPath: string;
  questionId: string | null;
  usedBy: string[];
  warnings: string[];
  resolve: (choice: SaveChoice) => void;
}

/** Asked when saving would change other questions. The safe choice (a copy)
 *  is the default; updating every question is there for shared fixes. */
function SaveChoiceDialog({ request }: { request: SaveChoiceRequest }) {
  const { assetPath, questionId, usedBy, warnings, resolve } = request;
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const forThisQuestion = questionId !== null && usedBy.includes(questionId);
  const name = assetPath.split("/").pop();

  useEffect(() => {
    copyRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") resolve("cancel");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resolve]);

  return (
    <div className="drawing-dialog-backdrop">
      <div className="drawing-dialog" role="dialog" aria-modal="true" aria-labelledby="save-choice-title">
        <h2 id="save-choice-title">
          {name} is used by {usedBy.length} question{usedBy.length === 1 ? "" : "s"}
        </h2>
        <ul className="drawing-dialog-list">
          {usedBy.map((id) => (
            <li key={id}>
              {id}
              {id === questionId ? " (this question)" : ""}
            </li>
          ))}
        </ul>
        {warnings.length > 0 ? (
          <div className="drawing-dialog-warning">
            <strong>Updating all of them would break:</strong>
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="drawing-dialog-choices">
          <button ref={copyRef} type="button" className="primary" onClick={() => resolve("copy")}>
            {forThisQuestion ? `Save as a copy for ${questionId}` : "Save as a new asset"}
            <span>
              {forThisQuestion
                ? `${questionId} switches to the copy and keeps its variable values. The other questions keep the original.`
                : "The original stays as it is. The copy isn't attached to any question yet."}
            </span>
          </button>
          <button type="button" className={warnings.length > 0 ? "danger" : ""} onClick={() => resolve("update-all")}>
            Update all {usedBy.length} question{usedBy.length === 1 ? "" : "s"}
            <span>Overwrite {name}. Use this for a fix every question should get.</span>
          </button>
          <button type="button" onClick={() => resolve("cancel")}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Variables some question sets for this asset that the edited drawing no longer uses. */
async function variableWarnings(svg: string, assetPath: string, usedBy: string[]): Promise<string[]> {
  let remaining: Set<string>;
  try {
    remaining = new Set(listVariables(parseSvg(svg).document));
  } catch {
    return [];
  }
  const warnings: string[] = [];
  // Asking for each question is fine for the handful that share a figure.
  for (const id of usedBy.slice(0, 40)) {
    try {
      const { question } = await getQuestion(id);
      const lost = new Set<string>();
      for (const use of assetUsesIn(question, assetPath)) {
        for (const [name, value] of Object.entries(use.svg_variables)) {
          if (value !== "" && !remaining.has(name)) lost.add(name);
        }
      }
      if (lost.size > 0) {
        warnings.push(`${id} sets ${[...lost].join(", ")}, which this drawing no longer uses.`);
      }
    } catch {
      // A question that can't be read can't be checked; it is still listed above.
    }
  }
  return warnings;
}

/** Ask the window editing `questionId` (if any) to swap in the copy, so its
 *  unsaved draft isn't overwritten; if nobody answers, nobody is editing
 *  that question and it is safe to update it directly. */
/** Sends `message` to the main window and waits briefly for its ack. The
 *  main window applies the change to its open draft (so its autosave doesn't
 *  overwrite it); false means no window took it, so the caller writes it
 *  through the API instead. */
function askMainWindow(message: Record<string, unknown>, ackType: string): Promise<boolean> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<boolean>((resolve) => {
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel("nexam-pane-sync");
    } catch {
      resolve(false);
      return;
    }
    const timer = window.setTimeout(() => {
      channel.close();
      resolve(false);
    }, 1200);
    channel.onmessage = (event: MessageEvent<{ type?: string; requestId?: string }>) => {
      if (event.data?.type === ackType && event.data.requestId === requestId) {
        window.clearTimeout(timer);
        channel.close();
        resolve(true);
      }
    };
    channel.postMessage({ ...message, requestId });
  });
}

/** Points the question at a saved copy, through its open window if it has one. */
async function pointQuestionAtCopy(questionId: string, oldPath: string, newPath: string): Promise<void> {
  if (await askMainWindow({ type: "drawing-asset-replaced", questionId, oldPath, newPath }, "drawing-asset-replaced-ack")) return;
  const { question } = await getQuestion(questionId);
  await updateQuestion(questionId, swapAssetPath(question, oldPath, newPath));
}

/** A drawing saved from a question gives that question any new inputs (with
 *  their samples), so a value added while editing shows up there ready to set. */
async function addNewInputsToQuestion(questionId: string, assetPath: string, svg: string): Promise<number> {
  const samples = drawingInputSamples(parseSvg(svg).document);
  if (Object.keys(samples).length === 0) return 0;
  const { question } = await getQuestion(questionId);
  const seeded = withSeededVariables(question, assetPath, samples);
  if (!seeded) return 0;
  const added = Object.keys(seeded.variables ?? {}).length - Object.keys(question.variables ?? {}).length;
  if (await askMainWindow({ type: "question-variables-seed", questionId, assetPath, samples }, "question-variables-seed-ack")) return added;
  await updateQuestion(questionId, seeded);
  return added;
}

/** A native Save dialog in the desktop app; a download in a browser. */
async function saveTextFile(name: string, content: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(content);
  if (isDesktopShell()) return (await saveBytesDialog(bytes, { suggestedFileName: name })) !== null;
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function svgFile(svg: string, name: string): File {
  return new File([svg], name, { type: "image/svg+xml" });
}

function toStamp(stamp: StampModel): Stamp {
  return {
    id: `mine:${stamp.id}`,
    name: stamp.name,
    collection: stamp.collection || undefined,
    category: stamp.category,
    topics: stamp.topics,
    tags: stamp.tags,
    description: stamp.description,
    unfiled: stamp.unfiled,
    svg: stamp.svg,
    source: "mine",
  };
}

function normalizeFileName(name: string): string {
  const base = name.trim().replace(/[\\/]/g, "-") || "drawing";
  return base.toLowerCase().endsWith(".svg") ? base : `${base}.svg`;
}

/** Lets the main window (and a popped-out Bank Assets window) refresh its asset list. */
function announceAssetsChanged() {
  try {
    const channel = new BroadcastChannel("nexam-pane-sync");
    channel.postMessage({ type: "assets-changed" });
    channel.close();
  } catch {
    // BroadcastChannel is a convenience here, never a requirement.
  }
}
