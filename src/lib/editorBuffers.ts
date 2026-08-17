/**
 * Session editor-buffer registry shared by file editors, editable diffs, and
 * close/quit flows. Editor views unmount on tab switches, so dirty text and a
 * callable live save operation cannot live only inside a React component.
 */
import { Text } from "@codemirror/state";
import { message } from "@tauri-apps/plugin-dialog";
import { fsReadFile, fsWriteFile } from "./ipc";
import type { EditorStore, Tab } from "../stores/editor";

export type LineEnding = "LF" | "CRLF" | "CR";

export interface BufferedEditor {
  path: string;
  text: Text;
  savedText: Text;
  /** Exact text last read/written, including its original separators. */
  savedDiskText: string;
  lineEnding: LineEnding;
}

type LiveSaver = (force: boolean) => Promise<boolean>;

const buffers = new WeakMap<EditorStore, Map<string, BufferedEditor>>();
const liveSavers = new WeakMap<EditorStore, Map<string, LiveSaver>>();

const entries = <T>(map: WeakMap<EditorStore, Map<string, T>>, editor: EditorStore) => {
  let value = map.get(editor);
  if (!value) {
    value = new Map();
    map.set(editor, value);
  }
  return value;
};

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const withoutCrlf = text.replace(/\r\n/g, "");
  const cr = (withoutCrlf.match(/\r/g) ?? []).length;
  const lf = (withoutCrlf.match(/\n/g) ?? []).length;
  if (crlf >= cr && crlf >= lf && crlf > 0) return "CRLF";
  if (cr > lf && cr > 0) return "CR";
  return "LF";
}

export const lineSeparator = (ending: LineEnding): string =>
  ending === "CRLF" ? "\r\n" : ending === "CR" ? "\r" : "\n";

export const serializeText = (text: Text, ending: LineEnding): string =>
  text.sliceString(0, text.length, lineSeparator(ending));

export const getBufferedEditor = (
  editor: EditorStore,
  tabId: string,
): BufferedEditor | null => buffers.get(editor)?.get(tabId) ?? null;

export const setBufferedEditor = (
  editor: EditorStore,
  tabId: string,
  value: BufferedEditor,
): void => {
  entries(buffers, editor).set(tabId, value);
};

export const clearBufferedEditor = (editor: EditorStore, tabId: string): void => {
  buffers.get(editor)?.delete(tabId);
};

export const peekDraft = (editor: EditorStore, tabId: string): string | null => {
  const draft = getBufferedEditor(editor, tabId);
  return draft ? serializeText(draft.text, draft.lineEnding) : null;
};

export function registerLiveSaver(
  editor: EditorStore,
  tabId: string,
  saver: LiveSaver,
): () => void {
  const map = entries(liveSavers, editor);
  map.set(tabId, saver);
  return () => {
    if (map.get(tabId) === saver) map.delete(tabId);
  };
}

function pathForTab(tab: Tab | undefined): string | null {
  if (tab?.kind === "file") return tab.path;
  if (tab?.kind === "diff" && tab.diff.kind === "worktree") {
    return `${tab.diff.repoPath.replace(/\/$/, "")}/${tab.diff.path}`;
  }
  return null;
}

/** Save a dirty tab whether its editor view is mounted or not. False means
    cancelled, conflicted, or failed and the caller must keep the tab open. */
export async function saveEditorTab(editor: EditorStore, tabId: string): Promise<boolean> {
  const live = liveSavers.get(editor)?.get(tabId);
  if (live) return live(false);

  const state = editor.getState();
  if (!state.dirty[tabId]) return true;
  const tab = state.tabs.find((item) => item.id === tabId);
  const path = pathForTab(tab);
  const draft = getBufferedEditor(editor, tabId);
  if (!path || !draft) {
    await message("This editor is no longer available to save.", {
      title: "Save Failed",
      kind: "error",
    });
    return false;
  }

  try {
    const disk = await fsReadFile(path).catch(() => null);
    if (disk && (disk.binary || disk.text !== draft.savedDiskText)) {
      const answer = await message(
        `“${tab?.title ?? "This file"}” changed on disk after it was opened.`,
        {
          title: "Overwrite Newer File?",
          kind: "warning",
          buttons: { ok: "Overwrite", cancel: "Cancel" },
        },
      );
      if (answer !== "Overwrite") return false;
    }
    await fsWriteFile(path, serializeText(draft.text, draft.lineEnding));
    clearBufferedEditor(editor, tabId);
    editor.getState().markDirty(tabId, false);
    return true;
  } catch (error) {
    await message(String(error), { title: "Save Failed", kind: "error" });
    return false;
  }
}

export async function saveDirtyTabs(editor: EditorStore): Promise<boolean> {
  const ids = Object.entries(editor.getState().dirty)
    .filter(([, dirty]) => dirty)
    .map(([id]) => id);
  for (const id of ids) {
    if (!(await saveEditorTab(editor, id))) return false;
  }
  return true;
}

/** Native three-way close prompt. Returns false only for Cancel/save failure. */
export async function confirmSaveDirtyTabs(
  editor: EditorStore,
  title: string,
  description: string,
): Promise<boolean> {
  for (;;) {
    const count = Object.values(editor.getState().dirty).filter(Boolean).length;
    if (count === 0) return true;
    const result = await message(description, {
      title,
      kind: "warning",
      buttons: { yes: count === 1 ? "Save" : "Save All", no: "Don’t Save", cancel: "Cancel" },
    });
    if (result === "Cancel") return false;
    if (result === "Don’t Save") return true;
    if (!(await saveDirtyTabs(editor))) return false;
    // Edits can land while an async write is in flight. Recheck rather than
    // treating the just-written snapshot as ownership of later keystrokes.
  }
}

/** Remove buffers no longer owned by an open tab. */
export function pruneEditorBuffers(editor: EditorStore): void {
  const live = new Set(editor.getState().tabs.map((tab) => tab.id));
  const map = buffers.get(editor);
  if (!map) return;
  for (const id of map.keys()) if (!live.has(id)) map.delete(id);
}
