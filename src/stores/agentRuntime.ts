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
  type AgentReason,
  type AgentRollup,
  type AgentRuntimeState,
} from "../lib/agentState";

export interface AgentActivitySignal {
  busy: boolean;
  attention: boolean;
  attentionSource?: "notification" | "completion";
}

interface FallbackSignal {
  activity: AgentActivitySignal;
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

let monitorTimer: number | null = null;
let polling = false;

const ensureMonitor = (): void => {
  if (typeof window === "undefined" || monitorTimer !== null) return;
  monitorTimer = window.setInterval(() => void pollAgentProcesses(), 1000);
  void pollAgentProcesses();
};

const stopMonitorIfEmpty = (): void => {
  if (
    monitorTimer !== null &&
    Object.keys(useAgentRuntimeStore.getState().states).length === 0
  ) {
    window.clearInterval(monitorTimer);
    monitorTimer = null;
  }
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
  fallbacks.set(meta.terminalId, {
    activity: { busy: false, attention: false },
  });
  if (discovery) discoveryTerminals.add(meta.terminalId);
  ensureMonitor();
}

export function unregisterAgentRuntime(terminalId: string): void {
  fallbacks.delete(terminalId);
  discoveryTerminals.delete(terminalId);
  replaceSubagents(terminalId, undefined, []);
  replaceState(terminalId, undefined);
  stopMonitorIfEmpty();
}

export function markAgentLaunching(terminalId: string): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (!current) return;
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
  fallbacks.set(terminalId, { activity: { busy: false, attention: false } });
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
  if (lifecycle === "blocked") seen = watched;
  else if (current.lifecycle === "working" && lifecycle === "idle") seen = watched;
  else if (watched && lifecycle === "idle") seen = true;
  return { lifecycle, authority, reason, matchedRule, seen };
};

const fallbackFor = (
  current: AgentRuntimeState,
  watched: boolean,
): Partial<AgentRuntimeState> => {
  const signal = fallbacks.get(current.terminalId)?.activity;
  if (signal?.busy) {
    return lifecyclePatch(current, "working", "activity", watched);
  }
  if (signal?.attention && signal.attentionSource === "notification") {
    return lifecyclePatch(
      current,
      "blocked",
      "osc",
      watched,
      "notification",
    );
  }
  if (signal?.attention && signal.attentionSource === "completion") {
    return lifecyclePatch(current, "idle", "activity", watched);
  }
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
  const patch =
    classification.lifecycle === "unknown"
      ? fallbackFor(current, watched)
      : lifecyclePatch(
          current,
          classification.lifecycle,
          "screen",
          watched,
          classification.reason,
          classification.matchedRule,
        );
  replaceState(terminalId, changed(current, patch));
}

export function applyAgentActivity(
  terminalId: string,
  signal: AgentActivitySignal,
  watched: boolean,
): void {
  const current = useAgentRuntimeStore.getState().states[terminalId];
  if (!current) return;
  fallbacks.set(terminalId, { activity: signal });
  // Current screen evidence wins until the next parsed screen inspection
  // explicitly says it disappeared.
  if (current.authority === "screen" || current.occupancy !== "present") return;
  replaceState(terminalId, changed(current, fallbackFor(current, watched)));
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
    if (current.occupancy === "starting" && Date.now() - current.changedAt < 4000) {
      return;
    }
    fallbacks.set(terminalId, { activity: { busy: false, attention: false } });
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
      replaceState(terminalId, changed(current, { occupancy: "present" }));
    }
    return;
  }

  const firstOccupant = current.occupantPid === undefined;
  // Activity can arrive while an explicitly launched process is still being
  // discovered. Preserve that live fallback across the initial PID capture;
  // a true PID replacement starts from a clean authority boundary.
  if (!firstOccupant) {
    fallbacks.set(terminalId, { activity: { busy: false, attention: false } });
  }
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
    // Keep last-known identity and lifecycle metadata while authority is
    // unavailable. occupancy=unknown suppresses their presentation, and a
    // later successful snapshot can prove whether this is the same occupant
    // without inventing a replacement generation.
    replaceState(
      id,
      changed(current, {
        occupancy: "unknown",
      }),
    );
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
): AgentRollup =>
  rollupAgentStates(
    terminalIds
      ? terminalIds.map((id) => store.states[id])
      : Object.values(store.states),
  );

export const selectWorkspaceRollup = (
  store: AgentRuntimeStore,
  workspacePaths: readonly string[],
): AgentRollup => {
  const paths = new Set(workspacePaths);
  return rollupAgentStates(
    Object.values(store.states).filter((state) => paths.has(state.workspacePath)),
  );
};

export const selectDisplayForTerminal = (
  store: AgentRuntimeStore,
  terminalId: string,
) => displayAgentState(store.states[terminalId]);
