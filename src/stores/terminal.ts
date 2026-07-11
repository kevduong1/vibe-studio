import { createStore, type StoreApi } from "zustand/vanilla";
import * as dock from "../lib/dockTree";
import { type DropEdge } from "../lib/dockTree";

/**
 * Pure UI-state model for a workspace's terminal dock: the same dockable
 * layout tree as the global agent dock (lib/dockTree), but per workspace and
 * not persisted. xterm/PTY lifecycle lives in the session registry
 * (lib/termSessions) — this store never touches xterm or IPC; UI code closes
 * terminals via the component glue that disposes the session first.
 *
 * Workspace terminals may be plain shells or launch an agent. Global
 * terminals live in stores/agentTerminals and reuse the kind/activity types
 * below.
 */
export type TerminalKind = "shell" | "claude" | "codex";

export interface WorkspaceTerminal {
  /** Doubles as the PTY id. */
  id: string;
  /** Tab label, e.g. "Terminal 1"; renameable. */
  title: string;
  /** What was launched when this tab was created. */
  kind: TerminalKind;
}

/** Live activity of one pane, reported by its tracker (lib/terminalActivity). */
export interface PaneActivity {
  busy: boolean;
  attention: boolean;
}

export type ActivityLevel = "idle" | "busy" | "attention";

/** attention > busy > idle over panes (all panes when paneIds is omitted). */
export const aggregateActivity = (
  paneActivity: Record<string, PaneActivity>,
  paneIds?: string[],
): ActivityLevel => {
  const all = paneIds
    ? paneIds.map((id) => paneActivity[id])
    : Object.values(paneActivity);
  let busy = false;
  for (const a of all) {
    if (a?.attention) return "attention";
    if (a?.busy) busy = true;
  }
  return busy ? "busy" : "idle";
};

/** Drop pane-keyed entries (activity, live titles) for removed panes
 *  (no-op when none are present, so subscribers see no change). */
export const prunePaneState = <V>(
  record: Record<string, V>,
  paneIds: string[],
): Record<string, V> => {
  if (!paneIds.some((id) => id in record)) return record;
  const next = { ...record };
  for (const id of paneIds) delete next[id];
  return next;
};

export interface TerminalState extends dock.DockState<WorkspaceTerminal> {
  /** New terminal as a tab of the active group (or a fresh root group).
   *  Default title "Terminal N"; the task runner passes the task label. */
  newTerminal: (title?: string, kind?: TerminalKind) => string;
  /** New terminal in its own group, split right of the active group. */
  splitActive: () => string;
  /** Structural removal only — session disposal is the caller's job. */
  closeTerminal: (id: string) => void;
  setActiveTerminal: (groupId: string, terminalId: string) => void;
  setActiveGroup: (groupId: string) => void;
  renameTerminal: (id: string, title: string) => void;
  moveTerminal: (terminalId: string, targetGroupId: string, index: number) => void;
  splitGroup: (terminalId: string, targetGroupId: string, edge: DropEdge) => void;
  setSplitSizes: (splitId: string, sizes: number[]) => void;
}

export type TerminalStore = StoreApi<TerminalState>;

/** Lowest unused "Terminal N" number (resets once all such tabs are closed). */
const nextTitleNumber = (terminals: Record<string, WorkspaceTerminal>): number =>
  Object.values(terminals).reduce((max, t) => {
    const m = /^Terminal (\d+)$/.exec(t.title);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0) + 1;

/** Applies a dockTree op result; `s` is returned untouched on op no-ops. */
const applied = (
  s: TerminalState,
  next: dock.DockState<WorkspaceTerminal>,
): Partial<TerminalState> | TerminalState =>
  next === s
    ? s
    : { terminals: next.terminals, root: next.root, activeGroupId: next.activeGroupId };

/** Per-workspace terminal store; created by the workspaces store. */
export const createTerminalStore = (): TerminalStore =>
  createStore<TerminalState>((set) => ({
    terminals: {},
    root: null,
    activeGroupId: null,

    newTerminal: (title, kind = "shell") => {
      const id = crypto.randomUUID();
      set((s) =>
        applied(
          s,
          dock.addTerminal(s, {
            id,
            title:
              title?.trim() ||
              (kind === "shell"
                ? `Terminal ${nextTitleNumber(s.terminals)}`
                : kind === "claude"
                  ? "Claude"
                  : "Codex"),
            kind,
          }),
        ),
      );
      return id;
    },

    splitActive: () => {
      const id = crypto.randomUUID();
      set((s) => {
        const target = s.activeGroupId;
        // Place the tab first, then tear it out to the right of its group —
        // on an empty dock the add alone is the whole story.
        let next = dock.addTerminal(s, {
          id,
          title: `Terminal ${nextTitleNumber(s.terminals)}`,
          kind: "shell",
        });
        if (target) next = dock.splitGroup(next, id, target, "right");
        return applied(s, next);
      });
      return id;
    },

    closeTerminal: (id) => set((s) => applied(s, dock.removeTerminal(s, id))),
    setActiveTerminal: (groupId, terminalId) =>
      set((s) => applied(s, dock.setActiveTerminal(s, groupId, terminalId))),
    setActiveGroup: (groupId) => set((s) => applied(s, dock.setActiveGroup(s, groupId))),
    renameTerminal: (id, title) => set((s) => applied(s, dock.renameTerminal(s, id, title))),
    moveTerminal: (terminalId, targetGroupId, index) =>
      set((s) => applied(s, dock.moveTerminal(s, terminalId, targetGroupId, index))),
    splitGroup: (terminalId, targetGroupId, edge) =>
      set((s) => applied(s, dock.splitGroup(s, terminalId, targetGroupId, edge))),
    setSplitSizes: (splitId, sizes) =>
      set((s) => applied(s, dock.setSplitSizes(s, splitId, sizes))),
  }));
