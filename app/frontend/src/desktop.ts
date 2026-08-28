import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

import type { DesktopContext } from "./types";

type PaneKind =
  | "questions"
  | "assets"
  | "standards"
  | "courses"
  | "test-preview"
  | "response-sheet-print"
  | "editor"
  | "tests";

interface OpenPaneWindowOptions {
  mode?: string;
  width?: number;
  height?: number;
}

function getPaneWindowLabel(pane: PaneKind, mode?: string): string {
  return mode ? `nexzam-${pane}-${mode}-pane` : `nexzam-${pane}-pane`;
}

export function isDesktopShell(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function getDesktopContext(): Promise<DesktopContext | null> {
  if (!isDesktopShell()) return null;
  return invoke<DesktopContext>("get_desktop_context");
}

export async function openBankDialog(initialDirectory?: string | null): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return invoke<string | null>("open_bank_dialog", {
    initialDirectory: initialDirectory ?? null,
  });
}

export async function saveBankDialog(
  currentPath?: string | null,
  options: { suggestedFileName?: string | null; initialDirectory?: string | null } = {},
): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return invoke<string | null>("save_bank_dialog", {
    currentPath: currentPath ?? null,
    suggestedFileName: options.suggestedFileName ?? null,
    initialDirectory: options.initialDirectory ?? null,
  });
}

export async function openGradebookDialog(initialDirectory?: string | null): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return invoke<string | null>("open_gradebook_dialog", {
    initialDirectory: initialDirectory ?? null,
  });
}

export async function saveGradebookDialog(
  currentPath?: string | null,
  options: { suggestedFileName?: string | null; initialDirectory?: string | null } = {},
): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return invoke<string | null>("save_gradebook_dialog", {
    currentPath: currentPath ?? null,
    suggestedFileName: options.suggestedFileName ?? null,
    initialDirectory: options.initialDirectory ?? null,
  });
}

export async function pickDirectoryDialog(initialDirectory?: string | null): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return invoke<string | null>("pick_directory_dialog", {
    initialDirectory: initialDirectory ?? null,
  });
}

export async function resolveDefaultBankDirectory(): Promise<string | null> {
  if (!isDesktopShell()) return null;
  try {
    const { documentDir, join } = await import("@tauri-apps/api/path");
    const documents = await documentDir();
    return join(documents, "Nexzam");
  } catch {
    // `documentDir` is a capability-gated core command. A window without that
    // permission must still be able to open its file dialog -- just without a
    // starting directory -- rather than failing before the picker is reached.
    return null;
  }
}

export async function setArchiveDirtyInShell(dirty: boolean): Promise<void> {
  if (!isDesktopShell()) return;
  await invoke("set_archive_dirty", { dirty });
}

/** Open the system print dialog for this window.
 *
 *  `window.print()` does nothing inside the macOS webview, so in the desktop
 *  shell the request goes back to Rust, which sets the paper size the test was
 *  laid out for and then opens the print panel. In a browser there is no shell
 *  to ask, and `window.print()` works there anyway.
 */
export async function printCurrentWindow(pageSize: string): Promise<void> {
  if (!isDesktopShell()) {
    window.print();
    return;
  }
  await invoke("print_current_window", { pageSize });
}

/** Show a generated PDF in a Nexzam window and open the print dialog on it,
 *  rather than saving a file and asking the teacher to print it elsewhere. */
export async function printPdfUrl(url: string, title?: string): Promise<void> {
  if (!isDesktopShell()) {
    // A browser can open the PDF in a tab, where its own print button works.
    window.open(url, "_blank", "noopener");
    return;
  }
  await invoke("print_pdf_url", { url, title: title ?? null });
}

