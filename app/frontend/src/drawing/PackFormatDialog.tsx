/// <reference types="vite/client" />
// "Pack format…": the stamp-pack template and instructions, for whoever (or
// whatever tool) prepares stamp packs. The files are the ones in
// docs/stamp-packs/, imported as text, so the app shows exactly the format
// the importer reads.

import { useEffect, useState } from "react";

import guide from "../../../../docs/stamp-packs/README.md?raw";
import readmeTemplate from "../../../../docs/stamp-packs/README.template.txt?raw";
import example from "../../../../docs/stamp-packs/stamps.example.json?raw";
import schema from "../../../../docs/stamp-packs/stamps.schema.json?raw";
import template from "../../../../docs/stamp-packs/stamps.template.json?raw";

export const PACK_FILES: { name: string; purpose: string; content: string }[] = [
  { name: "stamps.template.json", purpose: "The manifest to fill in: replace every <…>.", content: template },
  { name: "stamps.example.json", purpose: "A complete, valid manifest for a real batch.", content: example },
  { name: "stamps.schema.json", purpose: "JSON Schema to check a manifest before zipping.", content: schema },
  { name: "README.template.txt", purpose: "The text fallback, if a tool can only write a README.", content: readmeTemplate },
  { name: "stamp-pack-format.md", purpose: "The full guide: every rule, limit and example.", content: guide },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older webviews: fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export default function PackFormatDialog({
  onSaveFile,
  onClose,
}: {
  /** Saves a file where the teacher chooses; resolves false if cancelled. */
  onSaveFile: (name: string, content: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="drawing-dialog-backdrop">
      <div className="drawing-dialog pack-format" role="dialog" aria-modal="true" aria-labelledby="pack-format-title">
        <div className="pack-format-header">
          <h2 id="pack-format-title">Stamp pack format</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p>
          A stamp pack is a <strong>.zip of SVG files plus a <code>stamps.json</code> manifest</strong> that says where each
          stamp belongs. Add one with <em>Add stamps (SVG or zip)…</em>; you'll see an import review before anything is saved.
        </p>
        <dl className="pack-format-terms">
          <dt>Collection</dt>
          <dd>The subject, e.g. Physics. The top heading in the Stamps panel.</dd>
          <dt>Category</dt>
          <dd>What the stamp is, e.g. Mechanics, Vectors, Guides.</dd>
          <dt>Topics</dt>
          <dd>Curriculum topics it's useful for, worded like your questions' topics, e.g. Collisions, Newton's Laws.</dd>
          <dt>Tags</dt>
          <dd>Optional look-and-feel search words, e.g. top-view, dashed.</dd>
        </dl>
        <ul className="pack-format-rules">
          <li>Packs are delivery batches: the pack name is never a heading, so batch 02 lands beside batch 01.</li>
          <li>Spell collections and categories the same way every time (case doesn't matter; "Vector" vs "Vectors" does).</li>
          <li>Keep SVG file names stable across batches: re-sent stamps merge instead of duplicating.</li>
          <li>A stamp's own topics or tags replace the pack defaults; <code>[]</code> means none.</li>
          <li>SVGs: UTF-8, root <code>&lt;svg&gt;</code> with a viewBox and print-size width/height (96 px = 1 in), black/gray or currentColor, no external files. Up to 200 files, 512 KB each.</li>
        </ul>

        <h3>Template files</h3>
        <ul className="pack-format-files">
          {PACK_FILES.map((file) => (
            <li key={file.name}>
              <div className="pack-format-file">
                <div>
                  <code>{file.name}</code>
                  <span>{file.purpose}</span>
                </div>
                <div className="pack-format-actions">
                  <button type="button" aria-expanded={open === file.name} onClick={() => setOpen(open === file.name ? null : file.name)}>
                    {open === file.name ? "Hide" : "View"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => setStatus((await copyText(file.content)) ? `Copied ${file.name}.` : "Couldn't copy; use Save instead.")}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        if (await onSaveFile(file.name, file.content)) setStatus(`Saved ${file.name}.`);
                      } catch (error) {
                        setStatus(error instanceof Error ? error.message : "Couldn't save.");
                      }
                    }}
                  >
                    Save…
                  </button>
                </div>
              </div>
              {open === file.name ? <pre className="pack-format-preview">{file.content}</pre> : null}
            </li>
          ))}
        </ul>
        {status ? (
          <p className="drawing-muted" role="status">
            {status}
          </p>
        ) : null}
      </div>
    </div>
  );
}
