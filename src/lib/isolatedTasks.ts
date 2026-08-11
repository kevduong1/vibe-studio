import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  fsReadFile,
  codexNativeSessionExists,
  gitWorktreeCreate,
  gitWorktreeMerge,
  gitWorktreeRemove,
  type GitWorktreeCreateResult,
} from "./ipc";
import type { AgentKind } from "./agentState";
import { closeAgentTerminal, openGlobalTerminal } from "./agentSessions";
import { getSession } from "./termSessions";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import {
  getWorktreeRoot,
  isolatedTaskForPath,
  useIsolatedTasksStore,
  type IsolatedTask,
  type TaskPlanStep,
} from "../stores/isolatedTasks";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  useAgentTasksStore,
  markAgentTaskFeedback,
} from "../stores/agentTasks";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useReviewCommentsStore } from "../stores/reviewComments";
import {
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_LAUNCH_PROFILES,
  launchCommand,
} from "../stores/agentDefinitions";
import { queueAgentPrompt, steerAgentPrompt } from "./agentPromptQueue";
import { quoteShellArgument } from "./agentLaunchProgram";
import { basename, dirname } from "./path";

export interface WorktreeProjectConfig {
  bootstrapCommand: string | null;
  includeIgnored: string[];
  portStart: number;
}

const DEFAULT_CONFIG: WorktreeProjectConfig = {
  bootstrapCommand: null,
  includeIgnored: [],
  portStart: 4100,
};
const reservedPreviewPorts = new Set<number>();

export async function loadWorktreeProjectConfig(
  parentPath: string,
): Promise<WorktreeProjectConfig> {
  try {
    const file = await fsReadFile(`${parentPath}/.vibe/worktrees.json`);
    if (file.binary || file.truncated) throw new Error("configuration must be a small text file");
    const raw = JSON.parse(file.text) as Record<string, unknown>;
    return {
      bootstrapCommand:
        typeof raw.bootstrapCommand === "string" && raw.bootstrapCommand.trim()
          ? raw.bootstrapCommand.trim()
          : null,
      includeIgnored: Array.isArray(raw.includeIgnored)
        ? [...new Set(raw.includeIgnored.filter(
            (value): value is string => typeof value === "string",
          ))]
        : [],
      portStart:
        typeof raw.portStart === "number" &&
        Number.isInteger(raw.portStart) &&
        raw.portStart >= 1024 &&
        raw.portStart <= 65535
          ? raw.portStart
          : DEFAULT_CONFIG.portStart,
    };
  } catch (error) {
    // A missing config is the normal zero-configuration path. Malformed
    // existing JSON is surfaced because silently skipping setup is unsafe.
    if (/No such file|not found|os error 2/i.test(String(error))) return DEFAULT_CONFIG;
    throw new Error(`Invalid .vibe/worktrees.json: ${String(error)}`);
  }
}

export const slugifyTaskName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";

