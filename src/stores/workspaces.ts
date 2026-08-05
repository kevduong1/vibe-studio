/**
 * Workspace registry: one workspace per open repository, each owning its own
 * repo/editor/terminal store instances. Components inside a workspace's tree
 * reach "their" stores via WorkspaceContext (useWorkspace / useRepo /
 * useEditor / useTerminal); global chrome (titlebar, status bar) follows the
 * active workspace via useActiveWorkspace.
 *
 * Invariant: activePath is always a member of `workspaces` while the list is
 * non-empty, and null when it is empty.
 */
import { createContext, useContext } from "react";
import { create, useStore } from "zustand";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { gitOpen } from "../lib/ipc";
import { disposePreviewSessions } from "../lib/previewSessions";
import { projectDisplayName } from "../lib/projectNames";
import { disposeWorkspaceLsp, setActiveLspWorkspace } from "../lib/lsp/servers";
import { disposeSession } from "../lib/termSessions";
import { createRepoStore, type RepoState, type RepoStore } from "./repo";
import {
  createEditorStore,
  type EditorState,
  type EditorStore,
  type PreviewTab,
} from "./editor";
import { createSearchStore, type SearchState, type SearchStore } from "./search";
import {
  createTerminalStore,
  type TerminalState,
  type TerminalStore,
} from "./terminal";

const RECENT_KEY = "vibe-studio:recent-repos";
const SESSION_KEY = "vibe-studio:workspaces";

export interface Workspace {
  /** Workdir root (canonical, from git_open). Doubles as the workspace id.
   *  Display names come from lib/projectNames (basename, user-renameable). */
  path: string;
  repo: RepoStore;
  editor: EditorStore;
  terminal: TerminalStore;
  search: SearchStore;
}

interface WorkspacesState {
  workspaces: Workspace[];
  activePath: string | null;

  /**
   * Open a repo as a workspace (validating it first; throws if not a repo).
   * Re-opening an already-open repo just activates its workspace.
   * `activate: false` (session restore) never steals the current selection —
   * it only sets the active workspace when none is active yet.
   */
  openWorkspace: (path: string, activate?: boolean) => Promise<void>;
  /** Close a workspace, confirming first when it has unsaved editors. */
  closeWorkspace: (path: string) => Promise<void>;
  setActive: (path: string) => void;
}

export const getRecentRepos = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
};

const pushRecentRepo = (path: string) => {
  const list = [path, ...getRecentRepos().filter((p) => p !== path)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
};

/** Open workspace roots + active path, persisted for session restore. */
const saveSession = (s: { workspaces: Workspace[]; activePath: string | null }) =>
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      paths: s.workspaces.map((w) => w.path),
      active: s.activePath,
    }),
  );

const loadSession = (): { paths: string[]; active: string | null } | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.paths)) return null;
    return {
      paths: parsed.paths.filter((p: unknown) => typeof p === "string"),
      active: typeof parsed.active === "string" ? parsed.active : null,
    };
  } catch {
    return null;
  }
};

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activePath: null,

  openWorkspace: async (path, activate = true) => {
    const info = await gitOpen(path); // throws if not a repo
    const root = info.root;
    // No awaits between this check and set(): concurrent opens of the same
    // repo (StrictMode dev double-mount) cannot both pass it.
    const existing = get().workspaces.find((w) => w.path === root);
    if (existing) {
      if (activate) get().setActive(root);
      pushRecentRepo(root);
      return;
    }
    const ws: Workspace = {
      path: root,
      repo: createRepoStore(root),
      editor: createEditorStore(),
      terminal: createTerminalStore(),
      search: createSearchStore(root),
    };
    set((s) => {
      const next = {
        workspaces: [...s.workspaces, ws],
        // Keep the invariant even when not activating: a non-empty list
        // always has an active workspace.
        activePath: activate ? root : (s.activePath ?? root),
      };
      saveSession(next);
      return next;
    });
    pushRecentRepo(root);
    await ws.repo.getState().init();
  },

  closeWorkspace: async (path) => {
    const ws = get().workspaces.find((w) => w.path === path);
    if (!ws) return;
    const dirtyCount = Object.values(ws.editor.getState().dirty).filter(
      Boolean,
    ).length;
    if (dirtyCount > 0) {
      const ok = await confirm(
        `"${projectDisplayName(ws.path)}" has ${dirtyCount} unsaved ${
          dirtyCount === 1 ? "file" : "files"
        } whose changes will be lost.`,
        { title: "Close Workspace?", kind: "warning" },
      );
      if (!ok) return;
    }
    const previewIds = ws.editor.getState().tabs
      .filter((tab): tab is PreviewTab => tab.kind === "preview")
      .map((tab) => tab.id);
    await disposePreviewSessions(previewIds);
    ws.repo.getState().dispose();
    // Kill this workspace's terminal shells explicitly: registry sessions
    // outlive React unmounts by design (drag-and-drop survival). Agent
    // terminals are NOT touched — they live in the global dock, keep
    // running, and just show as disconnected.
    for (const id of Object.keys(ws.terminal.getState().terminals)) {
      disposeSession(id);
    }
    // Same registry discipline for language servers (lib/lsp/servers.ts).
    disposeWorkspaceLsp(path);
    set((s) => {
      const idx = s.workspaces.findIndex((w) => w.path === path);
      if (idx === -1) return s;
      const workspaces = s.workspaces.filter((w) => w.path !== path);
      let activePath = s.activePath;
      if (activePath === path) {
        activePath = workspaces.length
          ? workspaces[Math.min(idx, workspaces.length - 1)].path
          : null;
      }
      const next = { workspaces, activePath };
      saveSession(next);
      return next;
    });
  },

  setActive: (path) =>
    set((s) => {
      if (s.activePath === path || !s.workspaces.some((w) => w.path === path))
        return s;
      const next = { ...s, activePath: path };
      saveSession(next);
      return next;
    }),
}));

