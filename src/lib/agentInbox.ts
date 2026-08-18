import { groupOf } from "./dockTree";
import { getSession } from "./termSessions";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useAgentTasksStore } from "../stores/agentTasks";
import { useUiStore } from "../stores/ui";
import { switchToProject, useWorkspacesStore } from "../stores/workspaces";
import { listenNotificationActivations } from "./ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type FocusAgentResult =
  | { ok: true }
  | { ok: false; message: string };

export type ReviewAgentResult =
  | { ok: true; review: { generation: number; fingerprint: string } }
  | { ok: false; message: string };

/** The one navigation router used by inbox rows, keyboard cycling, review
 * feedback, and notification activation. */
export async function focusAgentTerminal(terminalId: string): Promise<FocusAgentResult> {
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (!runtime) return { ok: false, message: "Terminal no longer available" };

  const global = useAgentTerminalsStore.getState().terminals[terminalId];
  if (global) {
    await switchToProject(global.workspacePath);
    if (!useAgentTerminalsStore.getState().terminals[terminalId]) {
      return { ok: false, message: "Terminal no longer available" };
    }
    useUiStore.getState().setPanelVisible(true);
    useAgentTerminalsStore.getState().setActiveTerminalById(terminalId);
  } else {
    const ws = useWorkspacesStore
      .getState()
      .workspaces.find((item) => item.path === runtime.workspacePath);
    const terminal = ws?.terminal.getState().terminals[terminalId];
    if (!ws || !terminal) return { ok: false, message: "Terminal no longer available" };
    useWorkspacesStore.getState().setActive(ws.path);
    useUiStore.getState().setProjectTerminalsVisible(true);
    const group = groupOf(ws.terminal.getState().root, terminalId);
    if (!group) return { ok: false, message: "Terminal no longer available" };
    ws.terminal.getState().setActiveTerminal(group.id, terminalId);
  }

  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  const session = getSession(terminalId);
  if (!session) return { ok: false, message: "Terminal no longer available" };
  session.acknowledge();
  session.focus();
  return { ok: true };
}

/** Open the owning project's Source Control view and, when possible, put the
 * first current worktree/index change directly in the diff editor. Committed
 * changes remain reachable from the commit graph in the same sidebar. */
export async function reviewAgentChanges(terminalId: string): Promise<ReviewAgentResult> {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task) return { ok: false, message: "Review is no longer available" };
  if (!task.latestFingerprint) {
    return { ok: false, message: "There are no current changes to review" };
  }
  const review = {
    generation: task.generation,
    fingerprint: task.latestFingerprint,
  };

  await switchToProject(task.workspacePath);
  const ws = useWorkspacesStore
    .getState()
    .workspaces.find((workspace) => workspace.path === task.workspacePath);
  if (!ws) return { ok: false, message: "Project is no longer available" };

  useWorkspacesStore.getState().setActive(ws.path);
  useUiStore.setState({
    sidebarTab: "scm",
    sidebarVisible: true,
    panelMaximized: false,
  });
  await ws.repo.getState().refresh({ statusOnly: true });

  const status = ws.repo.getState().status;
  const changed = new Set(task.latestSnapshot?.changedFiles ?? []);
  const unstaged = status?.unstaged.find((file) => changed.has(file.path));
  const staged = status?.staged.find((file) => changed.has(file.path));
  const file = unstaged ?? staged;
  if (file) {
    ws.editor.getState().openDiff({
      repoPath: ws.path,
      path: file.path,
      kind: unstaged ? "worktree" : "staged",
      status: file.status,
      origPath: file.origPath,
    });
  }
  return { ok: true, review };
}

export async function listenAgentNotificationActivations(): Promise<UnlistenFn> {
  return listenNotificationActivations(async ({ terminalId }) => {
    const runtime = useAgentRuntimeStore.getState().states[terminalId];
    const global = useAgentTerminalsStore.getState().terminals[terminalId];
    const local = useWorkspacesStore.getState().workspaces.some(
      (ws) => !!ws.terminal.getState().terminals[terminalId],
    );
    if (!runtime || (!global && !local)) {
      window.dispatchEvent(new CustomEvent("talos:open-agent-inbox", {
        detail: { message: "The notification's terminal is no longer available." },
      }));
      return;
    }
    const result = await focusAgentTerminal(terminalId);
    if (!result.ok) {
      window.dispatchEvent(new CustomEvent("talos:open-agent-inbox", {
        detail: { message: result.message },
      }));
    }
  });
}
