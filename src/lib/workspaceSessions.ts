/**
 * Workspace-dock glue between the session registry (lib/termSessions) and a
 * workspace's terminal store: shells and optional agents spawned at the
 * workspace root, with the close path disposing the PTY before structural
 * removal. Used by the pane host in
 * components/TerminalPanel.tsx and by the task runner (lib/taskRunner.ts),
 * which needs the session before the new tab's pane has mounted.
 */
import {
  getOrCreateSession,
  disposeSession,
  type TermSession,
} from "./termSessions";
import type { TerminalStore } from "../stores/terminal";
import type { Workspace } from "../stores/workspaces";
import { createAgentTask, removeAgentTask } from "../stores/agentTasks";
import { useAgentRuntimeStore } from "../stores/agentRuntime";

/** The (possibly already-running) session for a workspace terminal. */
export function getOrCreateWorkspaceSession(
  ws: Workspace,
  id: string,
): TermSession {
  const terminal = ws.terminal.getState().terminals[id];
  return getOrCreateSession({
    id,
    cwd: ws.path,
    agent: terminal?.kind !== "shell",
    ...(terminal && terminal.kind !== "shell" && {
      agentKind: terminal.kind,
      workspacePath: ws.path,
      agentScope: "workspace" as const,
    }),
    onTitle: (title) => ws.terminal.getState().setPaneTitle(id, title),
    onExit: (_code, early) => {
      // Normal exit closes the tab; an early failure keeps the corpse
      // readable (spawn error, bad dotfiles) for the user to close.
      if (!early) closeWorkspaceTerminal(ws.terminal, id);
    },
  });
}

const AGENT_COMMAND = {
  claude: "claude",
  // Intentional product default: dedicated Codex tabs start fully autonomous.
  codex: "codex --yolo",
} as const;

/** Create a project-bound shell or agent terminal and start the selected
 * agent inside its shell. */
export function openWorkspaceTerminal(
  ws: Workspace,
  kind: "shell" | "claude" | "codex",
): string {
  const id = ws.terminal.getState().newTerminal(undefined, kind);
  if (kind !== "shell") {
    const session = getOrCreateWorkspaceSession(ws, id);
    session.markAgentLaunching();
    const generation = (useAgentRuntimeStore.getState().states[id]?.generation ?? 0) + 1;
    // Baseline capture is ordered before the app-initiated launch. Failure is
    // recorded on the task and never prevents the command from starting.
    void createAgentTask({
      terminalId: id,
      generation,
      workspacePath: ws.path,
      scope: "workspace",
      kind,
    }).finally(() => session.sendText(`${AGENT_COMMAND[kind]}\r`));
  }
  return id;
}

/** UI-facing close: kill the PTY first, then remove the tab from the layout. */
export function closeWorkspaceTerminal(store: TerminalStore, id: string): void {
  disposeSession(id);
  removeAgentTask(id);
  store.getState().closeTerminal(id);
}
