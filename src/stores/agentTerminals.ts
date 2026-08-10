/**
 * Global terminal groupings: any number of named dockable layout trees
 * (lib/dockTree) of terminal tab groups, independent of any workspace. Each
 * grouping is one panel tab; each terminal is bound to a project
 * (workspacePath) but lives here, so it survives workspace switches — and
 * the whole set of groupings survives app restarts (localStorage; shells
 * respawn fresh on first attach).
 *
 * Pure UI-state model, same rule as stores/terminal.ts: xterm/PTY lifecycle
 * lives elsewhere (lib/agentSessions.ts) — this store never touches xterm or
 * IPC. UI code closes terminals via closeAgentTerminal() and groupings via
 * closeGlobalGrouping() (which kill the PTYs first), never via
 * closeTerminal()/closeGrouping() directly.
 */
import { create, type StoreApi } from "zustand";
import * as dock from "../lib/dockTree";
import { type DropEdge } from "../lib/dockTree";
import { projectDisplayName } from "../lib/projectNames";
import {
  type ActivityLevel,
  type PaneActivity,
  type TerminalKind,
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
  /** Global docks can hold plain shells as well as either supported agent. */
  kind: TerminalKind;
  /** macOS notification + sound on attention onset (lib/agentNotifications).
   *  Persisted; stored as true | undefined (absent = off, the default). */
  notificationsEnabled?: boolean;
}

/** One global terminal grouping: a whole dock tree behind one panel tab. */
export interface GlobalTermGrouping {
  /** Stable id — the panel tab key and the dock-adapter cache key. */
  id: string;
  /** Panel tab label (double-click to rename); defaults to "Global N". */
  name: string;
  root: dock.DockNode | null;
  activeGroupId: string | null;
}

export interface AgentTerminalsState {
  /** All global terminals across every grouping (each tree references a
   *  disjoint subset of these ids). */
  terminals: Record<string, AgentTerminal>;
  groupings: GlobalTermGrouping[];
  /** Grouping shown while the panel's global side is in front. */
  activeGroupingId: string | null;
  /** Sparse per-terminal activity — ephemeral, never persisted. */
  paneActivity: Record<string, PaneActivity>;
  /** Sparse per-terminal live OSC 0/2 titles (Claude Code's auto-generated
   *  topic summaries), shown on the pane badge — ephemeral, never persisted
   *  (a respawned shell has no topic until its agent sets one). */
  paneTitle: Record<string, string>;

  /** New empty grouping ("Global N"), made active. Returns its id. */
  newGrouping: () => string;
  renameGrouping: (id: string, name: string) => void;
  /** Structural removal (grouping + its terminals) — go through
   *  closeGlobalGrouping() from UI. */
  closeGrouping: (id: string) => void;
  setActiveGrouping: (id: string) => void;

  /**
   * Create a terminal bound to a project and place its tab (in opts.groupId
   * of opts.groupingId/the active grouping, else that grouping's active
   * group; with no grouping at all, a fresh one is created). Returns the
   * terminal id. Does NOT spawn a PTY — the session registry spawns lazily
   * on first attach, which doubles as the respawn path after a restart.
   */
  newTerminal: (
    workspacePath: string,
    opts?: { groupingId?: string; groupId?: string; title?: string; kind?: TerminalKind },
  ) => string;
  /** Structural removal only — go through closeAgentTerminal() from UI. */
  closeTerminal: (id: string) => void;
  setActiveTerminal: (groupingId: string, groupId: string, terminalId: string) => void;
  /** Pane-click activation: panes don't know their grouping, only their
   *  terminal — locates it and fronts its grouping too. */
  setActiveTerminalById: (terminalId: string) => void;
  setActiveGroup: (groupingId: string, groupId: string) => void;
  renameTerminal: (id: string, title: string) => void;
  /** Attention-notification opt-in — UI goes through lib/agentNotifications'
   *  setTerminalNotifications (enable always sticks; banner authorization
   *  is only requested opportunistically on top — enabled ≠ OS-granted). */
  setNotificationsEnabled: (terminalId: string, enabled: boolean) => void;
  moveTerminal: (
    groupingId: string,
    terminalId: string,
    targetGroupId: string,
    index: number,
  ) => void;
  splitGroup: (
    groupingId: string,
    terminalId: string,
    targetGroupId: string,
    edge: DropEdge,
  ) => void;
  setSplitSizes: (groupingId: string, splitId: string, sizes: number[]) => void;
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

/** Lowest unused "Global N" (resets once all such groupings are gone). */
const nextGroupingName = (groupings: GlobalTermGrouping[]): string => {
  const n =
    groupings.reduce((max, g) => {
      const m = /^Global (\d+)$/.exec(g.name);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0) + 1;
  return `Global ${n}`;
};

/** All terminal ids in one grouping's tree (activity rollups, close glue). */
export const groupingTerminalIds = (g: GlobalTermGrouping): string[] =>
  dock.dockGroups(g.root).flatMap((group) => group.terminalIds);

// ---------------------------------------------------------------------------
// Persistence (groupings + terminals only — paneActivity is runtime state)
// ---------------------------------------------------------------------------

interface PersistedSlice {
  terminals: Record<string, AgentTerminal>;
  groupings: GlobalTermGrouping[];
  activeGroupingId: string | null;
}

const emptySlice: PersistedSlice = {
  terminals: {},
  groupings: [],
  activeGroupingId: null,
};

const loadDock = (): PersistedSlice => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptySlice;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p?.version !== 1 && p?.version !== 2) return emptySlice;

