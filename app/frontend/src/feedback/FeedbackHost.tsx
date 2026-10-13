// Mounted once in every Nexam window: opens Send feedback and What's new
// from the Help menu (only in the window that has focus, since every window
// hears the menu event) or from openFeedback(), and shows What's new once
// after an update in the main window.

import { useEffect, useState } from "react";

import { getBackendHealth } from "../api";
import { getAppVersion, onSendFeedbackMenu, onWhatsNewMenu } from "../desktop";
import { areaFor, windowNameFrom } from "./area";
import FeedbackDialog from "./FeedbackDialog";
import { notesUpTo, unseenNotes, type ReleaseNote } from "./releaseNotes";
import WhatsNewDialog from "./WhatsNewDialog";
import "./feedback.css";

const OPEN_FEEDBACK_EVENT = "nexam:open-feedback";
const LAST_SEEN_KEY = "nexam:whats-new-seen";

/** Opens the feedback form in this window (e.g. from a toolbar button). */
export function openFeedback(): void {
  window.dispatchEvent(new Event(OPEN_FEEDBACK_EVENT));
}

function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(version: string) {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, version);
  } catch {
    // What's new may then show again next launch; harmless.
  }
}

async function currentVersion(): Promise<string | null> {
  const app = await getAppVersion().catch(() => null);
  if (app) return app;
  return getBackendHealth()
    .then((health) => health.version ?? null)
    .catch(() => null);
}

export default function FeedbackHost() {
  const windowName = windowNameFrom(window.location.search);
  // Only the main window shows What's new by itself.
  const showWhatsNewOnUpdate = windowName === "main";
  const [feedbackOpen, setFeedbackOpen] = useState<string | null>(null);
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: ReleaseNote[] } | null>(null);

  async function showAllNotes() {
    const version = (await currentVersion()) ?? "";
    setWhatsNew({ version, notes: version ? notesUpTo(version) : [] });
    if (version) writeLastSeen(version);
  }

  useEffect(() => {
    // The area is read when the form opens, so the main window's current page counts.
    const open = () => setFeedbackOpen(areaFor(window.location.search));
    window.addEventListener(OPEN_FEEDBACK_EVENT, open);
    const unlisten: Array<() => void> = [];
    let cancelled = false;
    const listen = (register: (callback: () => void) => Promise<(() => void) | null>, callback: () => void) => {
      void register(() => {
        if (document.hasFocus()) callback();
      }).then((fn) => {
        if (!fn) return;
        if (cancelled) fn();
        else unlisten.push(fn);
      });
    };
    listen(onSendFeedbackMenu, open);
    listen(onWhatsNewMenu, () => void showAllNotes());
    return () => {
      cancelled = true;
      window.removeEventListener(OPEN_FEEDBACK_EVENT, open);
      unlisten.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!showWhatsNewOnUpdate) return;
    let cancelled = false;
    void currentVersion().then((version) => {
      if (cancelled || !version) return;
      const notes = unseenNotes(version, readLastSeen());
      writeLastSeen(version);
      if (notes.length > 0) setWhatsNew({ version, notes });
    });
    return () => {
      cancelled = true;
    };
  }, [showWhatsNewOnUpdate]);

  return (
    <>
      {feedbackOpen ? <FeedbackDialog area={feedbackOpen} windowName={windowName} onClose={() => setFeedbackOpen(null)} /> : null}
      {whatsNew && !feedbackOpen ? (
        <WhatsNewDialog
          notes={whatsNew.notes}
          version={whatsNew.version}
          onClose={() => setWhatsNew(null)}
          onSendFeedback={() => {
            setWhatsNew(null);
            setFeedbackOpen(areaFor(window.location.search));
          }}
        />
      ) : null}
    </>
  );
}
