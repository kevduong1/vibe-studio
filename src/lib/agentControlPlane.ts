import {
  agentControlRespond,
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

async function handle(
  request: AgentControlRequest,
  cancelled: () => boolean,
): Promise<unknown> {
  if (cancelled()) throw new Error("request cancelled");
  if (request.action === "focus") {
    if (!request.terminalId) throw new Error("terminalId is required");
    const result = await focusAgentTerminal(request.terminalId);
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
    if (request.mode === "steer") {
      await steerAgentPrompt(request.terminalId, request.text, cancelled);
    } else {
      await queueAgentPrompt(request.terminalId, request.text, request.requestId);
    }
    return {
      terminalId: request.terminalId,
      generation: request.generation,
      mode: request.mode === "steer" ? "steer" : "queue",
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
    });
    return { taskId: task.id, terminalId: task.agentTerminalId, workspacePath: task.worktreePath };
  }
  const workspace = await gitOpen(request.workspacePath);
  await useWorkspacesStore.getState().openWorkspace(workspace.root, false);
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
  const activeRequests = new Set<string>();
  const cancelledRequests = new Set<string>();
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
    activeRequests.add(request.requestId);
    void handle(request, () => cancelledRequests.has(request.requestId)).then(
      (result) => agentControlRespond(request.requestId, true, result),
      (error) => agentControlRespond(request.requestId, false, undefined, String(error)),
    ).catch(() => {}).finally(() => {
      activeRequests.delete(request.requestId);
      cancelledRequests.delete(request.requestId);
    });
  }).then((value) => {
    if (disposed) value();
    else unlistenRequest = value;
  }).catch(() => {});
  void onAgentControlCancel((requestId) => {
    if (!activeRequests.has(requestId)) return;
    cancelledRequests.add(requestId);
    cancelQueuedAgentPrompt(requestId);
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