    const terminals: Record<string, AgentTerminal> = {};
    if (p.terminals && typeof p.terminals === "object") {
      for (const [id, v] of Object.entries(p.terminals as Record<string, unknown>)) {
        const t = v as Record<string, unknown> | null;
        if (t && typeof t.title === "string" && typeof t.workspacePath === "string") {
          terminals[id] = {
            id,
            title: t.title,
            workspacePath: t.workspacePath,
            // v1 layouts predate terminal kinds and were all Claude tabs.
            kind:
              t.kind === "shell" || t.kind === "codex" || t.kind === "claude"
                ? t.kind
                : "claude",
            ...(t.notificationsEnabled === true && { notificationsEnabled: true }),
          };
        }
      }
    }

    // v1 stored a single tree; wrap it as the one grouping (dropped when
    // empty — a v1 user with no terminals gets no grouping tab). v2 is the
    // multi-grouping shape, where empty groupings are deliberate and kept.
    const rawGroupings: unknown[] =
      p.version === 2 && Array.isArray(p.groupings)
        ? (p.groupings as unknown[])
        : [{ name: "Global 1", root: p.root, activeGroupId: p.activeGroupId }];

    const seen = new Set<string>();
    const groupings: GlobalTermGrouping[] = [];
    for (const rg of rawGroupings) {
      if (!rg || typeof rg !== "object") continue;
      const g = rg as Record<string, unknown>;
      // `seen` spans ALL groupings — a terminal referenced twice keeps only
      // its first tab (same first-reference-wins rule as within one tree).
      const root = dock.normalize(dock.sanitizeNode(g.root, terminals, seen));
      if (!root && p.version !== 2) continue; // legacy empty dock = no grouping
      const id =
        typeof g.id === "string" && !groupings.some((x) => x.id === g.id)
          ? g.id
          : crypto.randomUUID();
      const groups = dock.dockGroups(root);
      groupings.push({
        id,
        name:
          typeof g.name === "string" && g.name.trim()
            ? g.name
            : `Global ${groupings.length + 1}`,
        root,
        activeGroupId:
          typeof g.activeGroupId === "string" &&
          groups.some((x) => x.id === g.activeGroupId)
            ? g.activeGroupId
            : (groups[0]?.id ?? null),
      });
    }
    // Drop terminals no grouping references (their tabs are gone anyway).
    for (const id of Object.keys(terminals)) {
      if (!seen.has(id)) delete terminals[id];
    }
    const requested =
      typeof p.activeGroupingId === "string" ? p.activeGroupingId : null;
    return {
      terminals,
      groupings,
      activeGroupingId: groupings.some((g) => g.id === requested)
        ? requested
        : (groupings[0]?.id ?? null),
    };
  } catch {
    return emptySlice;
  }
};

const saveDock = (s: PersistedSlice) =>
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      terminals: s.terminals,
      groupings: s.groupings,
      activeGroupingId: s.activeGroupingId,
    }),
  );

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Runs a dockTree op against one grouping's tree — the shared terminals map
 * plus that grouping's root/activeGroupId form the op's DockState view.
 * Returns `s` untouched on unknown groupings and op no-ops.
 */
const inGrouping = (
  s: AgentTerminalsState,
  groupingId: string,
  op: (view: dock.DockState<AgentTerminal>) => dock.DockState<AgentTerminal>,
): Partial<AgentTerminalsState> | AgentTerminalsState => {
  const g = s.groupings.find((x) => x.id === groupingId);
  if (!g) return s;
  const view: dock.DockState<AgentTerminal> = {
    terminals: s.terminals,
    root: g.root,
    activeGroupId: g.activeGroupId,
  };
  const next = op(view);
  if (next === view) return s;
  return {
    terminals: next.terminals,
    groupings: s.groupings.map((x) =>
      x === g ? { ...x, root: next.root, activeGroupId: next.activeGroupId } : x,
    ),
  };
};

/** The grouping whose tree references this terminal (ids are disjoint). */
const groupingOf = (
  groupings: GlobalTermGrouping[],
  terminalId: string,
): GlobalTermGrouping | undefined =>
  groupings.find((g) => dock.groupOf(g.root, terminalId));

