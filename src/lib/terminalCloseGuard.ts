import type { AgentRuntimeState } from "./agentState";
import { displayAgentState } from "./agentState";
import type { TerminalKind } from "../stores/terminal";

export type TerminalCloseScope = "workspace" | "global";

export interface TerminalCloseConfirmation {
  title: string;
  message: string;
}

/**
 * Return the warning a user-initiated terminal-tab close must show. Global
 * terminals are always protected because their session-spanning placement is
 * easy to mistake for an ordinary disposable shell. Project terminals are
 * protected when they were created for an agent or currently contain an
 * agent discovered in a plain shell.
 */
export function terminalCloseConfirmation(
  scope: TerminalCloseScope,
  terminal: { title: string; kind: TerminalKind },
  runtime?: AgentRuntimeState,
): TerminalCloseConfirmation | null {
  const hasAgent = displayAgentState(runtime) !== "absent";
  if (scope === "workspace" && terminal.kind === "shell" && !hasAgent) {
    return null;
  }

  const global = scope === "global";
  return {
    title: global ? "Close Global Terminal" : "Close Agent Terminal",
    message: global
      ? `Close global terminal "${terminal.title}"?\n\nThis will stop its process and remove the tab.`
      : `Close agent terminal "${terminal.title}"?\n\nThis will stop its agent and remove the tab.`,
  };
}
