import { useSyncExternalStore } from "react";
import type { EditorStore } from "../stores/editor";
import type { LineEnding } from "./editorBuffers";

export interface EditorStatusSnapshot {
  line: number;
  column: number;
  selected: number;
  lineEnding: LineEnding;
  indentation: string;
}

const statuses = new WeakMap<EditorStore, Map<string, EditorStatusSnapshot>>();
const listeners = new Set<() => void>();

const mapFor = (editor: EditorStore) => {
  let map = statuses.get(editor);
  if (!map) {
    map = new Map();
    statuses.set(editor, map);
  }
  return map;
};

export function setEditorStatus(
  editor: EditorStore,
  tabId: string,
  snapshot: EditorStatusSnapshot,
): void {
  const map = mapFor(editor);
  const prev = map.get(tabId);
  if (
    prev?.line === snapshot.line &&
    prev.column === snapshot.column &&
    prev.selected === snapshot.selected &&
    prev.lineEnding === snapshot.lineEnding &&
    prev.indentation === snapshot.indentation
  ) return;
  map.set(tabId, snapshot);
  for (const listener of listeners) listener();
}

export function clearEditorStatus(editor: EditorStore, tabId: string): void {
  if (!statuses.get(editor)?.delete(tabId)) return;
  for (const listener of listeners) listener();
}

export function useActiveEditorStatus(editor: EditorStore): EditorStatusSnapshot | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const unsubscribeEditor = editor.subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeEditor();
      };
    },
    () => {
      const id = editor.getState().activeTabId;
      return id ? statuses.get(editor)?.get(id) ?? null : null;
    },
    () => null,
  );
}

/** Cheap indentation inference for display and new indentation. */
export function detectIndentation(text: string): string {
  let tabLines = 0;
  const spaceWidths = new Map<number, number>();
  for (const line of text.split(/\r\n?|\n/).slice(0, 300)) {
    if (/^\t+\S/.test(line)) tabLines++;
    const spaces = /^( +)\S/.exec(line)?.[1].length ?? 0;
    if (spaces > 0 && spaces <= 8) {
      spaceWidths.set(spaces, (spaceWidths.get(spaces) ?? 0) + 1);
    }
  }
  const spaceLines = [...spaceWidths.values()].reduce((sum, count) => sum + count, 0);
  if (tabLines > spaceLines) return "Tabs";
  const candidates = [2, 4, 8];
  let best = 2;
  let score = -1;
  for (const size of candidates) {
    // Exact one-level indents are much stronger evidence than deeper widths
    // that merely happen to be divisible by a candidate. Without this weight,
    // every four-space file also looks like a two-space file.
    const current = [...spaceWidths].reduce(
      (sum, [width, count]) =>
        sum + (width === size ? count * 10 : width % size === 0 ? count : 0),
      0,
    );
    if (current > score || (current === score && size < best)) {
      best = size;
      score = current;
    }
  }
  return `Spaces: ${best}`;
}
