// What's new in this beta: the release notes for this version and earlier
// ones, with what to try again. Shown once after an update, and from
// Help ▸ What's New in This Beta… See releaseNotes.ts.

import { useEffect } from "react";

import type { ReleaseNote } from "./releaseNotes";

export default function WhatsNewDialog({
  notes,
  version,
  onClose,
  onSendFeedback,
}: {
  notes: ReleaseNote[];
  version: string;
  onClose: () => void;
  onSendFeedback: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal feedback-modal whats-new-modal"
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>What's new in Nexam {version}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close what's new">
            &times;
          </button>
        </div>
        <div className="feedback-body">
          {notes.length === 0 ? (
            <p>No release notes for this version yet.</p>
          ) : (
            notes.map((note) => (
              <section key={note.version} className="whats-new-release">
                <h3>
                  {note.version}
                  {note.date ? <span> · {note.date}</span> : null}
                </h3>
                <ul>
                  {note.highlights.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                {note.retest && note.retest.length > 0 ? (
                  <>
                    <h4>Please try</h4>
                    <ul>
                      {note.retest.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </section>
            ))
          )}
          <p className="feedback-hint">
            Thank you for testing. If something doesn't work or could be better, tell us with Send feedback (also in the Help menu).
          </p>
          <div className="feedback-actions">
            <button type="button" onClick={onSendFeedback}>
              Send feedback…
            </button>
            <button type="button" className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
