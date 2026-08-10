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

/** The (possibly already-running) session for an agent terminal. */
export function getOrCreateAgentSession(t: AgentTerminal): TermSession {
  return getOrCreateSession({
    id: t.id,
    cwd: t.workspacePath,
    agent: t.kind !== "shell",
    ...(t.kind !== "shell" && {
      agentKind: t.kind,
      workspacePath: t.workspacePath,
      agentScope: "global" as const,
    }),
    onTitle: (title) =>
      useAgentTerminalsStore.getState().setPaneTitle(t.id, title),
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
  opts?: { groupId?: string; kind?: TerminalKind },
): string {
  const kind = opts?.kind ?? "claude";
  const id = useAgentTerminalsStore.getState().newTerminal(workspacePath, {
    ...opts,
    kind,
  });
  const t = useAgentTerminalsStore.getState().terminals[id];
  if (t && kind !== "shell") {
    const session = getOrCreateAgentSession(t);
    session.markAgentLaunching();
    session.sendText(`${AGENT_COMMAND[kind]}\r`);
  }
  return id;
}

/** Create a global shell, Claude, or Codex terminal. */
export const openGlobalTerminal = (
  workspacePath: string,
  kind: TerminalKind,
): string => openAgentTerminal(workspacePath, { kind });
