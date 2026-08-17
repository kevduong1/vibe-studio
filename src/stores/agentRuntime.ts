import { create } from "zustand";
import {
  agentProcessSnapshot,
  type AgentProcessInfo,
  type AgentProcessTarget,
} from "../lib/ipc";
import { AGENT_PROFILES, type ScreenClassification } from "../lib/agentProfiles";
import {
  displayAgentState,
  rollupAgentStates,
  type AgentAuthority,
  type AgentKind,
  type AgentLifecycle,
  type AgentOccupancy,
  type AgentReason,
  type AgentRollup,
  type AgentRuntimeState,
} from "../lib/agentState";

export interface AgentActivitySignal {
  busy: boolean;
  attention: boolean;
  attentionSource?: "notification" | "completion";
  /**
   * A confirmed busy stretch ended and the quiet survived: the turn is over
   * whether or not it also deserves an attention ping. Separating this from
   * `attention` is what lets a short or already-watched turn still settle to
   * idle (and, when it ran unseen in the background, to Done).
   */
  completed?: boolean;
}

interface FallbackSignal {
  activity: AgentActivitySignal;
  /** Last reported watched-ness of the pane, so the ambient staleness sweep
   *  can settle `seen` without querying the DOM. */
  watched: boolean;
}

export interface AgentSubagentProcess {
  /** Stable only for this occupant generation; never persisted. */
  id: string;
  pid: number;
  parentPid: number;
  executable: string;
  foreground: boolean;
}

const NO_SUBAGENT_PROCESSES: readonly AgentSubagentProcess[] = [];

/** Stable selector fallback: useSyncExternalStore requires referentially
 * stable snapshots when a terminal has no child processes. */
export const selectAgentSubagents = (
  state: { subagents: Record<string, AgentSubagentProcess[]> },
  terminalId: string,
): readonly AgentSubagentProcess[] =>
  state.subagents[terminalId] ?? NO_SUBAGENT_PROCESSES;

interface AgentRuntimeStore {
  states: Record<string, AgentRuntimeState>;
  /** Additional matching agent processes below the primary occupant. */
  subagents: Record<string, AgentSubagentProcess[]>;
}

export interface AgentSemanticTransition {
  previous?: AgentRuntimeState;
  current?: AgentRuntimeState;
}

const fallbacks = new Map<string, FallbackSignal>();
/** Plain-shell tabs participate in process discovery without claiming a
 * requested agent identity until an exact executable match is present. */
const discoveryTerminals = new Set<string>();
/**
 * Whether a work stretch has been observed for this occupant since it last
 * settled. Unseen **Done** is derived from this, not from the immediately
 * previous lifecycle: the routine path into a completed turn is
 * working → unknown (one inconclusive screen read) → idle, and a background
 * blocked prompt that nobody answered must settle back to plain idle rather
 * than announce a turn that never ran.
 */
const workStretches = new Map<string, { generation: number; worked: boolean }>();
/**
 * When each terminal's current screen verdict was produced. Screen evidence
 * outranks OSC and activity while it is fresh; a verdict that stopped being
 * refreshed (a hung tool call, a spinner frame that never redraws) must not
 * pin `working` forever against a tracker that observed the turn end.
 */
const screenEvidenceAt = new Map<string, number>();
/** Terminals holding an unconsumed turn boundary observed AFTER the current
 *  prompt was established. Establishing a prompt drops any earlier boundary,
 *  which is what separates "the agent rang and then finished its turn" from
 *  "the agent finished a turn and then rang". */
const completionSeen = new Set<string>();
/** Live visibility predicate published by a mounted pane (both docks). The
 *  ambient sweep must ask the DOM, not a cached snapshot from the last signal:
 *  a silent screen produces no calls, so the cache can be arbitrarily old. */
const paneVisibility = new Map<string, () => boolean>();
/** App-initiated launch time, so the discovery grace is measured from the
 *  launch itself rather than from a restampable changedAt. */
const launchedAt = new Map<string, number>();
/** A just-typed launch gets this long to reach exec before a clean no-match
 *  snapshot may declare the tab an ordinary shell. */
