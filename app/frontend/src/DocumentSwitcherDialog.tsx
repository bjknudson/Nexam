import type { RecentDocument } from "./appSettings";

export type DocumentSwitcherKind = "bank" | "gradebook";

const KIND_LABEL: Record<DocumentSwitcherKind, string> = {
  bank: "Bank",
  gradebook: "Gradebook",
};

interface DocumentSwitcherDialogProps {
  open: boolean;
  kind: DocumentSwitcherKind;
  recent: RecentDocument[];
  onClose: () => void;
  onNew: () => void;
  onSelect: () => void;
  onDemo: () => void;
  onPickRecent: (path: string) => void;
}

/** Shared "open/switch" chooser for both documents a teacher works with -- a
 *  bank and a gradebook. Deliberately generic (kind + callbacks) so the same
 *  dialog backs the mirrored buttons on each side of the header rather than
 *  two near-identical components drifting apart. */
function DocumentSwitcherDialog({
  open,
  kind,
  recent,
  onClose,
  onNew,
  onSelect,
  onDemo,
  onPickRecent,
}: DocumentSwitcherDialogProps) {
  if (!open) return null;

  const label = KIND_LABEL[kind];

  function choose(action: () => void) {
    action();
    onClose();
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Open ${label}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Open {label}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <button
              type="button"
              className="settings-row document-switcher-row"
              onClick={() => choose(onNew)}
            >
              New {label}
            </button>
            <button
              type="button"
              className="settings-row document-switcher-row"
              onClick={() => choose(onSelect)}
            >
              Select {label}…
            </button>
            <button
              type="button"
              className="settings-row document-switcher-row"
              onClick={() => choose(onDemo)}
            >
              Demo {label}
            </button>
          </section>

          {recent.length > 0 ? (
            <section className="settings-section">
              <h3>Recent</h3>
              {recent.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  className="settings-row document-switcher-row"
                  onClick={() => choose(() => onPickRecent(entry.path))}
                  title={entry.path}
                >
                  <span className="document-switcher-recent-title">{entry.title}</span>
                  <span className="document-switcher-recent-path">{entry.path}</span>
                </button>
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default DocumentSwitcherDialog;