export const useAgentTerminalsStore = create<AgentTerminalsState>((set) => ({
  ...loadDock(),
  paneActivity: {},
  paneTitle: {},

  newGrouping: () => {
    const id = crypto.randomUUID();
    set((s) => ({
      groupings: [
        ...s.groupings,
        { id, name: nextGroupingName(s.groupings), root: null, activeGroupId: null },
      ],
      activeGroupingId: id,
    }));
    return id;
  },

  renameGrouping: (id, name) =>
    set((s) => {
      const g = s.groupings.find((x) => x.id === id);
      const trimmed = name.trim();
      if (!g || !trimmed || g.name === trimmed) return s;
      return {
        groupings: s.groupings.map((x) => (x === g ? { ...x, name: trimmed } : x)),
      };
    }),

  closeGrouping: (id) =>
    set((s) => {
      const idx = s.groupings.findIndex((g) => g.id === id);
      if (idx === -1) return s;
      const ids = groupingTerminalIds(s.groupings[idx]);
      const groupings = s.groupings.filter((g) => g.id !== id);
      const terminals = { ...s.terminals };
      for (const tid of ids) delete terminals[tid];
      return {
        terminals,
        groupings,
        // The closed active grouping falls to its index-clamped neighbor.
        activeGroupingId:
          s.activeGroupingId === id
            ? (groupings[Math.min(idx, groupings.length - 1)]?.id ?? null)
            : s.activeGroupingId,
        paneActivity: prunePaneState(s.paneActivity, ids),
        paneTitle: prunePaneState(s.paneTitle, ids),
      };
    }),

  setActiveGrouping: (id) =>
    set((s) =>
      s.activeGroupingId === id || !s.groupings.some((g) => g.id === id)
        ? s
        : { activeGroupingId: id },
    ),

  newTerminal: (workspacePath, opts) => {
    const id = crypto.randomUUID();
    set((s) => {
      const terminal: AgentTerminal = {
        id,
        title: opts?.title?.trim() || dedupedTitle(workspacePath, s.terminals),
        workspacePath,
        kind: opts?.kind ?? "shell",
      };
      const target =
        s.groupings.find((g) => g.id === opts?.groupingId) ??
        s.groupings.find((g) => g.id === s.activeGroupingId) ??
        s.groupings[0];
      if (!target) {
        // First global terminal ever (or all groupings were closed): the
        // grouping is created on demand so openGlobalTerminal always works.
        const next = dock.addTerminal(
          { terminals: s.terminals, root: null, activeGroupId: null },
          terminal,
        );
        const grouping: GlobalTermGrouping = {
          id: crypto.randomUUID(),
          name: nextGroupingName(s.groupings),
          root: next.root,
          activeGroupId: next.activeGroupId,
        };
        return {
          terminals: next.terminals,
          groupings: [...s.groupings, grouping],
          activeGroupingId: grouping.id,
        };
      }
      const applied = inGrouping(s, target.id, (view) =>
        dock.addTerminal(view, terminal, opts?.groupId),
      );
      return applied === s ? s : { ...applied, activeGroupingId: target.id };
    });
    return id;
  },

  closeTerminal: (id) =>
    set((s) => {
      const g = groupingOf(s.groupings, id);
      if (!g) return s;
      const applied = inGrouping(s, g.id, (view) => dock.removeTerminal(view, id));
      if (applied === s) return s;
      return {
        ...applied,
        paneActivity: prunePaneState(s.paneActivity, [id]),
        paneTitle: prunePaneState(s.paneTitle, [id]),
      };
    }),

  setActiveTerminal: (groupingId, groupId, terminalId) =>
    set((s) =>
      inGrouping(s, groupingId, (view) =>
        dock.setActiveTerminal(view, groupId, terminalId),
      ),
    ),

  setActiveTerminalById: (terminalId) =>
    set((s) => {
      const g = groupingOf(s.groupings, terminalId);
      if (!g) return s;
      const group = dock.groupOf(g.root, terminalId)!;
      const applied = inGrouping(s, g.id, (view) =>
        dock.setActiveTerminal(view, group.id, terminalId),
      );
      if (applied === s)
        return s.activeGroupingId === g.id ? s : { activeGroupingId: g.id };
      return { ...applied, activeGroupingId: g.id };
    }),

  setActiveGroup: (groupingId, groupId) =>
    set((s) => inGrouping(s, groupingId, (view) => dock.setActiveGroup(view, groupId))),

  renameTerminal: (id, title) =>
    set((s) => {
      const t = s.terminals[id];
      const trimmed = title.trim();
      if (!t || !trimmed || t.title === trimmed) return s;
      return { terminals: { ...s.terminals, [id]: { ...t, title: trimmed } } };
    }),

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

  moveTerminal: (groupingId, terminalId, targetGroupId, index) =>
    set((s) =>
      inGrouping(s, groupingId, (view) =>
        dock.moveTerminal(view, terminalId, targetGroupId, index),
      ),
    ),
  splitGroup: (groupingId, terminalId, targetGroupId, edge) =>
    set((s) =>
      inGrouping(s, groupingId, (view) =>
        dock.splitGroup(view, terminalId, targetGroupId, edge),
      ),
    ),
  setSplitSizes: (groupingId, splitId, sizes) =>
    set((s) =>
      inGrouping(s, groupingId, (view) => dock.setSplitSizes(view, splitId, sizes)),
    ),

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
  if (s.groupings !== prev.groupings) {
    // Drop dock adapters for groupings that no longer exist.
    for (const id of [...groupingDocks.keys()])
      if (!s.groupings.some((g) => g.id === id)) groupingDocks.delete(id);
  }
  if (
    s.groupings !== prev.groupings ||
    s.terminals !== prev.terminals ||
    s.activeGroupingId !== prev.activeGroupingId
  ) {
    saveDock(s);
  }
});

// ---------------------------------------------------------------------------
// Per-grouping dock adapter (the store shape the generic Dock consumes)
// ---------------------------------------------------------------------------

/** One grouping's tree + ops, shaped like a standalone dock store. */
export type GroupingDock = dock.DockState<AgentTerminal> & {
  setActiveTerminal: (groupId: string, terminalId: string) => void;
  setActiveGroup: (groupId: string) => void;
  renameTerminal: (id: string, title: string) => void;
  moveTerminal: (terminalId: string, targetGroupId: string, index: number) => void;
  splitGroup: (terminalId: string, targetGroupId: string, edge: DropEdge) => void;
  setSplitSizes: (splitId: string, sizes: number[]) => void;
};

export type GroupingDockApi = Pick<
  StoreApi<GroupingDock>,
  "getState" | "getInitialState" | "subscribe"
>;

const groupingDocks = new Map<string, GroupingDockApi>();

/**
 * Read-only store facade over one grouping, cached per id (pruned when the
 * grouping closes — see the subscribe above). The snapshot recomputes only
 * when the base store changes and keeps `terminals`/`root` references
 * stable, so Dock's selectors bail exactly as they would on a real store.
 * An unknown grouping id yields an empty dock (the Panel's placeholder
 * while no groupings exist).
 */
export function groupingDockStore(groupingId: string): GroupingDockApi {
  const cached = groupingDocks.get(groupingId);
  if (cached) return cached;
  const base = useAgentTerminalsStore;
  const ops = {
    setActiveTerminal: (groupId: string, terminalId: string) =>
      base.getState().setActiveTerminal(groupingId, groupId, terminalId),
    setActiveGroup: (groupId: string) =>
      base.getState().setActiveGroup(groupingId, groupId),
    renameTerminal: (id: string, title: string) =>
      base.getState().renameTerminal(id, title),
    moveTerminal: (terminalId: string, targetGroupId: string, index: number) =>
      base.getState().moveTerminal(groupingId, terminalId, targetGroupId, index),
    splitGroup: (terminalId: string, targetGroupId: string, edge: DropEdge) =>
      base.getState().splitGroup(groupingId, terminalId, targetGroupId, edge),
    setSplitSizes: (splitId: string, sizes: number[]) =>
      base.getState().setSplitSizes(groupingId, splitId, sizes),
  };
  let baseState: AgentTerminalsState | null = null;
  let snapshot: GroupingDock | null = null;
  const getState = (): GroupingDock => {
    const s = base.getState();
    if (s !== baseState || !snapshot) {
      baseState = s;
      const g = s.groupings.find((x) => x.id === groupingId);
      snapshot = {
        ...ops,
        terminals: s.terminals,
        root: g?.root ?? null,
        activeGroupId: g?.activeGroupId ?? null,
      };
    }
    return snapshot;
  };
  const api: GroupingDockApi = {
    getState,
    getInitialState: getState,
    subscribe: (listener) =>
      base.subscribe(() => {
        const prev = snapshot ?? getState();
        listener(getState(), prev);
      }),
  };
  groupingDocks.set(groupingId, api);
  return api;
}

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

/** Activity rollup for a presentation-only family of workspace tabs. */
export const selectWorkspacePathsActivity = (
  s: AgentTerminalsState,
  workspacePaths: string[],
): ActivityLevel => {
  const paths = new Set(workspacePaths);
  let busy = false;
  for (const [id, activity] of Object.entries(s.paneActivity)) {
    if (!paths.has(s.terminals[id]?.workspacePath)) continue;
    if (activity.attention) return "attention";
    if (activity.busy) busy = true;
  }
  return busy ? "busy" : "idle";
};
