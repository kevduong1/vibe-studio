/**
 * Global agent-terminal dock: a dockable layout tree (lib/dockTree) of
 * terminal tab groups, independent of any workspace. Each terminal is bound
 * to a project (workspacePath) but lives here, so it survives workspace
 * switches — and the whole layout survives app restarts (localStorage;
 * shells respawn fresh on first attach).
 *
 * Pure UI-state model, same rule as stores/terminal.ts: xterm/PTY lifecycle
 * lives elsewhere (lib/agentSessions.ts) — this store never touches xterm or
 * IPC. UI code closes terminals via closeAgentTerminal() (which kills the
 * PTY first), never via closeTerminal() directly.
 */
import { create } from "zustand";
import * as dock from "../lib/dockTree";
import { type DropEdge } from "../lib/dockTree";
import { projectDisplayName } from "../lib/projectNames";
import {
  type ActivityLevel,
  type PaneActivity,
  prunePaneState,
} from "./terminal";

const STORAGE_KEY = "vibe-studio:agent-terminals";

export interface AgentTerminal {
  /** Doubles as the PTY id (the backend session map is empty at boot, so
   *  restored uuids are safely reused for the respawned shells). */
  id: string;
  /** Tab label (double-click the tab to rename).
   *  Defaults to the project's display name, deduped. */
  title: string;
  /** Project binding: spawn cwd, badge label, click-to-switch target. */
  workspacePath: string;
  /** macOS notification + sound on attention onset (lib/agentNotifications).
   *  Persisted; stored as true | undefined (absent = off, the default). */
  notificationsEnabled?: boolean;
}

export interface AgentTerminalsState extends dock.DockState<AgentTerminal> {
  /** Sparse per-terminal activity — ephemeral, never persisted. */
  paneActivity: Record<string, PaneActivity>;
  /** Sparse per-terminal live OSC 0/2 titles (Claude Code's auto-generated
   *  topic summaries), shown on the pane badge — ephemeral, never persisted
   *  (a respawned shell has no topic until its agent sets one). */
  paneTitle: Record<string, string>;

