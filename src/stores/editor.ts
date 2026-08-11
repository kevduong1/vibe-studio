import { createStore, type StoreApi } from "zustand/vanilla";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import type { DiffKind, MemoryEntry, StatusCode } from "../lib/ipc";
import { basename } from "../lib/path";
import { disposePreviewWithFallback } from "../lib/previewDisposal";
import { useUiStore } from "./ui";

/** Opening a tab must actually show it: a maximized bottom panel covers the
    whole editor column, so drop it back to its normal height. */
const revealEditor = () => useUiStore.getState().setPanelMaximized(false);

export interface DiffRequest {
  repoPath: string;
  path: string;
  kind: DiffKind;
  /** Commit oid for commit diffs; tree oid for checkpoint diffs. */
  oid?: string;
  /** Pre-rename path for status "R" — the diff's old side is read from it. */
  origPath?: string | null;
  /** Status letter for the tab icon, if known. */
  status?: StatusCode;
}

/** Which agent a memory tab's entry came from (MemoriesPanel sidebar). */
export type MemorySource = "claude" | "codex";

export interface PreviewTab {
  id: string;
  kind: "preview";
  title: string;
  preview: { url: string; width: number; height: number };
}

export type Tab =
  | { id: string; kind: "file"; path: string; title: string }
  | { id: string; kind: "diff"; title: string; diff: DiffRequest }
  | {
      id: string;
      kind: "memory";
      title: string;
      memory: { source: MemorySource; entry: MemoryEntry };
    }
  | PreviewTab;

export interface EditorState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Workspace close sets this synchronously before taking its preview
      snapshot, so no later preview tab can outlive that workspace. */
  closing: boolean;
  /** Preview ids whose tabs closed but whose native teardown has not yet
      succeeded. They remain workspace-owned until confirmed closed. */
  pendingPreviewDisposals: Record<string, true>;
  /** Tab ids with unsaved changes. */
  dirty: Record<string, boolean>;
  /** Pending cursor reveal (search "open at line"), consumed by Editor.tsx.
      The nonce makes repeated jumps to the same spot distinct and lets the
      consumer clear idempotently (StrictMode double-effects). */
  reveal: { tabId: string; line: number; column: number; nonce: number } | null;

  openFile: (path: string, at?: { line: number; column?: number }) => void;
  openDiff: (req: DiffRequest) => void;
  /** Open an agent memory as a read-only preview tab (MemoryPreview.tsx).
      Reopening an already-open entry refreshes its snapshot in place — the
      sidebar refetches from disk/sqlite, tabs just mirror what it handed
      over. */
  openMemory: (source: MemorySource, entry: MemoryEntry) => void;
  openPreview: (url: string, title?: string) => void;
  setPreviewUrl: (id: string, url: string) => void;
  setPreviewDimensions: (id: string, width: number, height: number) => void;
  beginClosing: () => void;
  cancelClosing: () => void;
  beginPreviewDisposal: (id: string) => void;
  completePreviewDisposal: (id: string) => void;
  closeTab: (id: string) => void;
  /** Repoint open file tabs at/under `from` after it was renamed or moved to
      `to` (tab ids embed the path). Order and active tab are preserved;
      dirty flags drop — unsaved drafts are keyed by the old tab id and do
      not survive, so callers must confirm the loss first. */
  retargetFileTabs: (from: string, to: string) => void;
  setActive: (id: string) => void;
  markDirty: (id: string, dirty: boolean) => void;
  /** Drop the reveal request, but only if it is still the one consumed. */
  clearReveal: (nonce: number) => void;
}

export type EditorStore = StoreApi<EditorState>;

// repoPath is part of the id: the same file/kind in two repos is two tabs.
const diffTabId = (req: DiffRequest) =>
  `diff:${req.repoPath}:${req.kind}:${req.oid ?? ""}:${req.path}`;

let revealNonce = 0;