const LAUNCH_GRACE_MS = 4000;
/** Screen evidence older than this yields to contradicting activity evidence
 *  (blocked excepted — only newer terminal evidence clears a prompt). A
 *  confirmed busy stretch also overrides `idle` immediately because Claude
 *  keeps its otherwise-idle composer painted while a turn is running. */
const SCREEN_STALE_MS = 15_000;
const listeners = new Set<(transition: AgentSemanticTransition) => void>();

export const useAgentRuntimeStore = create<AgentRuntimeStore>(() => ({
  states: {},
  subagents: {},
}));

const replaceSubagents = (
  terminalId: string,
  primaryPid: number | undefined,
  processes: AgentProcessInfo[],
): void => {
  const generation = useAgentRuntimeStore.getState().states[terminalId]?.generation ?? 0;
  const next = primaryPid === undefined
    ? []
    : processes
        .filter((process) => process.pid !== primaryPid)
        .map((process) => ({
          id: `${terminalId}:${generation}:${process.pid}`,
          pid: process.pid,
          parentPid: process.parentPid,
          executable: process.executable,
          foreground: process.foreground,
        }))
        .sort((a, b) => Number(b.foreground) - Number(a.foreground) || a.pid - b.pid);
  useAgentRuntimeStore.setState((store) => {
    const previous = store.subagents[terminalId] ?? [];
    if (
      previous.length === next.length &&
      previous.every((item, index) =>
        item.id === next[index].id &&
        item.pid === next[index].pid &&
        item.parentPid === next[index].parentPid &&
        item.executable === next[index].executable &&
        item.foreground === next[index].foreground,
      )
    ) return store;
    const subagents = { ...store.subagents };
    if (next.length > 0) subagents[terminalId] = next;
    else delete subagents[terminalId];
    return { subagents };
  });
};

const emit = (previous?: AgentRuntimeState, current?: AgentRuntimeState) => {
  if (previous === current) return;
  for (const listener of listeners) listener({ previous, current });
};

