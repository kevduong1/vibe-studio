/**
 * Task execution glue (⌘⇧B): runs a .vscode/tasks.json task by typing the
 * assembled command line into a workspace dock terminal. Terminals are
 * reused VS Code-style per presentation.panel: one shared task terminal per
 * workspace ("shared", the default), one per task label ("dedicated"), or a
 * fresh tab every run ("new"). Reuse interrupts (^C) whatever the terminal
 * was doing first.
 */
import { groupOf } from "./dockTree";
import { shellCommandLine, type TaskDef } from "./tasks";
import { getSession } from "./termSessions";
import { getOrCreateWorkspaceSession } from "./workspaceSessions";
import { useUiStore } from "../stores/ui";
import { useWorkspacesStore, type Workspace } from "../stores/workspaces";

/** ws.path (+ "\0label" for dedicated panels) → terminal id of the last run.
 *  Entries go stale when the terminal closes; runTask re-checks the store. */
const taskTerminals = new Map<string, string>();

export function runTask(ws: Workspace, task: TaskDef): void {
  // The picker (and the loadTasks await before it) can outlive its
  // workspace — spawning into a closed workspace's orphaned store would
  // leak a PTY nothing ever disposes. Identity check, not path: a reopened
  // path is a NEW Workspace and the old store must stay dead.
  if (!useWorkspacesStore.getState().workspaces.includes(ws)) return;

  const line = shellCommandLine(task, ws);
  const store = ws.terminal;

  const key =
    task.panel === "new"
      ? null
      : `${ws.path}\0${task.panel === "dedicated" ? task.label : ""}`;
  const remembered = key ? taskTerminals.get(key) : undefined;
  // Reuse needs the tab still in the layout AND a live shell behind it: an
  // early-exit corpse keeps its tab, but its PTY is gone and anything sent
  // would vanish into the swallowed ptyWrite error — start fresh instead.
  const reused =
    remembered &&
    store.getState().terminals[remembered] &&
    getSession(remembered)?.exited === false
      ? remembered
      : null;

  const id = reused ?? store.getState().newTerminal(task.label);
  if (key) taskTerminals.set(key, id);
  // The shared terminal wears the current task's name.
  if (reused) store.getState().renameTerminal(reused, task.label);

  // A new tab's pane host only mounts on the NEXT render — create the
  // session now; sendText queues until the shell spawn settles.
  const session = getOrCreateWorkspaceSession(ws, id);
  if (reused) {
    // Clear a half-typed line / interrupt a still-running previous task,
    // give the shell a beat to put up its prompt, then type the command.
    session.sendText("\x03");
    window.setTimeout(() => session.sendText(`${line}\r`), 100);
  } else {
    session.sendText(`${line}\r`);
  }

  // "silent" would only reveal on errors; without problem matchers we can't
  // tell, so it gets the quiet treatment like "never".
  if (task.reveal === "always") {
    useUiStore.getState().setProjectTerminalsVisible(true);
    const g = groupOf(store.getState().root, id);
    if (g) store.getState().setActiveTerminal(g.id, id);
  }
}