export async function openPaneWindow(
  pane: PaneKind,
  title: string,
  options: OpenPaneWindowOptions = {},
): Promise<void> {
  const url = new URL(window.location.href);
  url.searchParams.set("pane", pane);
  if (options.mode) {
    url.searchParams.set("mode", options.mode);
  }

  const label = getPaneWindowLabel(pane, options.mode);

  if (!isDesktopShell()) {
    const popup = window.open(
      url.toString(),
      label,
      `popup=yes,width=${options.width ?? 1180},height=${options.height ?? 860},resizable=yes,scrollbars=no`,
    );
    if (!popup) {
      throw new Error(`Failed to open the ${pane} window.`);
    }
    popup.focus();
    return;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(label);

  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const child = new WebviewWindow(label, {
    url: url.toString(),
    title,
    width: options.width ?? 1180,
    height: options.height ?? 860,
    resizable: true,
    focus: true,
  });

  await new Promise<void>((resolve, reject) => {
    void child.once("tauri://created", () => resolve());
    void child.once("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
}

const GRADEBOOK_WINDOW_LABEL = "nexzam-gradebook";

/** Open the gradebook as its own top-level window/tab -- a separate document
 *  from the currently open bank, not a pane of it, so it gets its own query
 *  param and window label rather than reusing PaneKind/openPaneWindow. See
 *  docs/grading.md. */
export async function openGradebookWindow(
  intent?: "new" | "open" | "demo",
): Promise<void> {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("app", "gradebook");
  // Carries File-menu intent through to the gradebook window, which reads it on
  // load so "Open Demo Gradebook" lands on the demo rather than a chooser.
  if (intent) url.searchParams.set("intent", intent);

  if (!isDesktopShell()) {
    const popup = window.open(
      url.toString(),
      GRADEBOOK_WINDOW_LABEL,
      "popup=yes,width=1200,height=860,resizable=yes,scrollbars=no",
    );
    if (!popup) {
      throw new Error("Failed to open the gradebook window.");
    }
    popup.focus();
    return;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(GRADEBOOK_WINDOW_LABEL);

  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const child = new WebviewWindow(GRADEBOOK_WINDOW_LABEL, {
    url: url.toString(),
    title: "Nexzam Gradebook",
    width: 1200,
    height: 860,
    resizable: true,
    focus: true,
  });

  await new Promise<void>((resolve, reject) => {
    void child.once("tauri://created", () => resolve());
    void child.once("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
}

/** Save arbitrary bytes (e.g. a generated PDF) to a user-chosen path via a
 *  native "Save As" dialog. Returns null in a browser tab (no OS dialog to
 *  back it) or if the user cancels. */
export async function saveBytesDialog(
  bytes: Uint8Array,
  options: { suggestedFileName?: string | null; initialDirectory?: string | null } = {},
): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return invoke<string | null>("save_bytes_dialog", {
    bytes: Array.from(bytes),
    suggestedFileName: options.suggestedFileName ?? null,
    initialDirectory: options.initialDirectory ?? null,
  });
}

export async function watchPaneWindowClose(
  pane: PaneKind,
  onClose: () => void,
): Promise<UnlistenFn | null> {
  if (!isDesktopShell()) {
    return null;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(getPaneWindowLabel(pane));
  if (!existing) {
    return null;
  }

  return existing.once("tauri://destroyed", () => {
    onClose();
  });
}

export async function checkForUpdates(): Promise<void> {
  if (!isDesktopShell()) return;
  await invoke("check_for_updates");
}

async function onMenuEvent(eventName: string, callback: () => void): Promise<UnlistenFn | null> {
  if (!isDesktopShell()) return null;
  const { listen } = await import("@tauri-apps/api/event");
  return listen(eventName, () => callback());
}

export function onOpenSettings(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://open-settings", callback);
}

export function onNewBankMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://new-bank", callback);
}

export function onOpenBankMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://open-bank", callback);
}

export function onBankPropertiesMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://bank-properties", callback);
}

export function onOpenDemoBankMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://open-demo-bank", callback);
}

export function onSaveBankMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://save-bank", callback);
}

export function onSaveAsMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://save-as", callback);
}

export function onCloseBankMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://close-bank", callback);
}

export function onNewGradebookMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://new-gradebook", callback);
}

export function onOpenGradebookMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://open-gradebook", callback);
}

export function onOpenDemoGradebookMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://open-demo-gradebook", callback);
}

export function onCloseGradebookMenu(callback: () => void): Promise<UnlistenFn | null> {
  return onMenuEvent("nexzam://close-gradebook", callback);
}

/** Tell the shell which "close" menu commands should be available. */
export async function setDocumentMenuState(
  bankOpen: boolean,
  gradebookOpen: boolean,
): Promise<void> {
  if (!isDesktopShell()) return;
  await invoke("set_document_menu_state", { bankOpen, gradebookOpen });
}

export async function getAppVersion(): Promise<string | null> {
  if (!isDesktopShell()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function closeCurrentPaneWindow(): Promise<void> {
  if (!isDesktopShell()) {
    window.close();
    return;
  }

  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().close();
}