export const subscribeAgentTransitions = (
  listener: (transition: AgentSemanticTransition) => void,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const replaceState = (id: string, next?: AgentRuntimeState): void => {
  const previous = useAgentRuntimeStore.getState().states[id];
  if (previous === next) return;
  useAgentRuntimeStore.setState((store) => {
    const states = { ...store.states };
    if (next) states[id] = next;
    else delete states[id];
    return { states };
  });
  emit(previous, next);
};

const changed = (
  current: AgentRuntimeState,
  patch: Partial<AgentRuntimeState>,
): AgentRuntimeState => {
  const candidate = { ...current, ...patch };
  const meaningful = Object.keys(patch).some(
    (key) =>
      key !== "changedAt" &&
      current[key as keyof AgentRuntimeState] !== candidate[key as keyof AgentRuntimeState],
  );
  return meaningful ? { ...candidate, changedAt: Date.now() } : current;
};

/**
 * Occupancy masking during a process-query outage — and the unmasking when
 * the same occupant is rediscovered — is bookkeeping, not a semantic change.
 * Restamping `changedAt` there would reorder the inbox's waiting age, break
 * the merge-owner proof pin, and restart every age-based grace.
 */
const masked = (
  current: AgentRuntimeState,
  occupancy: AgentOccupancy,
): AgentRuntimeState =>
  current.occupancy === occupancy ? current : { ...current, occupancy };

const setFallback = (
  terminalId: string,
  activity: AgentActivitySignal,
  watched = fallbacks.get(terminalId)?.watched ?? false,
): void => {
  const previous = fallbacks.get(terminalId)?.activity;
  // Rising edge only: a signal that merely repeats a still-latched completion
  // is not a second turn boundary.
  if (activity.completed && !previous?.completed) completionSeen.add(terminalId);
  fallbacks.set(terminalId, { activity: { ...activity }, watched });
};

/**
 * A turn boundary is evidence exactly once. Leaving it latched would make
 * every later staleness check see "activity contradicts the screen" forever,
 * re-applying the same verdict under a weaker authority.
 */
const consumeCompletion = (terminalId: string): void => {
  completionSeen.delete(terminalId);
  const entry = fallbacks.get(terminalId);
  if (!entry?.activity.completed) return;
  fallbacks.set(terminalId, {
    ...entry,
    activity: { ...entry.activity, completed: false },
  });
};

const noteWatched = (terminalId: string, watched: boolean): void => {
  const entry = fallbacks.get(terminalId);
  if (entry) entry.watched = watched;
};

/**
 * Whether the user can currently see the pane. A mounted pane publishes a
 * live predicate; without one (no dock host mounted) the last value a signal
 * carried is the best available answer.
 */
const isWatched = (terminalId: string): boolean =>
  paneVisibility.get(terminalId)?.() ?? fallbacks.get(terminalId)?.watched ?? false;

/**
 * Called by the pane hosts in both docks. The predicate reads real
 * visibility (`offsetParent` plus app focus), which no store-side state can
 * reproduce. Returns its own unsubscribe; a remount that already replaced the
 * entry keeps the newer one.
 */
export function setAgentPaneVisibility(
  terminalId: string,
  predicate: () => boolean,
): () => void {
  paneVisibility.set(terminalId, predicate);
  return () => {
    if (paneVisibility.get(terminalId) === predicate) {
      paneVisibility.delete(terminalId);
    }
  };
}

const hasWorked = (current: AgentRuntimeState): boolean => {
  const entry = workStretches.get(current.terminalId);
  return entry?.generation === current.generation && entry.worked;
};

const noteWork = (current: AgentRuntimeState, worked: boolean): void => {
  workStretches.set(current.terminalId, {
    generation: current.generation,
    worked,
  });
};

const forgetTerminal = (terminalId: string): void => {
  workStretches.delete(terminalId);
  screenEvidenceAt.delete(terminalId);
  completionSeen.delete(terminalId);
  launchedAt.delete(terminalId);
};

let monitorTimer: number | null = null;
let polling = false;

const ensureMonitor = (): void => {
  if (typeof window === "undefined" || monitorTimer !== null) return;
  monitorTimer = window.setInterval(() => {
    reconcileAgentEvidence();
    void pollAgentProcesses();
  }, 1000);
  void pollAgentProcesses();
};

/** Nothing left to watch: no registered terminals, or every one of them has a
 *  proven-dead PTY. Registering or launching starts the monitor again. */
const stopMonitorIfIdle = (): void => {
  if (monitorTimer === null) return;
  const states = Object.values(useAgentRuntimeStore.getState().states);
  if (states.some((state) => state.occupancy !== "exited")) return;
  window.clearInterval(monitorTimer);
  monitorTimer = null;
};

export function registerAgentRuntime(meta: {
  terminalId: string;
  workspacePath: string;
  scope: "global" | "workspace";
  kind: AgentKind;
  discovery?: boolean;
}): void {
  if (useAgentRuntimeStore.getState().states[meta.terminalId]) return;
  const { discovery, ...runtimeMeta } = meta;
  replaceState(meta.terminalId, {
    ...runtimeMeta,
    occupancy: "absent",
    generation: 0,
    lifecycle: "unknown",
    seen: true,
    changedAt: Date.now(),
  });
  setFallback(meta.terminalId, { busy: false, attention: false }, false);
  if (discovery) discoveryTerminals.add(meta.terminalId);
  ensureMonitor();
}

export function unregisterAgentRuntime(terminalId: string): void {
  fallbacks.delete(terminalId);
  discoveryTerminals.delete(terminalId);
  forgetTerminal(terminalId);
  replaceSubagents(terminalId, undefined, []);
  replaceState(terminalId, undefined);
  stopMonitorIfIdle();
}

export function markAgentLaunching(terminalId: string): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (!current) return;
  forgetTerminal(terminalId);
  launchedAt.set(terminalId, Date.now());
  ensureMonitor();
  replaceState(
    terminalId,
    changed(current, {
      occupancy: "starting",
      occupantPid: undefined,
      lifecycle: "unknown",
      seen: true,
      authority: undefined,
      reason: undefined,
      matchedRule: undefined,
    }),
  );
}