// Language servers follow the active workspace (lib/lsp/servers.ts): the
// newly active facade resumes eagerly, deactivated ones stop after a grace
// period — their docs stay tracked, so resuming just replays them. Subscribed
// at module init, before any setState can possibly run.
useWorkspacesStore.subscribe((s, prev) => {
  if (s.activePath !== prev.activePath) setActiveLspWorkspace(s.activePath);
});

/**
 * Agent-terminal navigation: activate the terminal's project, reopening it
 * if it was closed (a disconnected terminal's repo may even be gone — open
 * failures surface via dialog, since no repo store exists to carry the
 * error for an unopened path).
 */
export async function switchToProject(path: string): Promise<void> {
  const { workspaces, setActive, openWorkspace } = useWorkspacesStore.getState();
  if (workspaces.some((w) => w.path === path)) {
    setActive(path);
    return;
  }
  try {
    await openWorkspace(path);
  } catch (e) {
    await message(`Cannot open project:\n${String(e)}`, {
      title: "Global Terminal",
      kind: "error",
    });
  }
}

/**
 * Reopen last session's workspaces. A saved-but-empty session stays empty
 * (the user deliberately closed everything before quitting); only a missing
 * session falls back to the most recent repo, VSCode-style. Repos that moved
 * or were deleted are silently dropped. The restore never steals the
 * selection: workspaces open without activating, and the previously-active
 * one is only re-activated if the user hasn't picked something themselves
 * while the restore was still running.
 */
export async function restoreSession(): Promise<void> {
  const session = loadSession();
  const paths = session ? session.paths : getRecentRepos().slice(0, 1);
  const store = useWorkspacesStore;

  // The restore itself only ever activates from the empty state (null →
  // first restored repo), so any other activePath transition while we run is
  // the user navigating — after which we must not touch the selection again
  // (even if they end up back on the auto-activated tab).
  let userActed = false;
  const unsubscribe = store.subscribe((s, prev) => {
    if (prev.activePath !== null && s.activePath !== prev.activePath) {
      userActed = true;
    }
  });

  /** The activation the restore itself caused (first repo opened into an
   *  empty app), as opposed to one the user made meanwhile. */
  let autoActivated: string | null = null;
  try {
    for (const p of paths) {
      const before = store.getState().activePath;
      await store.getState().openWorkspace(p, false).catch(() => {});
      if (autoActivated === null && before === null) {
        const after = store.getState().activePath;
        if (after === p) autoActivated = p;
      }
    }

    const s = store.getState();
    if (
      session?.active &&
      !userActed &&
      s.activePath === autoActivated &&
      s.workspaces.some((w) => w.path === session.active)
    ) {
      s.setActive(session.active);
    }
  } finally {
    unsubscribe();
  }
}

// ---------------------------------------------------------------------------
// Workspace context + hooks
// ---------------------------------------------------------------------------

export const WorkspaceContext = createContext<Workspace | null>(null);

/** The workspace owning the current component tree. */
export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace outside <WorkspaceContext.Provider>");
  return ws;
}

/** Subscribe to a slice of the surrounding workspace's repo store. */
export function useRepo<T>(selector: (s: RepoState) => T): T {
  return useStore(useWorkspace().repo, selector);
}

/** Subscribe to a slice of the surrounding workspace's editor store. */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(useWorkspace().editor, selector);
}

/** Subscribe to a slice of the surrounding workspace's terminal store. */
export function useTerminal<T>(selector: (s: TerminalState) => T): T {
  return useStore(useWorkspace().terminal, selector);
}

/** Subscribe to a slice of the surrounding workspace's search store. */
export function useSearch<T>(selector: (s: SearchState) => T): T {
  return useStore(useWorkspace().search, selector);
}

/**
 * The active workspace, for chrome living outside the workspace trees
 * (titlebar, status bar, activity bar). Null only when no repo is open.
 */
export function useActiveWorkspace(): Workspace | null {
  return useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.path === s.activePath) ?? null,
  );
}
