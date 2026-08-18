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

export interface AgentBackgroundWork {
  /** Total running background tasks parsed from the CLI's live footer. */
  count: number;
  /** The CLI's own comma-joined summary, for example "2 shells, 1 monitor". */
  summary: string;
}

export interface AgentRuntimeState {
  terminalId: string;
  workspacePath: string;
  scope: "global" | "workspace";
  /** Stable launch/default identity for a dedicated tab; plain shells have
   * no requested identity and discover whichever supported agent is live. */
  requestedKind: AgentKind | null;
  /** The detected occupant kind while process authority is present (or
   * temporarily masked), otherwise the dedicated tab's requested fallback. */
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
  /** Live screen-derived annotation, orthogonal to lifecycle and never
   * persisted. An idle agent with background work still accepts input. */
  background?: AgentBackgroundWork;
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
  if (state.occupancy === "unknown") return "unknown";
  // Blocked outranks the launch grace: an agent that asks for permission
  // before its PID has been captured is still waiting for the user, and
  // presenting that as "Working" both hides the prompt and dismisses its
  // alert.
  if (state.lifecycle === "blocked") return "blocked";
  if (state.occupancy === "starting") return "starting";
  if (state.lifecycle === "working") return "working";
  if (state.lifecycle === "idle") return state.seen ? "idle" : "done";
  return "unknown";
};

/** The one rollup ordering: blocked > done > working > idle. Chrome that
 *  sorts or compares rolled-up activity reads it from here. */
export const ROLLUP_PRIORITY: Record<AgentRollup, number> = {
  idle: 0,
  working: 1,
  done: 2,
  blocked: 3,
};

/** `null` means there is nothing to roll up — no state in the set has an
 *  agent present. That is deliberately distinct from `"idle"` (an agent is
 *  present and quiet), so chrome can hide itself instead of claiming a
 *  terminal is idle when it holds an ordinary shell. */
export const rollupAgentStates = (
  states: Iterable<AgentRuntimeState | undefined>,
): AgentRollup | null => {
  let best: AgentRollup | null = null;
  for (const state of states) {
    const display = displayAgentState(state);
    if (display === "absent") continue;
    const level: AgentRollup =
      display === "blocked"
        ? "blocked"
        : display === "done"
          ? "done"
          : display === "working" || display === "starting"
            ? "working"
            : "idle";
    if (best === null || ROLLUP_PRIORITY[level] > ROLLUP_PRIORITY[best]) best = level;
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

/** Human-readable state text for surfaces with room for the orthogonal
 * background-work annotation. Input semantics continue to use lifecycle. */
export const agentStateLabel = (state: AgentRuntimeState): string => {
  const display = displayAgentState(state);
  const label = displayLabel(display);
  return state.background && display === "idle"
    ? `${label} · ${state.background.summary} running`
    : label;
};

export const agentStateTooltip = (state: AgentRuntimeState): string => {
  const display = displayAgentState(state);
  const lines = [
    `${state.kind === "claude" ? "Claude" : "Codex"} — ${displayLabel(display)}`,
  ];
  if (state.requestedKind && state.requestedKind !== state.kind) {
    lines.push(`Tab default: ${state.requestedKind === "claude" ? "Claude" : "Codex"}`);
  }
  if (state.background) lines.push(`Background: ${state.background.summary}`);
  if (state.reason) lines.push(`Reason: ${reasonLabel(state.reason)}`);
  if (state.authority) lines.push(`Authority: ${state.authority}`);
  lines.push(`Changed: ${new Date(state.changedAt).toLocaleString()}`);
  if (state.matchedRule) lines.push(`Rule: ${state.matchedRule}`);
  return lines.join("\n");
};

export type AgentAlertAction = "blocked" | "done" | "dismiss" | "none";

const blockedUnseen = (
  state: AgentRuntimeState | undefined,
  display: AgentDisplayState,
): boolean => Boolean(state) && display === "blocked" && !state!.seen;

/** Pure notification-edge selector. Redraws of an unchanged semantic state
 * return none; acknowledgement and every terminal state that supersedes an
 * alert return dismiss. */
export const agentAlertAction = (
  previous?: AgentRuntimeState,
  current?: AgentRuntimeState,
): AgentAlertAction => {
  const before = displayAgentState(previous);
  const after = displayAgentState(current);
  // Annotation-only refreshes are not alert edges. They may publish runtime
  // state (and update diagnostics) without dismissing or creating a banner.
  if (
    previous &&
    current &&
    previous.terminalId === current.terminalId &&
    previous.generation === current.generation &&
    previous.occupancy === current.occupancy &&
    previous.lifecycle === current.lifecycle &&
    previous.seen === current.seen &&
    previous.authority === current.authority &&
    previous.reason === current.reason &&
    previous.matchedRule === current.matchedRule
  ) return "none";
  // A process-table outage temporarily masks an otherwise unchanged
  // generation as occupancy=unknown. Restoring that same semantic evidence
  // is not a new blocked/completion edge and must not replay its alert.
  if (
    previous?.occupancy === "unknown" &&
    current?.occupancy === "present" &&
    previous.terminalId === current.terminalId &&
    previous.generation === current.generation &&
    previous.lifecycle === current.lifecycle &&
    previous.seen === current.seen
  ) return "none";
  // Entering blocked-and-unseen from anything else is the edge — including
  // from an acknowledged blocked state, which is how a second prompt in the
  // same turn gets its alert. A redraw of the same unseen prompt stays inside
  // blocked-unseen and returns none.
  if (blockedUnseen(current, after) && !blockedUnseen(previous, before)) {
    return "blocked";
  }
  if (current && after === "done" && before !== "done") return "done";
  // `starting` dismisses because a launch supersedes the previous occupant's
  // alert — a blocked lifecycle displays as blocked even during the launch
  // grace, so a live prompt never reaches this branch.
  if (
    !current ||
    current.seen ||
    after === "working" ||
    after === "starting" ||
    after === "absent"
  ) return "dismiss";
  return "none";
};