/** The owning PTY shell exited, which is stronger evidence than a process poll
 * returning no matching child. Keep the final generation number for stale
 * action rejection while making the terminal immediately safe to classify as
 * stopped. */
export function markAgentTerminalExited(terminalId: string): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (!current) return;
  setFallback(terminalId, { busy: false, attention: false });
  forgetTerminal(terminalId);
  replaceSubagents(terminalId, undefined, []);
  replaceState(
    terminalId,
    changed(current, {
      occupancy: "exited",
      occupantPid: undefined,
      lifecycle: "unknown",
      seen: true,
      authority: undefined,
      reason: undefined,
      matchedRule: undefined,
    }),
  );
  stopMonitorIfIdle();
}

const lifecyclePatch = (
  current: AgentRuntimeState,
  lifecycle: AgentLifecycle,
  authority: AgentAuthority | undefined,
  watched: boolean,
  reason?: AgentReason,
  matchedRule?: string,
): Partial<AgentRuntimeState> => {
  let seen = current.seen;
  if (lifecycle === "blocked") {
    // The same prompt re-classified — a redraw, or an inconclusive read that
    // retained it — keeps its acknowledgement, so a hidden pane's repaint
    // cannot resurrect attention the user already answered. A genuinely new
    // prompt (different rule/reason, or blocked re-entered from another
    // state) starts unseen so it alerts again.
    const continuing =
      current.lifecycle === "blocked" &&
      current.reason === reason &&
      current.matchedRule === matchedRule;
    seen = continuing ? current.seen || watched : watched;
    // A newly established prompt supersedes any turn boundary observed before
    // it; only a boundary seen afterwards can argue the prompt is gone.
    // Acknowledgement and redraws are `continuing` and leave this alone.
    if (!continuing) completionSeen.delete(current.terminalId);
    noteWork(current, false);
  } else if (lifecycle === "working") {
    noteWork(current, true);
  } else if (lifecycle === "idle") {
    // Done = a work stretch ended while nobody was looking. Idle reached
    // without an intervening stretch (an unanswered blocked prompt going
    // quiet, a fresh prompt after launch) is plain idle. A Done already on
    // screen stays unseen until it is actually viewed.
    seen = watched || (current.lifecycle === "idle" ? current.seen : !hasWorked(current));
    noteWork(current, false);
  }
  return { lifecycle, authority, reason, matchedRule, seen };
};

const notified = (signal?: AgentActivitySignal): boolean =>
  Boolean(signal?.attention) && signal!.attentionSource === "notification";

const settled = (signal?: AgentActivitySignal): boolean =>
  Boolean(signal?.completed) ||
  (Boolean(signal?.attention) && signal!.attentionSource === "completion");

/** What the activity tracker alone would claim — used to skip sweeps that
 *  would only relabel the authority of a verdict that already holds. */
const activityLifecycle = (signal?: AgentActivitySignal): AgentLifecycle =>
  signal?.busy ? "working" : notified(signal) ? "blocked" : settled(signal) ? "idle" : "unknown";

const fallbackFor = (
  current: AgentRuntimeState,
  watched: boolean,
): Partial<AgentRuntimeState> => {
  const signal = fallbacks.get(current.terminalId)?.activity;
  const blocked = current.lifecycle === "blocked";
  if (signal?.busy) {
    return lifecyclePatch(current, "working", "activity", watched);
  }
  if (notified(signal)) {
    // A ring that is still latched under an existing prompt corroborates it;
    // it is not a second prompt. Rewriting a screen-derived reason and rule
    // to "notification" would break the continuing-identity test, reset seen,
    // and re-alert something the user already answered.
    if (blocked) return {};
    return lifecyclePatch(current, "blocked", "osc", watched, "notification");
  }
  if (blocked) {
    // Only newer evidence clears a prompt. A turn boundary observed after an
    // OSC-derived prompt appeared is exactly that for a pane whose only
    // authority is the ring: agents that ring when they finish would
    // otherwise hold Needs Input for the rest of the session. A prompt the
    // screen classifier actually read outranks a mere boundary and stays,
    // as does a boundary that predates the ring.
    const supersedes =
      current.authority === "osc" &&
      settled(signal) &&
      completionSeen.has(current.terminalId);
    if (!supersedes) return {};
    consumeCompletion(current.terminalId);
    return lifecyclePatch(current, "idle", "activity", watched);
  }
  if (settled(signal)) {
    consumeCompletion(current.terminalId);
    return lifecyclePatch(current, "idle", "activity", watched);
  }
  // No evidence at all: an inconclusive screen read, or the acknowledgement
  // the tracker reports when the user merely views the pane.
  return lifecyclePatch(current, "unknown", "activity", watched);
};

