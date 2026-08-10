export type AgentKind = "claude" | "codex";
export type AgentOccupancy =
  | "absent"
  | "starting"
  | "present"
  | "exited"
  | "unknown";
export type AgentLifecycle = "working" | "blocked" | "idle" | "unknown";
export type AgentAuthority = "screen" | "osc" | "activity";
export type AgentReason =
  | "permission"
  | "question"
  | "auth"
  | "quota"
  | "error"
  | "notification";

export interface AgentRuntimeState {
  terminalId: string;
  workspacePath: string;
  scope: "global" | "workspace";
  kind: AgentKind;
  occupancy: AgentOccupancy;
  occupantPid?: number;
  generation: number;
  lifecycle: AgentLifecycle;
  seen: boolean;
  changedAt: number;
  authority?: AgentAuthority;
  reason?: AgentReason;
  matchedRule?: string;
}

export type AgentDisplayState =
  | "starting"
  | "working"
  | "blocked"
  | "done"
  | "idle"
  | "unknown"
  | "absent";

export type AgentRollup = "blocked" | "done" | "working" | "idle";

export const displayAgentState = (state?: AgentRuntimeState): AgentDisplayState => {
  if (!state || state.occupancy === "absent" || state.occupancy === "exited") {
    return "absent";
  }
  if (state.occupancy === "starting") return "starting";
  if (state.occupancy === "unknown") return "unknown";
  if (state.lifecycle === "blocked") return "blocked";
  if (state.lifecycle === "working") return "working";
  if (state.lifecycle === "idle") return state.seen ? "idle" : "done";
  return "unknown";
};

const PRIORITY: Record<AgentRollup, number> = {
  idle: 0,
  working: 1,
  done: 2,
  blocked: 3,
};

export const rollupAgentStates = (
  states: Iterable<AgentRuntimeState | undefined>,
): AgentRollup => {
  let best: AgentRollup = "idle";
  for (const state of states) {
    const display = displayAgentState(state);
    const level: AgentRollup =
      display === "blocked"
        ? "blocked"
        : display === "done"
          ? "done"
          : display === "working" || display === "starting"
            ? "working"
            : "idle";
    if (PRIORITY[level] > PRIORITY[best]) best = level;
  }
  return best;
};

export const reasonLabel = (reason?: AgentReason): string => {
  switch (reason) {
    case "permission":
      return "Permission required";
    case "question":
      return "Question";
    case "auth":
      return "Authentication required";
    case "quota":
      return "Usage limit reached";
    case "error":
      return "Error";
    case "notification":
      return "Notification";
    default:
      return "Input required";
  }
};

export const displayLabel = (display: AgentDisplayState): string => {
  switch (display) {
    case "starting":
    case "working":
      return "Working";
    case "blocked":
      return "Needs Input";
    case "done":
      return "Done";
    case "absent":
      return "No Agent";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
};

export const agentStateTooltip = (state: AgentRuntimeState): string => {
  const display = displayAgentState(state);
  const lines = [
    `${state.kind === "claude" ? "Claude" : "Codex"} — ${displayLabel(display)}`,
  ];
  if (state.reason) lines.push(`Reason: ${reasonLabel(state.reason)}`);
  if (state.authority) lines.push(`Authority: ${state.authority}`);
  lines.push(`Changed: ${new Date(state.changedAt).toLocaleString()}`);
  if (state.matchedRule) lines.push(`Rule: ${state.matchedRule}`);
  return lines.join("\n");
};

export type AgentAlertAction = "blocked" | "done" | "dismiss" | "none";

/** Pure notification-edge selector. Redraws of an unchanged semantic state
 * return none; acknowledgement and every terminal state that supersedes an
 * alert return dismiss. */
export const agentAlertAction = (
  previous?: AgentRuntimeState,
  current?: AgentRuntimeState,
): AgentAlertAction => {
  const before = displayAgentState(previous);
  const after = displayAgentState(current);
  if (current && !current.seen && after === "blocked" && before !== "blocked") {
    return "blocked";
  }
  if (current && after === "done" && before !== "done") return "done";
  if (
    !current ||
    current.seen ||
    after === "working" ||
    after === "starting" ||
    after === "absent"
  ) return "dismiss";
  return "none";
};