  /**
   * Create a terminal bound to a project and place its tab (in opts.groupId,
   * else the active group, else a new root group). Returns the terminal id.
   * Does NOT spawn a PTY — the session registry spawns lazily on first
   * attach, which doubles as the respawn path after a restart.
   */
  newTerminal: (
    workspacePath: string,
    opts?: { groupId?: string; title?: string },
  ) => string;
  /** Structural removal only — go through closeAgentTerminal() from UI. */
  closeTerminal: (id: string) => void;
  setActiveTerminal: (groupId: string, terminalId: string) => void;
  setActiveGroup: (groupId: string) => void;
  renameTerminal: (id: string, title: string) => void;
  /** Attention-notification opt-in — UI goes through lib/agentNotifications'
   *  setTerminalNotifications (enable always sticks; banner authorization
   *  is only requested opportunistically on top — enabled ≠ OS-granted). */
  setNotificationsEnabled: (terminalId: string, enabled: boolean) => void;
  moveTerminal: (terminalId: string, targetGroupId: string, index: number) => void;
  splitGroup: (terminalId: string, targetGroupId: string, edge: DropEdge) => void;
  setSplitSizes: (splitId: string, sizes: number[]) => void;
  /** Reported by the session's activity tracker; idle entries are dropped. */
  setPaneActivity: (terminalId: string, activity: PaneActivity) => void;
  /** Reported by the session's onTitle hook; an empty title clears the
   *  entry (Claude Code resets the title to "" on exit). */
  setPaneTitle: (terminalId: string, title: string) => void;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/** Default badge/tab title for a terminal of this project: its display name
 *  (snapshotted at creation — later project renames don't retitle tabs). */
export const agentTitleBase = (workspacePath: string): string =>
  projectDisplayName(workspacePath);

/** "name", then "name · 2", "name · 3", … among the existing titles. */
const dedupedTitle = (
  workspacePath: string,
  existing: Record<string, AgentTerminal>,
): string => {
  const base = agentTitleBase(workspacePath);
  const taken = new Set(Object.values(existing).map((t) => t.title));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} · ${n}`)) n++;
  return `${base} · ${n}`;
};

// ---------------------------------------------------------------------------
// Persistence (layout + terminals only — paneActivity is runtime state)
// ---------------------------------------------------------------------------

type PersistedSlice = dock.DockState<AgentTerminal>;

const emptySlice: PersistedSlice = { terminals: {}, root: null, activeGroupId: null };

const loadDock = (): PersistedSlice => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptySlice;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p?.version !== 1) return emptySlice;

    const terminals: Record<string, AgentTerminal> = {};
    if (p.terminals && typeof p.terminals === "object") {
      for (const [id, v] of Object.entries(p.terminals as Record<string, unknown>)) {
        const t = v as Record<string, unknown> | null;
        if (t && typeof t.title === "string" && typeof t.workspacePath === "string") {
          terminals[id] = {
            id,
            title: t.title,
            workspacePath: t.workspacePath,
            ...(t.notificationsEnabled === true && { notificationsEnabled: true }),
          };
        }
      }
    }
    const seen = new Set<string>();
    const root = dock.normalize(dock.sanitizeNode(p.root, terminals, seen));
    // Drop terminals no group references (their tabs are gone anyway).
    for (const id of Object.keys(terminals)) {
      if (!seen.has(id)) delete terminals[id];
    }
    // Re-validate activeGroupId against the sanitized tree.
    const requested =
      typeof p.activeGroupId === "string" ? p.activeGroupId : null;
    const groups = dock.dockGroups(root);
    return {
      terminals,
      root,
      activeGroupId: groups.some((g) => g.id === requested)
        ? requested
        : (groups[0]?.id ?? null),
    };
  } catch {
    return emptySlice;
  }
};

const saveDock = (s: PersistedSlice) =>
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      terminals: s.terminals,
      root: s.root,
      activeGroupId: s.activeGroupId,
    }),
  );

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Applies a dockTree op result; `s` is returned untouched on op no-ops. */
const applied = (
  s: AgentTerminalsState,
  next: dock.DockState<AgentTerminal>,
): Partial<AgentTerminalsState> | AgentTerminalsState =>
  next === s
    ? s
    : { terminals: next.terminals, root: next.root, activeGroupId: next.activeGroupId };

export const useAgentTerminalsStore = create<AgentTerminalsState>((set) => ({
  ...loadDock(),
  paneActivity: {},
  paneTitle: {},

  newTerminal: (workspacePath, opts) => {
    const id = crypto.randomUUID();
    set((s) =>
      applied(
        s,
        dock.addTerminal(
          s,
          {
            id,
            title: opts?.title?.trim() || dedupedTitle(workspacePath, s.terminals),
            workspacePath,
          },
          opts?.groupId,
        ),
      ),
    );
    return id;
  },

  closeTerminal: (id) =>
    set((s) => {
      const next = dock.removeTerminal(s, id);
      if (next === s) return s;
      return {
        ...applied(s, next),
        paneActivity: prunePaneState(s.paneActivity, [id]),
        paneTitle: prunePaneState(s.paneTitle, [id]),
      };
    }),

  setActiveTerminal: (groupId, terminalId) =>
    set((s) => applied(s, dock.setActiveTerminal(s, groupId, terminalId))),
  setActiveGroup: (groupId) => set((s) => applied(s, dock.setActiveGroup(s, groupId))),
  renameTerminal: (id, title) => set((s) => applied(s, dock.renameTerminal(s, id, title))),
  setNotificationsEnabled: (terminalId, enabled) =>
    set((s) => {
      const t = s.terminals[terminalId];
      if (!t || (t.notificationsEnabled ?? false) === enabled) return s;
      return {
        terminals: {
          ...s.terminals,
          // true | undefined (never false) keeps the persisted JSON minimal.
          [terminalId]: { ...t, notificationsEnabled: enabled || undefined },
        },
      };
    }),
  moveTerminal: (terminalId, targetGroupId, index) =>
    set((s) => applied(s, dock.moveTerminal(s, terminalId, targetGroupId, index))),
  splitGroup: (terminalId, targetGroupId, edge) =>
    set((s) => applied(s, dock.splitGroup(s, terminalId, targetGroupId, edge))),
  setSplitSizes: (splitId, sizes) =>
    set((s) => applied(s, dock.setSplitSizes(s, splitId, sizes))),

  setPaneActivity: (terminalId, activity) =>
    set((s) => {
      const keep = activity.busy || activity.attention;
      if (!keep && !(terminalId in s.paneActivity)) return s;
      const paneActivity = { ...s.paneActivity };
      if (keep) paneActivity[terminalId] = activity;
      else delete paneActivity[terminalId];
      return { paneActivity };
    }),

  setPaneTitle: (terminalId, title) =>
    set((s) => {
      if (s.paneTitle[terminalId] === title || (!title && !(terminalId in s.paneTitle)))
        return s;
      const paneTitle = { ...s.paneTitle };
      if (title) paneTitle[terminalId] = title;
      else delete paneTitle[terminalId];
      return { paneTitle };
    }),
}));

// Persist on structural changes only; paneActivity flaps with every command
// a shell runs and must never hit localStorage.
useAgentTerminalsStore.subscribe((s, prev) => {
  if (
    s.root !== prev.root ||
    s.terminals !== prev.terminals ||
    s.activeGroupId !== prev.activeGroupId
  ) {
    saveDock(s);
  }
});

// ---------------------------------------------------------------------------
// Selectors (chrome outside the dock)
// ---------------------------------------------------------------------------

/** Activity rollup for one project's agent terminals (titlebar tabs). */
export const selectWorkspaceActivity = (
  s: AgentTerminalsState,
  workspacePath: string,
): ActivityLevel => {
  let busy = false;
  for (const [id, a] of Object.entries(s.paneActivity)) {
    if (s.terminals[id]?.workspacePath !== workspacePath) continue;
    if (a.attention) return "attention";
    if (a.busy) busy = true;
  }
  return busy ? "busy" : "idle";
};