export function applyAgentScreen(
  terminalId: string,
  generation: number,
  classification: ScreenClassification,
  watched: boolean,
): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !current ||
    current.generation !== generation ||
    (current.occupancy !== "present" && current.occupancy !== "starting")
  ) {
    return;
  }
  noteWatched(terminalId, watched);
  if (classification.lifecycle === "unknown") {
    // An inconclusive read is not evidence of anything: hand over to the
    // activity fallback, which retains a blocked prompt.
    replaceState(terminalId, changed(current, fallbackFor(current, watched)));
    return;
  }
  const signal = fallbacks.get(terminalId)?.activity;
  if (classification.lifecycle === "idle" && signal?.busy) {
    // Claude leaves the composer on screen throughout a turn. When its
    // working footer is clipped, customized, or between repaint frames, that
    // composer is real UI but not real idle evidence. Sustained output has
    // already passed the activity tracker's onset debounce, so retain it and
    // do not refresh screen authority with this ambiguous idle frame.
    replaceState(
      terminalId,
      changed(current, fallbackFor(current, watched)),
    );
    return;
  }
  screenEvidenceAt.set(terminalId, Date.now());
  replaceState(
    terminalId,
    changed(
      current,
      lifecyclePatch(
        current,
        classification.lifecycle,
        "screen",
        watched,
        classification.reason,
        classification.matchedRule,
      ),
    ),
  );
}

/**
 * Fresh, unambiguous screen evidence outranks OSC and activity. A confirmed
 * busy stretch is deliberately stronger than an `idle` screen verdict:
 * Claude keeps its composer painted while working, so the composer alone is
 * ambiguous. Other non-blocked screen verdicts yield after SCREEN_STALE_MS
 * when activity actually contradicts them; otherwise one stale `working`
 * frame can pin the display after the tracker observed completion. Blocked
 * never expires this way: a prompt is cleared by newer terminal evidence, not
 * by the passage of time.
 */
const screenAuthorityYields = (
  current: AgentRuntimeState,
  signal: AgentActivitySignal | undefined,
): boolean =>
  current.lifecycle !== "blocked" &&
  Boolean(signal?.busy || signal?.attention || signal?.completed) &&
  (Boolean(signal?.busy && current.lifecycle === "idle") ||
    Date.now() - (screenEvidenceAt.get(current.terminalId) ?? 0) > SCREEN_STALE_MS);

export function applyAgentActivity(
  terminalId: string,
  signal: AgentActivitySignal,
  watched: boolean,
): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (!current) return;
  setFallback(terminalId, signal, watched);
  if (current.occupancy !== "present") return;
  // Current screen evidence wins until the next parsed screen inspection
  // explicitly says it disappeared — or until it goes stale.
  if (current.authority === "screen" && !screenAuthorityYields(current, signal)) {
    return;
  }
  replaceState(terminalId, changed(current, fallbackFor(current, watched)));
}

/**
 * Ambient sweep on the shared monitor tick. The tracker reports a completed
 * turn once; if the screen verdict was still fresh at that moment, nothing
 * else ever calls back into the store, so staleness has to be re-checked
 * here or a hung `working` outlives the evidence that contradicts it.
 */
