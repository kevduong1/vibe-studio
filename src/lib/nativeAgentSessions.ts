import { codexNativeSessionCandidates } from "./ipc";
import { subscribeAgentTransitions, useAgentRuntimeStore } from "../stores/agentRuntime";
import { useIsolatedTasksStore } from "../stores/isolatedTasks";

const inFlight = new Set<string>();

async function captureCodexSession(terminalId: string, generation: number): Promise<void> {
  const key = `${terminalId}:${generation}`;
  if (inFlight.has(key)) return;
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !runtime ||
    runtime.kind !== "codex" ||
    runtime.occupancy !== "present" ||
    runtime.generation !== generation
  ) return;
  const task = Object.values(useIsolatedTasksStore.getState().tasks).find(
    (item) =>
      item.agentTerminalId === terminalId &&
      item.agentKind === "codex" &&
      !item.nativeSessionRef,
  );
  if (!task) return;
  inFlight.add(key);
  try {
    const candidates = await codexNativeSessionCandidates(
      task.worktreePath,
      task.branch,
      Math.max(0, task.createdAt - 2_000),
    );
    // Never guess across concurrent launches in the same checkout. Exact cwd,
    // launch time, and branch still must reduce to one opaque thread id.
    if (candidates.length !== 1) return;
    const latest = useIsolatedTasksStore.getState().tasks[task.id];
    const latestRuntime = useAgentRuntimeStore.getState().states[terminalId];
    if (
      !latest ||
      latest.agentTerminalId !== terminalId ||
      latest.nativeSessionRef ||
      !latestRuntime ||
      latestRuntime.kind !== "codex" ||
      latestRuntime.occupancy !== "present" ||
      latestRuntime.generation !== generation
    ) return;
    useIsolatedTasksStore.getState().patchTask(task.id, {
      nativeSessionRef: { transport: "agent-hook", id: candidates[0].id },
    });
  } catch {
    // Codex may not have persisted the thread yet, its schema may differ, or
    // sqlite3 may be unavailable. A later semantic edge retries; restoration
    // remains an explicit fresh-shell fallback.
  } finally {
    inFlight.delete(key);
  }
}

/** Capture after process discovery and after completed turns. The delay lets
 * Codex commit its thread row without blocking semantic transitions. */
export function listenNativeAgentSessionCapture(): () => void {
  const timers = new Set<number>();
  const unsubscribe = subscribeAgentTransitions(({ previous, current }) => {
    if (!current || current.kind !== "codex") return;
    const newlyPresent =
      current.occupancy === "present" && previous?.generation !== current.generation;
    const turnFinished = previous?.lifecycle === "working" && current.lifecycle === "idle";
    if (!newlyPresent && !turnFinished) return;
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      void captureCodexSession(current.terminalId, current.generation);
    }, 750);
    timers.add(timer);
  });
  return () => {
    unsubscribe();
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };
}
