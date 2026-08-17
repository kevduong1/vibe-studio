import { createStore, type StoreApi } from "zustand/vanilla";
import { message } from "@tauri-apps/plugin-dialog";
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
  /** At most one clean file/diff is provisional. Opening another provisional
      item replaces it in place; editing or explicitly keeping it pins it. */
  transientTabId: string | null;
  /** Bounded navigation helpers. Browser previews are intentionally excluded
      from closedTabs because their native session is destroyed on close. */
  closedTabs: Tab[];
  recentFiles: string[];
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
  previewFile: (path: string, at?: { line: number; column?: number }) => void;
  openDiff: (req: DiffRequest) => void;
  previewDiff: (req: DiffRequest) => void;
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
  pinTab: (id: string) => void;
  moveTab: (id: string, toIndex: number) => void;
  activateRelative: (delta: -1 | 1) => void;
  reopenClosedTab: () => void;
  /** Repoint open file tabs at/under `from` after it was renamed or moved to
      `to` (tab ids embed the path). Order and active tab are preserved;
      dirty flags drop — unsaved drafts are keyed by the old tab id and do
      not survive, so callers must confirm the loss first. */
  retargetFileTabs: (from: string, to: string) => void;
  setActive: (id: string) => void;
  /** Track unsaved state. `pin` is false for editor-internal/programmatic
      document transactions; real user edits and ordinary callers pin by
      default so a dirty provisional tab can never be replaced. */
  markDirty: (id: string, dirty: boolean, pin?: boolean) => void;
  /** Drop the reveal request, but only if it is still the one consumed. */
  clearReveal: (nonce: number) => void;
}

export type EditorStore = StoreApi<EditorState>;

export interface EditorSessionSnapshot {
  tabs: Tab[];
  activeTabId: string | null;
  recentFiles: string[];
}

// repoPath is part of the id: the same file/kind in two repos is two tabs.
const diffTabId = (req: DiffRequest) =>
  `diff:${req.repoPath}:${req.kind}:${req.oid ?? ""}:${req.path}`;

const MAX_CLOSED_TABS = 20;
const MAX_RECENT_FILES = 30;

const diffTab = (req: DiffRequest): Extract<Tab, { kind: "diff" }> => {
  const suffix =
    req.kind === "staged"
      ? " (staged)"
      : req.kind === "commit"
        ? ` (${(req.oid ?? "").slice(0, 7)})`
        : req.kind === "checkpoint"
          ? " (latest turn)"
          : "";
  return {
    id: diffTabId(req),
    kind: "diff",
    title: `${basename(req.path)}${suffix}`,
    diff: req,
  };
};

let revealNonce = 0;