export function reconcileAgentEvidence(): void {
  for (const current of Object.values(useAgentRuntimeStore.getState().states)) {
    if (current.occupancy !== "present" || current.authority !== "screen") continue;
    const signal = fallbacks.get(current.terminalId)?.activity;
    if (!screenAuthorityYields(current, signal)) continue;
    // Handing an unchanged verdict to a weaker authority is not a semantic
    // change: it would restamp changedAt (resetting an unseen Done's place in
    // the inbox) and emit a redundant control-plane transition every tick.
    if (activityLifecycle(signal) === current.lifecycle) continue;
    replaceState(
      current.terminalId,
      // The DOM, not the last signal's snapshot: a screen that went silent is
      // exactly the case where the cached value is stalest, and getting this
      // wrong announces Done for a pane the user is looking at.
      changed(current, fallbackFor(current, isWatched(current.terminalId))),
    );
  }
}

export function acknowledgeAgentRuntime(terminalId: string): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (!current || current.seen) return;
  // Acknowledging blocked dismisses its alert but intentionally retains the
  // blocked lifecycle until screen evidence changes.
  replaceState(terminalId, changed(current, { seen: true }));
}

export function applyAgentProcessResult(
  terminalId: string,
  pid: number | undefined,
  queryGeneration: number,
): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !current ||
    current.generation !== queryGeneration ||
    current.occupancy === "exited"
  ) return;
  if (pid === undefined) {
    // Give a just-typed launch time to reach exec; after that a successful
    // no-match snapshot authoritatively means the dedicated tab is a shell.
    // The grace is measured from the launch, not from changedAt: bookkeeping
    // updates must not extend it, and a query outage must not skip it.
    if (
      current.occupancy === "starting" &&
      Date.now() - (launchedAt.get(terminalId) ?? current.changedAt) < LAUNCH_GRACE_MS
    ) {
      return;
    }
    forgetTerminal(terminalId);
    setFallback(terminalId, { busy: false, attention: false });
    replaceState(
      terminalId,
      changed(current, {
        occupancy: "absent",
        occupantPid: undefined,
        lifecycle: "unknown",
        seen: true,
        authority: undefined,
        reason: undefined,
        matchedRule: undefined,
      }),
    );
    return;
  }
  // A failed process-table query temporarily changes occupancy to unknown,
  // but retains the last-known PID. Seeing that same PID again restores the
  // existing occupant; it must not mint a new generation (which would
  // invalidate generation-owned prompts, task evidence, and notifications).
  if (current.occupantPid === pid) {
    if (current.occupancy !== "present") {
      replaceState(terminalId, masked(current, "present"));
    }
    return;
  }

  const firstOccupant = current.occupantPid === undefined;
  // Activity can arrive while an explicitly launched process is still being
  // discovered. Preserve that live fallback across the initial PID capture;
  // a true PID replacement starts from a clean authority boundary.
  if (!firstOccupant) {
    setFallback(terminalId, { busy: false, attention: false });
  }
  launchedAt.delete(terminalId);
  screenEvidenceAt.delete(terminalId);
  // A boundary observed under the previous occupant must never argue a new
  // occupant's prompt away.
  completionSeen.delete(terminalId);
  const next: AgentRuntimeState = {
    ...current,
    occupancy: "present",
    occupantPid: pid,
    generation: current.generation + 1,
    lifecycle: "unknown",
    seen: true,
    authority: undefined,
    reason: undefined,
    matchedRule: undefined,
  };
  const startupSignal = fallbacks.get(terminalId)?.activity;
  const startupPatch = firstOccupant && (startupSignal?.busy || startupSignal?.attention)
    ? fallbackFor(next, false)
    : {};
  replaceState(
    terminalId,
    changed(current, { ...next, ...startupPatch }),
  );
}