/** Per-workspace editor-tab store; created by the workspaces store. */
export const createEditorStore = (): EditorStore =>
  createStore<EditorState>((set, get) => ({
    tabs: [],
    activeTabId: null,
    closing: false,
    pendingPreviewDisposals: {},
    dirty: {},
    reveal: null,

    openFile: (path, at) => {
      if (get().closing) return;
      const id = `file:${path}`;
      const { tabs } = get();
      if (!tabs.some((t) => t.id === id)) {
        set({
          tabs: [...tabs, { id, kind: "file", path, title: basename(path) }],
        });
      }
      set({
        activeTabId: id,
        reveal: at
          ? { tabId: id, line: at.line, column: at.column ?? 1, nonce: ++revealNonce }
          : get().reveal,
      });
      revealEditor();
    },

    openDiff: (req) => {
      if (get().closing) return;
      const id = diffTabId(req);
      const { tabs } = get();
      if (!tabs.some((t) => t.id === id)) {
        const suffix =
          req.kind === "staged"
            ? " (staged)"
            : req.kind === "commit"
              ? ` (${(req.oid ?? "").slice(0, 7)})`
              : req.kind === "checkpoint"
                ? " (latest turn)"
              : "";
        set({
          tabs: [
            ...tabs,
            { id, kind: "diff", title: `${basename(req.path)}${suffix}`, diff: req },
          ],
        });
      }
      set({ activeTabId: id });
      revealEditor();
    },

    openMemory: (source, entry) => {
      if (get().closing) return;
      // Entry ids are stable across refetches (file path / Codex thread id).
      const id = `memory:${source}:${entry.id}`;
      set((s) => {
        const tab: Tab = { id, kind: "memory", title: entry.title, memory: { source, entry } };
        return {
          tabs: s.tabs.some((t) => t.id === id)
            ? s.tabs.map((t) => (t.id === id ? tab : t))
            : [...s.tabs, tab],
          activeTabId: id,
        };
      });
      revealEditor();
    },

    openPreview: (url, title) => {
      if (get().closing) return;
      const id = `preview:${crypto.randomUUID()}`;
      const tab: PreviewTab = {
        id,
        kind: "preview",
        title: title ?? new URL(url).host,
        preview: { url, width: 390, height: 844 },
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
      revealEditor();
    },

    setPreviewUrl: (id, url) =>
      set((s) =>
        s.closing
          ? s
          : {
              tabs: s.tabs.map((tab) =>
                tab.id === id && tab.kind === "preview"
                  ? { ...tab, preview: { ...tab.preview, url } }
                  : tab,
              ),
            },
      ),

    setPreviewDimensions: (id, width, height) =>
      set((s) =>
        s.closing
          ? s
          : {
              tabs: s.tabs.map((tab) =>
                tab.id === id && tab.kind === "preview"
                  ? { ...tab, preview: { ...tab.preview, width, height } }
                  : tab,
              ),
            },
      ),

    beginClosing: () => set((s) => (s.closing ? s : { closing: true })),
    cancelClosing: () => set((s) => (s.closing ? { closing: false } : s)),
    beginPreviewDisposal: (id) =>
      set((s) =>
        s.pendingPreviewDisposals[id]
          ? s
          : { pendingPreviewDisposals: { ...s.pendingPreviewDisposals, [id]: true } },
      ),
    completePreviewDisposal: (id) =>
      set((s) => {
        if (!s.pendingPreviewDisposals[id]) return s;
        const { [id]: _closed, ...pendingPreviewDisposals } = s.pendingPreviewDisposals;
        return { pendingPreviewDisposals };
      }),

    closeTab: (id) => {
      if (get().closing) return;
      const { tabs, activeTabId, dirty } = get();
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      if (tabs[idx].kind === "preview") {
        get().beginPreviewDisposal(id);
        void disposePreviewWithFallback(id)
          .then(() => get().completePreviewDisposal(id))
          .catch((error) => {
            console.error(`Failed to close preview ${id}`, error);
            void message(
              `The preview could not be closed. It remains owned by this workspace and will be retried when you close it.\n\n${String(error)}`,
              { title: "Close Preview", kind: "error" },
            ).catch((dialogError) => console.error("Failed to show preview-close error", dialogError));
          });
      }
      const next = tabs.filter((t) => t.id !== id);
      const { [id]: _removed, ...restDirty } = dirty;
      let nextActive = activeTabId;
      if (activeTabId === id) {
        nextActive = next.length ? next[Math.min(idx, next.length - 1)].id : null;
      }
      set({ tabs: next, activeTabId: nextActive, dirty: restDirty });
    },

    retargetFileTabs: (from, to) => {
      if (get().closing) return;
      const prefix = from + "/";
      set((s) => {
        let changed = false;
        const dirty = { ...s.dirty };
        let activeTabId = s.activeTabId;
        const tabs = s.tabs.map((t) => {
          const path =
            t.kind === "file"
              ? t.path === from
                ? to
                : t.path.startsWith(prefix)
                  ? to + t.path.slice(from.length)
                  : null
              : null;
          if (path === null) return t;
          changed = true;
          const id = `file:${path}`;
          delete dirty[t.id]; // the draft died with the old id
          if (activeTabId === t.id) activeTabId = id;
          return { ...t, id, path, title: basename(path) };
        });
        return changed ? { tabs, activeTabId, dirty } : s;
      });
    },

    setActive: (id) => {
      if (!get().closing) set({ activeTabId: id });
    },
    markDirty: (id, d) =>
      set((s) => {
        if (
          s.closing ||
          s.tabs.find((tab) => tab.id === id)?.kind === "preview" ||
          s.dirty[id] === d
        )
          return s;
        return { dirty: { ...s.dirty, [id]: d } };
      }),
    clearReveal: (nonce) =>
      set((s) => (s.reveal?.nonce === nonce ? { reveal: null } : s)),
  }));

/**
 * Close a tab, asking for confirmation first when it has unsaved changes.
 * Use this from UI close paths (close button, middle-click, ⌘W) instead of
 * calling closeTab directly.
 */
export async function closeTabSafely(
  editor: EditorStore,
  id: string,
): Promise<void> {
  const { dirty, tabs, closeTab } = editor.getState();
  if (dirty[id]) {
    const tab = tabs.find((t) => t.id === id);
    const ok = await confirm(
      `"${tab?.title ?? "This tab"}" has unsaved changes that will be lost.`,
      { title: "Discard changes?", kind: "warning" },
    );
    if (!ok) return;
  }
  closeTab(id);
}

/**
 * Close several tabs (tab-menu "Close Others" / "to the Right" / "All"),
 * confirming each unsaved one individually — declining keeps that tab open
 * and continues with the rest.
 */
export async function closeTabsSafely(
  editor: EditorStore,
  ids: string[],
): Promise<void> {
  for (const id of ids) await closeTabSafely(editor, id);
}
