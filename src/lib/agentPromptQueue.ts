import { captureAgentTurnCheckpoint } from "../stores/agentTasks";
import { subscribeAgentTransitions, useAgentRuntimeStore } from "../stores/agentRuntime";
import { getSession } from "./termSessions";

interface QueuedPrompt {
  id: string;
  terminalId: string;
  generation: number;
  text: string;
  resolve: (id: string) => void;
  reject: (error: Error) => void;
}

const queues = new Map<string, QueuedPrompt[]>();
const flushing = new Set<string>();
const rerun = new Set<string>();
export const MAX_AGENT_PROMPT_CHARS = 8 * 1024;

const safePrompt = (terminalId: string, generation: number): boolean => {
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  return Boolean(
    runtime &&
    runtime.generation === generation &&
    runtime.occupancy === "present" &&
    (runtime.lifecycle === "idle" ||
      (runtime.lifecycle === "blocked" && runtime.reason === "question")),
  );
};

const validatePrompt = (text: string): void => {
  if (!text.trim()) throw new Error("The prompt is empty.");
  if (text.length > MAX_AGENT_PROMPT_CHARS) {
    throw new Error(`The prompt exceeds the ${MAX_AGENT_PROMPT_CHARS.toLocaleString()} character limit.`);
  }
};

const removePrompt = (prompt: QueuedPrompt): boolean => {
  const queue = queues.get(prompt.terminalId) ?? [];
  const remaining = queue.filter((item) => item.id !== prompt.id);
  if (remaining.length === queue.length) return false;
  if (remaining.length > 0) queues.set(prompt.terminalId, remaining);
  else queues.delete(prompt.terminalId);
  return true;
};

const isQueued = (prompt: QueuedPrompt): boolean =>
  (queues.get(prompt.terminalId) ?? []).some((item) => item.id === prompt.id);

const requestFlush = (terminalId: string): void => {
  if (flushing.has(terminalId)) {
    rerun.add(terminalId);
    return;
  }
  void flush(terminalId);
};

async function flush(terminalId: string): Promise<void> {
  if (flushing.has(terminalId)) return;
  const next = queues.get(terminalId)?.[0];
  if (!next) return;
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (!runtime || runtime.occupancy !== "present" || runtime.generation !== next.generation) {
    if (removePrompt(next)) {
      next.reject(new Error("The queued terminal occupant changed before dispatch."));
    }
    queueMicrotask(() => requestFlush(terminalId));
    return;
  }
  if (!safePrompt(terminalId, next.generation)) return;
  flushing.add(terminalId);
  let advanced = false;
  try {
    await captureAgentTurnCheckpoint(terminalId, next.generation);
    if (!isQueued(next) || !safePrompt(terminalId, next.generation)) return;
    const session = getSession(terminalId);
    if (!session || session.exited) throw new Error("The queued agent terminal is no longer available.");
    await session.sendPrompt(next.text);
    if (removePrompt(next)) {
      advanced = true;
      next.resolve(next.id);
    }
  } catch (error) {
    if (removePrompt(next)) {
      advanced = true;
      next.reject(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    flushing.delete(terminalId);
    if (advanced || rerun.delete(terminalId)) {
      queueMicrotask(() => requestFlush(terminalId));
    }
  }
}

subscribeAgentTransitions(({ previous, current }) => {
  const terminalId = (current ?? previous)?.terminalId;
  if (terminalId) requestFlush(terminalId);
});

/** Session-only, occupant-generation-owned queue. Prompt text is bounded and
 * never persisted; a replaced/exited occupant rejects it. */
export function queueAgentPrompt(
  terminalId: string,
  text: string,
  promptId: string = crypto.randomUUID(),
): Promise<string> {
  validatePrompt(text);
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (!runtime || runtime.occupancy !== "present") throw new Error("The task agent is not running.");
  if ([...queues.values()].some((queue) => queue.some((item) => item.id === promptId))) {
    throw new Error("The prompt request ID is already queued.");
  }
  return new Promise((resolve, reject) => {
    const prompt: QueuedPrompt = {
      id: promptId,
      terminalId,
      generation: runtime.generation,
      text,
      resolve,
      reject,
    };
    queues.set(terminalId, [...(queues.get(terminalId) ?? []), prompt]);
    requestFlush(terminalId);
  });
}

/** Remove an automation request that timed out or was explicitly cancelled
 * before its text reached the PTY. */
export function cancelQueuedAgentPrompt(promptId: string): boolean {
  for (const queue of queues.values()) {
    const prompt = queue.find((item) => item.id === promptId);
    if (!prompt) continue;
    if (removePrompt(prompt)) {
      prompt.reject(new Error("The queued prompt was cancelled before dispatch."));
      requestFlush(prompt.terminalId);
      return true;
    }
  }
  return false;
}

/** Explicit steer bypasses idle gating but remains pinned to the live
 * occupant generation chosen by the user action. */
export async function steerAgentPrompt(
  terminalId: string,
  text: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  validatePrompt(text);
  if (cancelled()) throw new Error("The prompt request was cancelled.");
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !runtime ||
    runtime.occupancy !== "present" ||
    !(
      runtime.lifecycle === "working" ||
      runtime.lifecycle === "idle" ||
      (runtime.lifecycle === "blocked" && runtime.reason === "question")
    )
  ) {
    throw new Error("The task agent is not running.");
  }
  const generation = runtime.generation;
  await captureAgentTurnCheckpoint(terminalId, generation, true);
  if (cancelled()) throw new Error("The prompt request was cancelled before dispatch.");
  const current = useAgentRuntimeStore.getState().states[terminalId];
  const session = getSession(terminalId);
  if (
    !current ||
    current.occupancy !== "present" ||
    current.generation !== generation ||
    !(
      current.lifecycle === "working" ||
      current.lifecycle === "idle" ||
      (current.lifecycle === "blocked" && current.reason === "question")
    ) ||
    !session ||
    session.exited
  ) {
    throw new Error("The task agent occupant changed before steering.");
  }
  await session.sendPrompt(text);
}

export const queuedAgentPromptCount = (terminalId: string): number =>
  queues.get(terminalId)?.length ?? 0;