export function applyAgentProcessSnapshot(
  terminalId: string,
  processes: AgentProcessInfo[],
  queryGeneration: number,
): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !current ||
    current.generation !== queryGeneration ||
    current.occupancy === "exited"
  ) return;
  const discovery = discoveryTerminals.has(terminalId);
  const candidateNames = discovery
    ? ([...AGENT_PROFILES.claude.executableNames, ...AGENT_PROFILES.codex.executableNames] as string[])
    : [...AGENT_PROFILES[current.kind].executableNames];
  const matches = processes
    .filter((process) => candidateNames.includes(process.executable))
    .sort((a, b) => Number(b.foreground) - Number(a.foreground) || a.pid - b.pid);
  const roots = matches.filter((process) => process.parentAgentPid == null);
  const primary = roots.sort((a, b) => {
    const aForeground = matches.some((process) => process.rootAgentPid === a.pid && process.foreground);
    const bForeground = matches.some((process) => process.rootAgentPid === b.pid && process.foreground);
    return Number(bForeground) - Number(aForeground) || a.pid - b.pid;
  })[0];
  const discoveredKind = primary
    ? (AGENT_PROFILES.codex.executableNames.includes(primary.executable) ? "codex" : "claude")
    : current.kind;
  if (discovery && primary && current.kind !== discoveredKind) {
    replaceState(terminalId, changed(current, { kind: discoveredKind }));
  }
  applyAgentProcessResult(terminalId, primary?.pid, queryGeneration);
  replaceSubagents(
    terminalId,
    primary?.pid,
    matches.filter((process) =>
      process.rootAgentPid === primary?.pid &&
      AGENT_PROFILES[discoveredKind].executableNames.includes(process.executable),
    ),
  );
}

export function markAgentProcessQueryFailed(terminalIds: readonly string[]): void {
  for (const id of terminalIds) {
    const current = useAgentRuntimeStore.getState().states[id];
    if (!current || current.occupancy === "exited") continue;
    // A launch in progress has no occupant to mask and owns a grace window
    // the mask would spend: leave it starting so the next clean no-match
    // snapshot still has to wait the launch out before declaring absence.
    if (current.occupancy === "starting") continue;
    // Keep last-known identity and lifecycle metadata while authority is
    // unavailable. occupancy=unknown suppresses their presentation, and a
    // later successful snapshot can prove whether this is the same occupant
    // without inventing a replacement generation. Masking is not a semantic
    // change, so it leaves changedAt alone.
    replaceState(id, masked(current, "unknown"));
  }
}

export async function pollAgentProcesses(): Promise<void> {
  if (polling) return;
  const states = Object.values(useAgentRuntimeStore.getState().states)
    .filter((state) => state.occupancy !== "exited");
  if (states.length === 0) return;
  polling = true;
  const targets: AgentProcessTarget[] = states.map((state) => ({
    terminalId: state.terminalId,
    executableNames: discoveryTerminals.has(state.terminalId)
      ? [...new Set([
          ...AGENT_PROFILES.claude.executableNames,
          ...AGENT_PROFILES.codex.executableNames,
        ])]
      : [...AGENT_PROFILES[state.kind].executableNames],
  }));
  const generations = new Map(states.map((state) => [state.terminalId, state.generation]));
  try {
    const snapshots = await agentProcessSnapshot(targets);
    const byId = new Map(snapshots.map((snapshot) => [snapshot.terminalId, snapshot]));
    for (const state of states) {
      const snapshot = byId.get(state.terminalId);
      applyAgentProcessSnapshot(
        state.terminalId,
        snapshot?.processes ?? [],
        generations.get(state.terminalId)!,
      );
    }
  } catch {
    markAgentProcessQueryFailed(states.map((state) => state.terminalId));
  } finally {
    polling = false;
  }
}

export const selectTerminalRollup = (
  store: AgentRuntimeStore,
  terminalIds?: readonly string[],
): AgentRollup | null =>
  rollupAgentStates(
    terminalIds
      ? terminalIds.map((id) => store.states[id])
      : Object.values(store.states),
  );

export const selectWorkspaceRollup = (
  store: AgentRuntimeStore,
  workspacePaths: readonly string[],
): AgentRollup | null => {
  const paths = new Set(workspacePaths);
  return rollupAgentStates(
    Object.values(store.states).filter((state) => paths.has(state.workspacePath)),
  );
};

export const selectDisplayForTerminal = (
  store: AgentRuntimeStore,
  terminalId: string,
) => displayAgentState(store.states[terminalId]);
