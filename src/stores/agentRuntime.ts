import { create } from "zustand";
import { agentProcessSnapshot, type AgentProcessTarget } from "../lib/ipc";
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

interface AgentRuntimeStore {
  states: Record<string, AgentRuntimeState>;
}

export interface AgentSemanticTransition {
  previous?: AgentRuntimeState;
  current?: AgentRuntimeState;
}

const fallbacks = new Map<string, FallbackSignal>();
const listeners = new Set<(transition: AgentSemanticTransition) => void>();

export const useAgentRuntimeStore = create<AgentRuntimeStore>(() => ({ states: {} }));

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
}): void {
  if (useAgentRuntimeStore.getState().states[meta.terminalId]) return;
  replaceState(meta.terminalId, {
    ...meta,
    occupancy: "absent",
    generation: 0,
    lifecycle: "unknown",
    seen: true,
    changedAt: Date.now(),
  });
  fallbacks.set(meta.terminalId, {
    activity: { busy: false, attention: false },
  });
  ensureMonitor();
}

export function unregisterAgentRuntime(terminalId: string): void {
  fallbacks.delete(terminalId);
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
  if (!current || current.generation !== queryGeneration) return;
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
  if (current.occupantPid === pid && current.occupancy === "present") return;
  fallbacks.set(terminalId, { activity: { busy: false, attention: false } });
  // Preserve startup screen evidence across the first absent→present PID
  // discovery. A true PID replacement is a new generation and starts clean.
  const preserveScreen =
    current.occupantPid === undefined && current.authority === "screen";
  replaceState(
    terminalId,
    changed(current, {
      occupancy: "present",
      occupantPid: pid,
      generation: current.generation + 1,
      lifecycle: preserveScreen ? current.lifecycle : "unknown",
      seen: true,
      authority: preserveScreen ? current.authority : undefined,
      reason: preserveScreen ? current.reason : undefined,
      matchedRule: preserveScreen ? current.matchedRule : undefined,
    }),
  );
}

export function markAgentProcessQueryFailed(terminalIds: readonly string[]): void {
  for (const id of terminalIds) {
    const current = useAgentRuntimeStore.getState().states[id];
    if (!current) continue;
    replaceState(
      id,
      changed(current, {
        occupancy: "unknown",
        occupantPid: undefined,
        lifecycle: "unknown",
        authority: undefined,
        reason: undefined,
        matchedRule: undefined,
      }),
    );
  }
}

export async function pollAgentProcesses(): Promise<void> {
  if (polling) return;
  const states = Object.values(useAgentRuntimeStore.getState().states);
  if (states.length === 0) return;
  polling = true;
  const targets: AgentProcessTarget[] = states.map((state) => ({
    terminalId: state.terminalId,
    executableNames: [...AGENT_PROFILES[state.kind].executableNames],
  }));
  const generations = new Map(states.map((state) => [state.terminalId, state.generation]));
  try {
    const snapshots = await agentProcessSnapshot(targets);
    const byId = new Map(snapshots.map((snapshot) => [snapshot.terminalId, snapshot]));
    for (const state of states) {
      const snapshot = byId.get(state.terminalId);
      const match = snapshot?.processes
        .filter((process) => targets.find((target) => target.terminalId === state.terminalId)!.executableNames.includes(process.executable))
        .sort((a, b) => Number(b.foreground) - Number(a.foreground))[0];
      applyAgentProcessResult(state.terminalId, match?.pid, generations.get(state.terminalId)!);
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
