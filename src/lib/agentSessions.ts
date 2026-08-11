/**
 * Agent-dock glue between the session registry (lib/termSessions) and the
 * agentTerminals store: agent sessions spawn in their bound project's
 * directory with the TERM_PROGRAM masquerade + semantic tracking, and their
 * close path disposes the PTY before the structural removal.
 */
import { getOrCreateSession, disposeSession, type TermSession } from "./termSessions";
import { dismissAgentAttention } from "./agentNotifications";
import {
  groupingTerminalIds,
  useAgentTerminalsStore,
  type AgentTerminal,
} from "../stores/agentTerminals";
import type { TerminalKind } from "../stores/terminal";
import { createAgentTask, removeAgentTask } from "../stores/agentTasks";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { openTerminalLink } from "./terminalLinks";
import { checkpointBeforeUserSubmit } from "./agentCheckpointPrompt";
import {
  agentLaunchProgram,
  combineAgentPreludes,
  isolatedTaskAgentPrelude,
} from "./agentLaunchProgram";
import { isolatedTaskForPath } from "../stores/isolatedTasks";

/** The (possibly already-running) session for an agent terminal. */
export function getOrCreateAgentSession(t: AgentTerminal): TermSession {
  return getOrCreateSession({
    id: t.id,
    cwd: t.workspacePath,
    agent: t.kind !== "shell",
    workspacePath: t.workspacePath,
    agentScope: "global",
    discoverAgents: t.kind === "shell",
    ...(t.kind !== "shell" && {
      agentKind: t.kind,
      workspacePath: t.workspacePath,
      agentScope: "global" as const,
    }),
    onTitle: (title) =>
      useAgentTerminalsStore.getState().setPaneTitle(t.id, title),
    onLink: (url) => openTerminalLink(t.workspacePath, url),
    onUserSubmit: () => checkpointBeforeUserSubmit(t.id),
    onExit: (_code, early) => {
      // Normal exit closes the tab (like the workspace docks); an early
      // failure keeps the corpse readable and the user closes it manually.
      if (!early) closeAgentTerminal(t.id);
    },
  });
}

/** UI-facing close: kill the PTY first, then remove the tab from the layout
 *  (and any banner still standing for it). */
export function closeAgentTerminal(id: string): void {
  disposeSession(id);
  removeAgentTask(id);
  useAgentTerminalsStore.getState().closeTerminal(id);
  dismissAgentAttention(id);
}

/** UI-facing grouping close: kill every member PTY (and banner) first, then
 *  drop the grouping — with its terminals — from the store in one step. */
export function closeGlobalGrouping(groupingId: string): void {
  const s = useAgentTerminalsStore.getState();
  const grouping = s.groupings.find((g) => g.id === groupingId);
  if (!grouping) return;
  for (const id of groupingTerminalIds(grouping)) {
    disposeSession(id);
    removeAgentTask(id);
    dismissAgentAttention(id);
  }
  s.closeGrouping(groupingId);
}

/** Typed into fresh agent terminals: a new tab exists to run an agent, so
 *  start one. Typed (not exec'd as the PTY process) so quitting the agent
 *  leaves a normal shell in the project root. */
const AGENT_COMMAND: Record<Exclude<TerminalKind, "shell">, string> = {
  claude: "claude",
  // Intentional product default: dedicated Codex tabs start fully autonomous.
  codex: "codex --yolo",
};

/**
 * UI-facing create: places the tab and queues the selected agent into the shell.
 * The session is created eagerly (the tab's pane host only mounts on the
 * NEXT render); its shell still spawns lazily on first attach, and sendText
 * queues until that spawn settles (same pattern as taskRunner). Restored
 * layouts respawn via the mount path, NOT here — a relaunch brings back
 * plain shells, not a surprise fleet of agents.
 */
export function openAgentTerminal(
  workspacePath: string,
  opts?: {
    groupId?: string;
    kind?: TerminalKind;
    prelude?: string;
    command?: string;
    setupCommand?: string;
  },
): string {
  const kind = opts?.kind ?? "claude";
  const id = useAgentTerminalsStore.getState().newTerminal(workspacePath, {
    groupId: opts?.groupId,
    kind,
  });
  const t = useAgentTerminalsStore.getState().terminals[id];
  if (t && kind !== "shell") {
    const session = getOrCreateAgentSession(t);
    const launch = () => {
      session.markAgentLaunching();
      const generation = (useAgentRuntimeStore.getState().states[id]?.generation ?? 0) + 1;
      const command = opts?.command ?? AGENT_COMMAND[kind];
      const isolatedTask = isolatedTaskForPath(workspacePath);
      const prelude = combineAgentPreludes(
        isolatedTask && isolatedTaskAgentPrelude(isolatedTask.id, isolatedTask.previewPort),
        opts?.prelude,
      );
      const launchLine = agentLaunchProgram(command, prelude);
      void createAgentTask({
        terminalId: id,
        generation,
        workspacePath,
        scope: "global",
        kind,
      }).finally(() => session.sendText(`${launchLine}\r`));
    };
    if (opts?.setupCommand) {
      // Bootstrap is task setup, not agent-authored work: finish it before
      // capturing the review baseline and launching the agent. Its own shell
      // output remains visible; a failed setup leaves a usable terminal and
      // deliberately does not start the agent.
      void session
        .runTrackedCommand(opts.setupCommand, `task-bootstrap:${id}`)
        .then((result) => {
          if (result.status === "exited" && result.exitCode === 0) launch();
        });
    } else {
      launch();
    }
  }
  return id;
}

/** Create a global shell, Claude, or Codex terminal. */
export const openGlobalTerminal = (
  workspacePath: string,
  kind: TerminalKind,
  prelude?: string,
  command?: string,
  setupCommand?: string,
): string => openAgentTerminal(workspacePath, { kind, prelude, command, setupCommand });
