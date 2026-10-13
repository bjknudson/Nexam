// Send feedback: a bug, a suggestion or anything else, written in a short
// form and sent by email (or copied, for webmail), with the app version,
// system and screen added automatically. Testers need no account.
// See docs/beta-feedback.md.

import { useEffect, useRef, useState } from "react";

import { getBackendHealth } from "../api";
import { getAppVersion, isDesktopShell, openExternalLink } from "../desktop";
import { FEEDBACK_AREAS, FEEDBACK_EMAIL, FEEDBACK_KINDS, type FeedbackKind } from "./config";
import {
  describeOs,
  emptyDraft,
  fieldLabels,
  hasContent,
  mailtoUrl,
  reportBody,
  reportSubject,
  type FeedbackDraft,
  type SystemInfo,
} from "./report";

const DRAFT_KEY = "nexam:feedback-draft";
const NAME_KEY = "nexam:feedback-name";

// An unsent draft and the tester's name are per-viewer conveniences; storage
// may be unavailable, so every read and write is guarded.
function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not saved; the form still works.
  }
}

async function gatherSystem(windowName: string): Promise<SystemInfo> {
  const backendVersion = await getBackendHealth()
    .then((health) => health.version ?? null)
    .catch(() => null);
  const appVersion = (await getAppVersion().catch(() => null)) ?? backendVersion ?? "dev";
  return {
    appVersion,
    backendVersion,
    os: describeOs(navigator.userAgent, isDesktopShell()),
    window: windowName,
    screen: `${window.innerWidth}×${window.innerHeight}`,
  };
}

type Sent = { how: "email"; truncated: boolean } | { how: "copied" };

