import {
  agentControlRespond,
  agentControlPromptBoundary,
  agentControlSync,
  onAgentControlCancel,
  onAgentControlRequest,
  type AgentControlRequest,
} from "./ipc";
import { focusAgentTerminal } from "./agentInbox";
import {
  cancelQueuedAgentPrompt,
  queueAgentPrompt,
  steerAgentPrompt,
} from "./agentPromptQueue";
import {
  createIsolatedTask,
  defaultWorktreePath,
  slugifyTaskName,
  uniqueTaskSuffix,
} from "./isolatedTasks";
import { openGlobalTerminal } from "./agentSessions";
import {
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_LAUNCH_PROFILES,
  launchCommand,
} from "../stores/agentDefinitions";
import { gitOpen } from "./ipc";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useWorkspacesStore } from "../stores/workspaces";

function commandFor(kind: "claude" | "codex", prompt: string | null): {
  command: string;
  prelude: string | null;
} {
  const definition = BUILTIN_AGENT_DEFINITIONS.find((item) => item.detectionProfile === kind)!;
  const profile = BUILTIN_LAUNCH_PROFILES.find((item) => item.definitionId === definition.id)!;
  const built = launchCommand(definition, {
    ...profile,
    extraArguments: prompt?.trim() ? [prompt.trim()] : [],
  });
  return { command: built.command, prelude: built.environmentPrelude };
}

const throwIfCancelled = (cancelled: () => boolean): void => {
  if (cancelled()) throw new Error("request cancelled");
};

export async function handleAgentControlRequest(
  request: AgentControlRequest,
  cancelled: () => boolean,
): Promise<unknown> {
  throwIfCancelled(cancelled);
  if (request.action === "focus") {
    if (!request.terminalId) throw new Error("terminalId is required");
    const result = await focusAgentTerminal(request.terminalId);
    throwIfCancelled(cancelled);
    if (!result.ok) throw new Error(result.message);
    return { terminalId: request.terminalId };
  }
  if (request.action === "prompt") {
    if (!request.terminalId || request.generation == null || !request.text?.trim()) {
      throw new Error("terminalId, generation, and text are required");
    }
    const runtime = useAgentRuntimeStore.getState().states[request.terminalId];
    if (!runtime || runtime.generation !== request.generation || runtime.occupancy !== "present") {
      throw new Error("terminal occupant generation changed");
    }
    let promptBaselineSeq: number | null = null;
    let promptBaselineWorking: boolean | null = null;
    const capturePromptBoundary = async () => {
      throwIfCancelled(cancelled);
      const boundary = await agentControlPromptBoundary(
        request.requestId,
        request.deliveryId,
      );
      promptBaselineSeq = boundary.seq;
      promptBaselineWorking = boundary.working;
      throwIfCancelled(cancelled);
    };
    if (request.mode === "steer") {
      await steerAgentPrompt(
        request.terminalId,
        request.text,
        cancelled,
        capturePromptBoundary,
      );
    } else {
      await queueAgentPrompt(
        request.terminalId,
        request.text,
        request.deliveryId,
        capturePromptBoundary,
      );
    }
    return {
      terminalId: request.terminalId,
      generation: request.generation,
      mode: request.mode === "steer" ? "steer" : "queue",
      promptBaselineSeq,
      promptBaselineWorking,
    };
  }
  if (!request.workspacePath) throw new Error("workspacePath is required");
  const kind = request.kind === "claude" ? "claude" : "codex";
  const name = request.taskName?.trim() || `API ${kind} task`;
  const built = commandFor(kind, request.text);
  if (request.isolated) {
    const suffix = uniqueTaskSuffix();
    const task = await createIsolatedTask({
      name,
      parentPath: request.workspacePath,
      path: `${defaultWorktreePath(request.workspacePath, name)}-${suffix}`,
      branch: `vibe/${slugifyTaskName(name)}-${suffix}`,
      agentKind: kind,
      agentCommand: built.command,
      agentPrelude: built.prelude,
      cancelled,
    });
    // createIsolatedTask checks immediately before its synchronous terminal
    // launch. That launch is the commit point; do not report cancellation for
    // an agent that has already been started successfully.
    return { taskId: task.id, terminalId: task.agentTerminalId, workspacePath: task.worktreePath };
  }
  const workspace = await gitOpen(request.workspacePath);
  throwIfCancelled(cancelled);
  await useWorkspacesStore.getState().openWorkspace(workspace.root, false);
  throwIfCancelled(cancelled);
  const terminalId = openGlobalTerminal(
    workspace.root,
    kind,
    built.prelude ?? undefined,
    built.command,
  );
  return { terminalId, workspacePath: workspace.root };
}

/** Synchronize semantic authority into Rust and serve frontend-routed control
 * requests. The socket never writes directly to PTYs or guesses generations. */
export function listenAgentControlPlane(): () => void {
  let disposed = false;
  let syncTimer: number | null = null;
  let unlistenRequest: (() => void) | null = null;
  let unlistenCancel: (() => void) | null = null;
  // Caller request IDs may be reused after timeout while an older frontend
  // handler is still unwinding. Track the backend nonce so late responses,
  // boundaries, and cancels apply only to their exact delivery.
  const activeDeliveries = new Map<string, string>();
  const cancelledDeliveries = new Set<string>();
  const sync = () => {
    if (disposed || syncTimer !== null) return;
    syncTimer = window.setTimeout(() => {
      syncTimer = null;
      void agentControlSync(Object.values(useAgentRuntimeStore.getState().states)).catch(() => {});
    }, 0);
  };
  const unsubscribe = useAgentRuntimeStore.subscribe(sync);
  sync();
  void onAgentControlRequest((request) => {
    activeDeliveries.set(request.deliveryId, request.requestId);
    const cancelled = () =>
      cancelledDeliveries.has(request.deliveryId) || Date.now() >= request.deadlineAtMs;
    void handleAgentControlRequest(request, cancelled).then(
      (result) => agentControlRespond(
        request.requestId,
        request.deliveryId,
        true,
        result,
      ),
      (error) => agentControlRespond(
        request.requestId,
        request.deliveryId,
        false,
        undefined,
        String(error),
      ),
    ).catch(() => {}).finally(() => {
      if (activeDeliveries.get(request.deliveryId) === request.requestId) {
        activeDeliveries.delete(request.deliveryId);
      }
      cancelledDeliveries.delete(request.deliveryId);
    });
  }).then((value) => {
    if (disposed) value();
    else unlistenRequest = value;
  }).catch(() => {});
  void onAgentControlCancel(({ requestId, deliveryId }) => {
    if (activeDeliveries.get(deliveryId) !== requestId) return;
    cancelledDeliveries.add(deliveryId);
    cancelQueuedAgentPrompt(deliveryId);
  }).then((value) => {
    if (disposed) value();
    else unlistenCancel = value;
  }).catch(() => {});
  return () => {
    disposed = true;
    unsubscribe();
    unlistenRequest?.();
    unlistenCancel?.();
    if (syncTimer !== null) window.clearTimeout(syncTimer);
  };
}