/** Per-workspace editor-tab store; created by the workspaces store. */
export const createEditorStore = (
  initial?: Partial<EditorSessionSnapshot>,
): EditorStore =>
  createStore<EditorState>((set, get) => ({
    tabs: initial?.tabs ?? [],
    activeTabId:
      initial?.activeTabId && initial.tabs?.some((tab) => tab.id === initial.activeTabId)
        ? initial.activeTabId
        : initial?.tabs?.[0]?.id ?? null,
    transientTabId: null,
    closedTabs: [],
    recentFiles: initial?.recentFiles ?? [],
    closing: false,
    pendingPreviewDisposals: {},
    dirty: {},
    reveal: null,

    openFile: (path, at) => {
      if (get().closing) return;
      const id = `file:${path}`;
      set((s) => ({
        tabs: s.tabs.some((t) => t.id === id)
          ? s.tabs
          : [...s.tabs, { id, kind: "file", path, title: basename(path) }],
        activeTabId: id,
        transientTabId: s.transientTabId === id ? null : s.transientTabId,
        recentFiles: [path, ...s.recentFiles.filter((p) => p !== path)].slice(
          0,
          MAX_RECENT_FILES,
        ),
        reveal: at
          ? { tabId: id, line: at.line, column: at.column ?? 1, nonce: ++revealNonce }
          : s.reveal,
      }));
      revealEditor();
    },

    previewFile: (path, at) => {
      if (get().closing) return;
      const tab: Extract<Tab, { kind: "file" }> = {
        id: `file:${path}`,
        kind: "file",
        path,
        title: basename(path),
      };
      set((s) => {
        const existing = s.tabs.find((item) => item.id === tab.id);
        if (existing) {
          return {
            activeTabId: tab.id,
            recentFiles: [path, ...s.recentFiles.filter((p) => p !== path)].slice(
              0,
              MAX_RECENT_FILES,
            ),
            reveal: at
              ? { tabId: tab.id, line: at.line, column: at.column ?? 1, nonce: ++revealNonce }
              : s.reveal,
          };
        }
        const replaceAt = s.transientTabId
          ? s.tabs.findIndex((item) => item.id === s.transientTabId)
          : -1;
        const tabs =
          replaceAt >= 0 && !s.dirty[s.transientTabId!]
            ? s.tabs.map((item, index) => (index === replaceAt ? tab : item))
            : [...s.tabs, tab];
        return {
          tabs,
          activeTabId: tab.id,
          transientTabId: tab.id,
          recentFiles: [path, ...s.recentFiles.filter((p) => p !== path)].slice(
            0,
            MAX_RECENT_FILES,
          ),
          reveal: at
            ? { tabId: tab.id, line: at.line, column: at.column ?? 1, nonce: ++revealNonce }
            : s.reveal,
        };
      });
      revealEditor();
    },

    openDiff: (req) => {
      if (get().closing) return;
      const tab = diffTab(req);
      set((s) => ({
        tabs: s.tabs.some((item) => item.id === tab.id) ? s.tabs : [...s.tabs, tab],
        activeTabId: tab.id,
        transientTabId: s.transientTabId === tab.id ? null : s.transientTabId,
      }));
      revealEditor();
    },

    previewDiff: (req) => {
      if (get().closing) return;
      const tab = diffTab(req);
      set((s) => {
        if (s.tabs.some((item) => item.id === tab.id)) return { activeTabId: tab.id };
        const replaceAt = s.transientTabId
          ? s.tabs.findIndex((item) => item.id === s.transientTabId)
          : -1;
        return {
          tabs:
            replaceAt >= 0 && !s.dirty[s.transientTabId!]
              ? s.tabs.map((item, index) => (index === replaceAt ? tab : item))
              : [...s.tabs, tab],
          activeTabId: tab.id,
          transientTabId: tab.id,
        };
      });
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
      const { tabs, activeTabId, dirty, transientTabId } = get();
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
      const closed = tabs[idx];
      set((s) => ({
        tabs: next,
        activeTabId: nextActive,
        transientTabId: transientTabId === id ? null : transientTabId,
        dirty: restDirty,
        closedTabs:
          closed.kind === "preview" || transientTabId === id
            ? s.closedTabs
            : [closed, ...s.closedTabs.filter((tab) => tab.id !== closed.id)].slice(
                0,
                MAX_CLOSED_TABS,
              ),
      }));
    },

    pinTab: (id) =>
      set((s) => (s.transientTabId === id ? { transientTabId: null } : s)),

    moveTab: (id, toIndex) =>
      set((s) => {
        const from = s.tabs.findIndex((tab) => tab.id === id);
        if (from < 0) return s;
        const target = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
        if (from === target) return s;
        const tabs = [...s.tabs];
        const [tab] = tabs.splice(from, 1);
        tabs.splice(target, 0, tab);
        return { tabs };
      }),

    activateRelative: (delta) =>
      set((s) => {
        if (s.tabs.length < 2) return s;
        const current = s.tabs.findIndex((tab) => tab.id === s.activeTabId);
        const index = (Math.max(0, current) + delta + s.tabs.length) % s.tabs.length;
        return { activeTabId: s.tabs[index].id };
      }),

    reopenClosedTab: () => {
      if (get().closing) return;
      set((s) => {
        const [tab, ...closedTabs] = s.closedTabs;
        if (!tab) return s;
        return {
          tabs: s.tabs.some((item) => item.id === tab.id) ? s.tabs : [...s.tabs, tab],
          activeTabId: tab.id,
          closedTabs,
          transientTabId: null,
        };
      });
      revealEditor();
    },

    retargetFileTabs: (from, to) => {
      if (get().closing) return;
      const prefix = from + "/";
      set((s) => {
        let changed = false;
        const dirty = { ...s.dirty };
        let activeTabId = s.activeTabId;
        let transientTabId = s.transientTabId;
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
          if (transientTabId === t.id) transientTabId = id;
          return { ...t, id, path, title: basename(path) };
        });
        return changed ? { tabs, activeTabId, dirty, transientTabId } : s;
      });
    },

    setActive: (id) => {
      if (!get().closing) set({ activeTabId: id });
    },
    markDirty: (id, d, pin = d) =>
      set((s) => {
        const transientTabId =
          d && pin && s.transientTabId === id ? null : s.transientTabId;
        if (
          s.closing ||
          s.tabs.find((tab) => tab.id === id)?.kind === "preview" ||
          (s.dirty[id] === d && transientTabId === s.transientTabId)
        )
          return s;
        return {
          dirty: { ...s.dirty, [id]: d },
          transientTabId,
        };
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
    const result = await message(
      `Save the changes you made to “${tab?.title ?? "this file"}”?`,
      {
        title: "Unsaved Changes",
        kind: "warning",
        buttons: { yes: "Save", no: "Don’t Save", cancel: "Cancel" },
      },
    );
    if (result === "Cancel") return;
    if (result === "Save") {
      const { saveEditorTab } = await import("../lib/editorBuffers");
      if (!(await saveEditorTab(editor, id))) return;
    }
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