export default function FeedbackDialog({
  area,
  windowName,
  onClose,
}: {
  /** The part of Nexam the tester is using, as the form's starting area. */
  area: string;
  windowName: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<FeedbackDraft>(() => {
    const stored = readStored<FeedbackDraft>(DRAFT_KEY);
    const name = readStored<string>(NAME_KEY) ?? "";
    return stored && hasContent(stored) ? { ...emptyDraft(area), ...stored, screenshot: null } : { ...emptyDraft(area), name };
  });
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void gatherSystem(windowName).then(setSystem);
    firstFieldRef.current?.focus();
  }, [windowName]);

  useEffect(() => {
    writeStored(DRAFT_KEY, hasContent(draft) ? { ...draft, screenshot: null } : null);
  }, [draft]);

  useEffect(() => () => {
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
  }, [screenshotUrl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const update = (patch: Partial<FeedbackDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const labels = fieldLabels(draft.kind);
  const kind = FEEDBACK_KINDS.find((item) => item.id === draft.kind) ?? FEEDBACK_KINDS[0];
  const areas = FEEDBACK_AREAS.includes(draft.area) ? FEEDBACK_AREAS : [draft.area, ...FEEDBACK_AREAS];
  const ready = hasContent(draft) && system !== null;
  const subject = system ? reportSubject(draft, system.appVersion) : "";
  const body = system ? reportBody(draft, system) : "";

  async function copyReport(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(`${subject}\n\n${body}`);
      return true;
    } catch {
      setError("Couldn't copy to the clipboard. Select the report under “See the full report” and copy it.");
      return false;
    }
  }

  async function openEmail() {
    if (!system) return;
    writeStored(NAME_KEY, draft.name.trim() || null);
    const mail = mailtoUrl(FEEDBACK_EMAIL, subject, body);
    // A long report goes on the clipboard; the email says to paste it.
    if (mail.truncated && !(await copyReport())) return;
    try {
      await openExternalLink(mail.url);
      setError(null);
      setSent({ how: "email", truncated: mail.truncated });
    } catch {
      setError("Couldn't open your email app. Use Copy report instead, and paste it into an email.");
    }
  }

  async function copyOnly() {
    writeStored(NAME_KEY, draft.name.trim() || null);
    if (await copyReport()) {
      setError(null);
      setSent({ how: "copied" });
    }
  }

  function finish() {
    writeStored(DRAFT_KEY, null);
    onClose();
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Send feedback</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close feedback">
            &times;
          </button>
        </div>

        {sent ? (
          <div className="feedback-body feedback-sent">
            {sent.how === "email" ? (
              <>
                <p>
                  <strong>Your email app should now have the report ready.</strong> Check it, then press Send there.
                </p>
                {sent.truncated ? <p>The report was long, so it's on your clipboard: paste it into the email.</p> : null}
              </>
            ) : (
              <p>
                <strong>The report is copied.</strong> Paste it into an email
                {FEEDBACK_EMAIL ? (
                  <>
                    {" "}to <code>{FEEDBACK_EMAIL}</code>
                  </>
                ) : (
                  " to the Nexam team"
                )}
                , then send it.
              </p>
            )}
            {draft.screenshot ? (
              <p className="feedback-attach-note">
                Remember to attach your screenshot, <strong>{draft.screenshot}</strong>.
              </p>
            ) : null}
            <div className="feedback-actions">
              <button type="button" onClick={() => setSent(null)}>
                Back to the report
              </button>
              <button type="button" className="primary" onClick={finish}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            className="feedback-body"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready) void (FEEDBACK_EMAIL ? openEmail() : copyOnly());
            }}
          >
            <div className="feedback-kinds" role="radiogroup" aria-label="Kind of feedback">
              {FEEDBACK_KINDS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === item.id}
                  className={draft.kind === item.id ? "active" : ""}
                  onClick={() => update({ kind: item.id as FeedbackKind })}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="feedback-hint">{kind.hint}</p>

            <label>
              Area of Nexam
              <select value={draft.area} onChange={(event) => update({ area: event.target.value })}>
                {areas.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>

            <label>
              In a few words
              <input
                ref={firstFieldRef}
                value={draft.summary}
                maxLength={120}
                placeholder={draft.kind === "bug" ? "e.g. The arc jumps when I drag its end" : "e.g. Copy a whole course"}
                onChange={(event) => update({ summary: event.target.value })}
              />
            </label>

            <label>
              {labels.details}
              <textarea rows={3} value={draft.details} onChange={(event) => update({ details: event.target.value })} />
            </label>
            {labels.expected ? (
              <label>
                {labels.expected}
                <textarea rows={2} value={draft.expected} onChange={(event) => update({ expected: event.target.value })} />
              </label>
            ) : null}
            {labels.steps ? (
              <label>
                {labels.steps}
                <textarea rows={3} value={draft.steps} placeholder={"1. …\n2. …"} onChange={(event) => update({ steps: event.target.value })} />
              </label>
            ) : null}

            <div className="feedback-screenshot">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
                  setScreenshotUrl(URL.createObjectURL(file));
                  update({ screenshot: file.name });
                  event.target.value = "";
                }}
              />
              {draft.screenshot && screenshotUrl ? (
                <div className="feedback-screenshot-chosen">
                  <img src={screenshotUrl} alt={`Screenshot ${draft.screenshot}`} />
                  <div>
                    <strong>{draft.screenshot}</strong>
                    <span>You'll attach it to the email. Check it shows no student names or other private information.</span>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        URL.revokeObjectURL(screenshotUrl);
                        setScreenshotUrl(null);
                        update({ screenshot: null });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => fileRef.current?.click()}>
                  Choose a screenshot… <span className="feedback-optional">(optional)</span>
                </button>
              )}
            </div>

            <label>
              Your name <span className="feedback-optional">(optional, remembered on this computer)</span>
              <input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
            </label>

            <label className="feedback-check">
              <input type="checkbox" checked={draft.includeSystem} onChange={(event) => update({ includeSystem: event.target.checked })} />
              <span>
                Include the Nexam version and system details
                {system ? (
                  <span className="feedback-system">
                    Nexam {system.appVersion} · {system.os} · {system.window} window · {system.screen}
                  </span>
                ) : null}
              </span>
            </label>

            {ready ? (
              <details className="feedback-preview">
                <summary>See the full report</summary>
                <pre>{`${subject}\n\n${body}`}</pre>
              </details>
            ) : null}

            {error ? <p className="feedback-error">{error}</p> : null}

            <div className="feedback-actions">
              <span className="feedback-destination">
                {FEEDBACK_EMAIL ? (
                  <>
                    Goes to <code>{FEEDBACK_EMAIL}</code> from your email app.
                  </>
                ) : (
                  "Copy the report and email it to the Nexam team."
                )}
              </span>
              {FEEDBACK_EMAIL ? (
                <button type="button" disabled={!ready} onClick={() => void copyOnly()}>
                  Copy report
                </button>
              ) : null}
              <button type="submit" className="primary" disabled={!ready}>
                {FEEDBACK_EMAIL ? "Open in email" : "Copy report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