export const uniqueTaskSuffix = (): string =>
  `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

export const defaultWorktreePath = (parentPath: string, taskName: string): string => {
  const root = getWorktreeRoot() ?? `${dirname(parentPath)}/.vibe-worktrees`;
  return `${root}/${basename(parentPath)}/${slugifyTaskName(taskName)}`;
};

const nextPreviewPort = (start: number): number => {
  const used = new Set(
    [
      ...Object.values(useIsolatedTasksStore.getState().tasks)
        .filter((task) => task.outcome !== "discarded")
        .map((task) => task.previewPort),
      ...reservedPreviewPorts,
    ],
  );
  let value = start;
  while (used.has(value)) {
    if (value >= 65535) throw new Error("No preview port is available");
    value += 1;
  }
  return value;
};

export async function createIsolatedTask(input: {
  name: string;
  parentPath: string;
  path: string;
  branch: string;
  base?: string;
  agentKind: AgentKind | null;
  agentCommand?: string;
  agentPrelude?: string | null;
}): Promise<IsolatedTask> {
  const config = await loadWorktreeProjectConfig(input.parentPath);
  const previewPort = nextPreviewPort(config.portStart);
  reservedPreviewPorts.add(previewPort);
  let result: GitWorktreeCreateResult;
  try {
    result = await gitWorktreeCreate(
      input.parentPath,
      input.path,
      input.branch,
      input.base ?? "HEAD",
      config.includeIgnored,
    );
  } finally {
    reservedPreviewPorts.delete(previewPort);
  }
  const now = Date.now();
  const task: IsolatedTask = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    parentWorkspacePath: input.parentPath,
    worktreePath: result.worktree.path,
    baseCommit: result.baseCommit,
    branch: result.worktree.branch ?? input.branch,
    agentKind: input.agentKind,
    agentTerminalId: null,
    reviewAgentTerminalIds: [],
    nativeSessionRef: null,
    plan: [],
    previewPort,
    bootstrapCommand: config.bootstrapCommand,
    includeIgnored: config.includeIgnored,
    createdAt: now,
    updatedAt: now,
    outcome: "active",
    checkoutRemovedAt: null,
    cleanupProvenance: "created-by-vibe",
  };
  useIsolatedTasksStore.getState().addTask(task);
  try {
    await useWorkspacesStore.getState().openWorkspace(task.worktreePath);
    if (input.agentKind) {
      const terminalId = openGlobalTerminal(
        task.worktreePath,
        input.agentKind,
        input.agentPrelude ?? undefined,
        input.agentCommand,
        task.bootstrapCommand ?? undefined,
      );
      useIsolatedTasksStore.getState().patchTask(task.id, { agentTerminalId: terminalId });
      return { ...task, agentTerminalId: terminalId };
    }
    return task;
  } catch (error) {
    // Creation succeeded and remains recoverable/listable. Persist the task
    // instead of deleting its checkout behind the user's back.
    throw new Error(`Worktree created at ${task.worktreePath}, but opening it failed: ${String(error)}`);
  }
}

export async function mergeIsolatedTask(task: IsolatedTask): Promise<void> {
  const runtime = task.agentTerminalId
    ? useAgentRuntimeStore.getState().states[task.agentTerminalId]
    : undefined;
  if (runtime?.occupancy === "present" && runtime.lifecycle !== "idle") {
    throw new Error("Wait for the task agent to become idle before merging its branch.");
  }
  await gitWorktreeMerge(task.parentWorkspacePath, task.worktreePath);
  useIsolatedTasksStore.getState().patchTask(task.id, { outcome: "applied" });
}

export function keepIsolatedTaskBranch(task: IsolatedTask): void {
  useIsolatedTasksStore.getState().patchTask(task.id, { outcome: "kept" });
}

export async function archiveIsolatedTask(task: IsolatedTask): Promise<void> {
  await useWorkspacesStore.getState().closeWorkspace(task.worktreePath);
  if (useWorkspacesStore.getState().workspaces.some((ws) => ws.path === task.worktreePath)) return;
  useIsolatedTasksStore.getState().patchTask(task.id, { outcome: "archived" });
}

const boundGlobalTerminalIds = (path: string): string[] =>
  Object.values(useAgentTerminalsStore.getState().terminals)
    .filter((terminal) => terminal.workspacePath === path)
    .map((terminal) => terminal.id);

const liveGlobalTerminalIds = (path: string): string[] =>
  boundGlobalTerminalIds(path).filter((id) => {
      const session = getSession(id);
      // A restored tab has no live PTY until attached and is safe to rebind;
      // an attached/running shell blocks checkout deletion.
      return Boolean(session && !session.exited);
    });

const checkoutHasLiveGlobalTerminals = async (path: string): Promise<boolean> => {
  const live = liveGlobalTerminalIds(path);
  if (live.length === 0) return false;
  await message(
    `Stop or close the ${live.length} live global terminal${live.length === 1 ? "" : "s"} bound to this checkout before removing it.`,
    { title: "Checkout Is Still In Use", kind: "warning" },
  );
  return true;
};

export async function discardIsolatedTask(task: IsolatedTask): Promise<void> {
  if (task.cleanupProvenance !== "created-by-vibe") {
    throw new Error("Vibe Studio did not create this checkout, so it will not remove it automatically.");
  }
  if (await checkoutHasLiveGlobalTerminals(task.worktreePath)) return;
  await useWorkspacesStore.getState().closeWorkspace(task.worktreePath);
  if (useWorkspacesStore.getState().workspaces.some((ws) => ws.path === task.worktreePath)) return;
  if (await checkoutHasLiveGlobalTerminals(task.worktreePath)) return;
  try {
    await gitWorktreeRemove(task.parentWorkspacePath, task.worktreePath, false);
  } catch (error) {
    const force = await confirm(
      `Git refused to remove the checkout:\n\n${String(error)}\n\nForce removal? The branch “${task.branch}” will be kept, but uncommitted checkout changes will be lost.`,
      { title: "Force Remove Worktree?", kind: "warning" },
    );
    if (!force) return;
    if (await checkoutHasLiveGlobalTerminals(task.worktreePath)) return;
    await gitWorktreeRemove(task.parentWorkspacePath, task.worktreePath, true);
  }
  for (const terminalId of boundGlobalTerminalIds(task.worktreePath)) {
    closeAgentTerminal(terminalId);
  }
  useIsolatedTasksStore.getState().patchTask(task.id, {
    outcome: "discarded",
    checkoutRemovedAt: Date.now(),
  });
}

export const activeTaskForPath = (path: string): IsolatedTask | undefined =>
  isolatedTaskForPath(path);

/** Batch session-only line comments into one bounded follow-up. Writes are
 * allowed only while the same detected occupant generation owns an agent
 * prompt: idle, or a screen-classified question (never permission/auth). */
export async function sendIsolatedTaskFeedback(task: IsolatedTask): Promise<void> {
  const terminalId = task.agentTerminalId;
  if (!terminalId) throw new Error("This task has no agent terminal");
  const owner = useAgentTasksStore.getState().tasks[terminalId];
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !owner ||
    owner.isolatedTaskId !== task.id ||
    !runtime ||
    runtime.generation !== owner.generation ||
    runtime.occupancy !== "present"
  ) {
    throw new Error("The original agent occupant is no longer present; review the terminal before sending feedback");
  }
  const ownsPrompt =
    runtime.lifecycle === "idle" ||
    (runtime.lifecycle === "blocked" && runtime.reason === "question");
  if (!ownsPrompt) {
    throw new Error("Feedback can be sent only while the agent is idle or waiting on a question");
  }
  const session = getSession(terminalId);
  if (!session || session.exited) throw new Error("The agent terminal is no longer live");
  const comments = useReviewCommentsStore
    .getState()
    .comments.filter((comment) => comment.taskId === task.id);
  if (comments.length === 0) throw new Error("Add at least one line comment first");
  const followup = comments
    .slice(0, 50)
    .map((comment) =>
      `${comment.path}:${comment.line} — ${comment.body.replace(/[\r\n]+/g, " ").trim()}`,
    )
    .join("; ");
  await queueAgentPrompt(terminalId, `Review feedback: ${followup}`);
  markAgentTaskFeedback(terminalId);
  useReviewCommentsStore.getState().clearTask(task.id);
}

export function launchReadOnlyReviewAgent(task: IsolatedTask): string {
  const definition = BUILTIN_AGENT_DEFINITIONS.find((item) => item.id === "builtin.codex")!;
  const base = BUILTIN_LAUNCH_PROFILES.find((item) => item.id === "builtin.codex.yolo")!;
  const built = launchCommand(definition, {
    ...base,
    permissionMode: "never",
    sandbox: "read-only",
    extraArguments: [
      `Review the changes in this isolated task against base ${task.baseCommit}. Do not modify files. Report correctness, safety, and missing-test findings.`,
    ],
  });
  const terminalId = openGlobalTerminal(
    task.worktreePath,
    "codex",
    built.environmentPrelude ?? undefined,
    built.command,
  );
  useIsolatedTasksStore.getState().patchTask(task.id, {
    reviewAgentTerminalIds: [...(task.reviewAgentTerminalIds ?? []), terminalId],
  });
  return terminalId;
}

export async function restoreTaskCode(task: IsolatedTask): Promise<void> {
  await useWorkspacesStore.getState().openWorkspace(task.worktreePath);
  useIsolatedTasksStore.getState().patchTask(task.id, { outcome: "active" });
}

export async function restoreTaskConversation(task: IsolatedTask): Promise<void> {
  await restoreTaskCode(task);
  const ref = task.nativeSessionRef;
  if (ref && ref.transport === "agent-hook" && task.agentKind === "codex") {
    let available = false;
    try {
      available = await codexNativeSessionExists(task.worktreePath, ref.id);
    } catch {
      available = false;
    }
    if (available) {
      const approved = await confirm(
        "Resume the saved Codex conversation in a terminal shell for this checkout?",
        { title: "Restore Conversation?", kind: "info" },
      );
      if (!approved) return;
      const terminalId = openGlobalTerminal(
        task.worktreePath,
        "codex",
        undefined,
        `codex --yolo resume ${quoteShellArgument(ref.id)}`,
      );
      useIsolatedTasksStore.getState().patchTask(task.id, { agentTerminalId: terminalId });
      return;
    }
  }
  // Explicit fallback: never guess, scrape output, or use --last.
  openGlobalTerminal(task.worktreePath, "shell");
  await message(
    ref
      ? "The saved Codex conversation reference is no longer valid for this checkout. Opened a fresh shell instead."
      : "No unambiguous native conversation reference is available. Opened a fresh shell in the restored checkout instead.",
    { title: "Conversation Not Restorable", kind: "info" },
  );
}

export async function forkIsolatedTask(task: IsolatedTask): Promise<IsolatedTask> {
  const suffix = uniqueTaskSuffix();
  const name = `${task.name} fork`;
  return createIsolatedTask({
    name,
    parentPath: task.parentWorkspacePath,
    path: `${defaultWorktreePath(task.parentWorkspacePath, name)}-${suffix}`,
    branch: `${task.branch}-fork-${suffix}`,
    base: task.branch,
    agentKind: null,
  });
}

const patchPlanStep = (
  taskId: string,
  stepId: string,
  patch: Partial<TaskPlanStep>,
): void => {
  const task = useIsolatedTasksStore.getState().tasks[taskId];
  if (!task) return;
  useIsolatedTasksStore.getState().patchTask(taskId, {
    plan: task.plan.map((step) => step.id === stepId ? { ...step, ...patch, id: step.id } : step),
  });
};

/** Dispatch an approved plan step. Queue and steer target the exact live
 * parent occupant; isolated mode serializes Git worktree creation while the
 * resulting Best-of-N agents run concurrently. */
export async function dispatchTaskPlanStep(
  task: IsolatedTask,
  requestedStep: TaskPlanStep,
): Promise<void> {
  const latestTask = useIsolatedTasksStore.getState().tasks[task.id];
  const step = latestTask?.plan.find((item) => item.id === requestedStep.id);
  if (!latestTask || !step) throw new Error("Plan step no longer exists.");
  if (step.status !== "approved") throw new Error("Approve the step before dispatching it.");
  const incomplete = step.dependsOn.filter((id) =>
    latestTask.plan.find((candidate) => candidate.id === id)?.status !== "completed",
  );
  if (incomplete.length > 0) throw new Error("Complete the step dependencies first.");
  const prompt = [
    `Implement plan step “${step.title}” for isolated task “${latestTask.name}”.`,
    step.prompt.trim(),
    "Keep the work scoped to this step and report validation evidence.",
  ].filter(Boolean).join("\n\n");

  if (step.dispatch === "queue" || step.dispatch === "steer") {
    const terminalId = latestTask.agentTerminalId;
    if (!terminalId) throw new Error("This task has no owning agent terminal.");
    if (step.dispatch === "queue") await queueAgentPrompt(terminalId, prompt);
    else await steerAgentPrompt(terminalId, prompt);
    patchPlanStep(task.id, step.id, { status: "running" });
    return;
  }

  const childTaskIds = [...step.childTaskIds];
  patchPlanStep(task.id, step.id, { status: "running" });
  try {
    for (let candidate = 1; candidate <= step.candidateCount; candidate += 1) {
      const suffix = `${uniqueTaskSuffix()}-${candidate}`;
      const candidateLabel = step.candidateCount > 1 ? ` candidate ${candidate}` : "";
      const name = `${step.title}${candidateLabel}`;
      const kind = latestTask.agentKind ?? "codex";
      const candidatePrompt = step.candidateCount > 1
        ? `${prompt}\n\nThis is Best-of-N candidate ${candidate} of ${step.candidateCount}; do not coordinate with sibling candidates.`
        : prompt;
      const agentCommand = kind === "codex"
        ? `codex --yolo ${quoteShellArgument(candidatePrompt)}`
        : `claude ${quoteShellArgument(candidatePrompt)}`;
      const child = await createIsolatedTask({
        name,
        parentPath: latestTask.parentWorkspacePath,
        path: `${defaultWorktreePath(latestTask.parentWorkspacePath, name)}-${suffix}`,
        branch: `${latestTask.branch}-${slugifyTaskName(step.title)}-${suffix}`,
        base: latestTask.branch,
        agentKind: kind,
        agentCommand,
      });
      childTaskIds.push(child.id);
      patchPlanStep(task.id, step.id, { childTaskIds: [...childTaskIds] });
    }
  } catch (error) {
    patchPlanStep(task.id, step.id, { status: "blocked", childTaskIds });
    throw error;
  }
}
