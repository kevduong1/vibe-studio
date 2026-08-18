/**
 * Global terminal groupings: any number of named dockable layout trees
 * (lib/dockTree) of terminal tab groups, independent of any workspace. Each
 * grouping is one panel tab; each terminal is bound to a project
 * (workspacePath) but lives here, so it survives workspace switches for the
 * current app session. Terminals and grouping layouts intentionally start
 * empty on every app launch.
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
import { PROJECT_COLOR_NAMES } from "../lib/projectColors";
import {
  type TerminalKind,
  prunePaneState,
} from "./terminal";

export interface AgentTerminal {
  /** Doubles as the PTY id. */
  id: string;
  /** Tab label (double-click the tab to rename).
   *  Defaults to the project's display name, deduped. */
  title: string;
  /** Project binding: spawn cwd, badge label, click-to-switch target. */
  workspacePath: string;
  /** Global docks can hold plain shells as well as either supported agent. */
  kind: TerminalKind;
  /** macOS notification + sound on attention onset (lib/agentNotifications).
   *  Session-only; stored as true | undefined (absent = off, the default). */
  notificationsEnabled?: boolean;
}

/** One global terminal grouping: a whole dock tree behind one panel tab. */
export interface GlobalTermGrouping {
  /** Stable id — the panel tab key and the dock-adapter cache key. */
  id: string;
  /** Panel tab label (double-click to rename); defaults to "Global N". */
  name: string;
  /** User-assigned identity color in the shared project/group palette. */
  colorIndex: number;
  /** Workspace to restore when this large panel tab returns to the front. */
  lastActiveWorkspacePath: string | null;
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
  /** Sparse per-terminal live OSC 0/2 titles (Claude Code's auto-generated
   *  topic summaries), shown on the pane badge — ephemeral and session-only. */
  paneTitle: Record<string, string>;

  /** New empty grouping ("Global N"), made active. Returns its id. */
  newGrouping: () => string;
  renameGrouping: (id: string, name: string) => void;
  setGroupingColor: (id: string, colorIndex: number) => void;
  setGroupingWorkspace: (id: string, workspacePath: string) => void;
  /** Rebind navigation memory that points at a checkout deleted from disk. */
  forgetWorkspace: (workspacePath: string, fallbackPath: string | null) => void;
  /** Structural removal (grouping + its terminals) — go through
   *  closeGlobalGrouping() from UI. */
  closeGrouping: (id: string) => void;
  setActiveGrouping: (id: string) => void;

  /**
   * Create a terminal bound to a project and place its tab (in opts.groupId
   * of opts.groupingId/the active grouping, else that grouping's active
   * group; with no grouping at all, a fresh one is created). Returns the
   * terminal id. Does NOT spawn a PTY — the session registry spawns lazily
   * on first attach.
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

const nextGroupingColor = (groupings: GlobalTermGrouping[]): number => {
  const counts = new Array<number>(PROJECT_COLOR_NAMES.length).fill(0);
  for (const grouping of groupings) counts[grouping.colorIndex] += 1;
  return counts.indexOf(Math.min(...counts));
};

/** All terminal ids in one grouping's tree (activity rollups, close glue). */
export const groupingTerminalIds = (g: GlobalTermGrouping): string[] =>
  dock.dockGroups(g.root).flatMap((group) => group.terminalIds);

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

/**
 * Replace one deleted grouping-navigation target. Prefer the grouping's active
 * surviving terminal, then any surviving terminal, then the caller's current
 * workspace. Keeping this pure makes the deletion race regression-testable.
 */
export const groupingAfterWorkspaceDeleted = (
  grouping: GlobalTermGrouping,
  terminals: Record<string, AgentTerminal>,
  workspacePath: string,
  fallbackPath: string | null,
): GlobalTermGrouping => {
  if (grouping.lastActiveWorkspacePath !== workspacePath) return grouping;
  const activeTerminalId = dock.findGroup(grouping.root, grouping.activeGroupId)
    ?.activeTerminalId;
  const orderedIds = [
    ...(activeTerminalId ? [activeTerminalId] : []),
    ...groupingTerminalIds(grouping).filter((id) => id !== activeTerminalId),
  ];
  const terminalPath = orderedIds
    .map((id) => terminals[id]?.workspacePath)
    .find((path) => Boolean(path) && path !== workspacePath);
  const nextPath = terminalPath ?? (fallbackPath !== workspacePath ? fallbackPath : null);
  return { ...grouping, lastActiveWorkspacePath: nextPath };
};

export const useAgentTerminalsStore = create<AgentTerminalsState>((set) => ({
  terminals: {},
  groupings: [],
  activeGroupingId: null,
  paneTitle: {},

  newGrouping: () => {
    const id = crypto.randomUUID();
    set((s) => ({
      groupings: [
        ...s.groupings,
        {
          id,
          name: nextGroupingName(s.groupings),
          colorIndex: nextGroupingColor(s.groupings),
          lastActiveWorkspacePath: null,
          root: null,
          activeGroupId: null,
        },
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

  setGroupingColor: (id, colorIndex) =>
    set((s) => {
      if (
        !Number.isInteger(colorIndex) ||
        colorIndex < 0 ||
        colorIndex >= PROJECT_COLOR_NAMES.length
      ) {
        return s;
      }
      const grouping = s.groupings.find((item) => item.id === id);
      if (!grouping || grouping.colorIndex === colorIndex) return s;
      return {
        groupings: s.groupings.map((item) =>
          item === grouping ? { ...item, colorIndex } : item,
        ),
      };
    }),

  setGroupingWorkspace: (id, workspacePath) =>
    set((s) => {
      const grouping = s.groupings.find((item) => item.id === id);
      if (!grouping || !workspacePath || grouping.lastActiveWorkspacePath === workspacePath) {
        return s;
      }
      return {
        groupings: s.groupings.map((item) =>
          item === grouping
            ? { ...item, lastActiveWorkspacePath: workspacePath }
            : item,
        ),
      };
    }),

  forgetWorkspace: (workspacePath, fallbackPath) =>
    set((s) => {
      const groupings = s.groupings.map((grouping) =>
        groupingAfterWorkspaceDeleted(
          grouping,
          s.terminals,
          workspacePath,
          fallbackPath,
        ),
      );
      return groupings.every((grouping, index) => grouping === s.groupings[index])
        ? s
        : { groupings };
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
          colorIndex: nextGroupingColor(s.groupings),
          lastActiveWorkspacePath: workspacePath,
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
          // true | undefined (never false) keeps the state compact.
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

// Prune cached adapters when their session-only grouping closes.
useAgentTerminalsStore.subscribe((s, prev) => {
  if (s.groupings !== prev.groupings) {
    // Drop dock adapters for groupings that no longer exist.
    for (const id of [...groupingDocks.keys()])
      if (!s.groupings.some((g) => g.id === id)) groupingDocks.delete(id);
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
