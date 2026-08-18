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
import {
  queueAgentPrompt,
  steerAgentPrompt,
} from "./agentPromptQueue";
import {
  buildReviewFeedbackBatch,
  mergeOwnerProofMatches,
  type MergeOwnerProof,
} from "./isolatedTaskSafety";
export {
  MAX_REVIEW_FEEDBACK_COMMENTS,
  MAX_REVIEW_FEEDBACK_COMMENT_CHARS,
} from "./isolatedTaskSafety";
import { quoteShellArgument } from "./agentLaunchProgram";
import { codexCliCommand } from "./codexTerminalTitle";
import { basename, dirname } from "./path";
import {
  withWorktreePathsLocked,
  worktreePathOperationPending,
} from "./worktreeOperations";

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
    const file = await fsReadFile(`${parentPath}/.talos/worktrees.json`);
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
    throw new Error(`Invalid .talos/worktrees.json: ${String(error)}`);
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
  const root = getWorktreeRoot() ?? `${dirname(parentPath)}/.talos-worktrees`;
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

async function createIsolatedTaskUnlocked(input: {
  name: string;
  parentPath: string;
  path: string;
  branch: string;
  base?: string;
  agentKind: AgentKind | null;
  agentCommand?: string;
  agentPrelude?: string | null;
  /** Cooperative cancellation for callers such as the local control plane.
   * Git worktree creation itself is not interruptible, so a cancellation that
   * arrives during it retains the new checkout and task record but never
   * opens the workspace or launches an agent. */
  cancelled?: () => boolean;
  /** Authoritative control-plane commit immediately before agent launch. */
  beforeLaunch?: () => Promise<void>;
}): Promise<IsolatedTask> {
  if (input.cancelled?.()) throw new Error("Isolated task creation was cancelled.");
  const config = await loadWorktreeProjectConfig(input.parentPath);
  if (input.cancelled?.()) throw new Error("Isolated task creation was cancelled.");
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
    nativeSessionRef: null,
    plan: [],
    previewPort,
    bootstrapCommand: config.bootstrapCommand,
    includeIgnored: config.includeIgnored,
    createdAt: now,
    updatedAt: now,
    outcome: "active",
    checkoutRemovedAt: null,
    cleanupProvenance: "created-by-talos",
  };
  useIsolatedTasksStore.getState().addTask(task);
  if (input.cancelled?.()) {
    throw new Error(
      `Isolated task creation was cancelled after Git created ${task.worktreePath}. The recoverable checkout and task record were retained; no agent was launched.`,
    );
  }
  try {
    await useWorkspacesStore.getState().openWorkspace(task.worktreePath);
    if (input.cancelled?.()) {
      throw new Error(
        "Isolated task creation was cancelled after the checkout opened. The task was retained and no agent was launched.",
      );
    }
    if (input.agentKind) {
      await input.beforeLaunch?.();
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

export function createIsolatedTask(
  input: Parameters<typeof createIsolatedTaskUnlocked>[0],
): Promise<IsolatedTask> {
  return withWorktreePathsLocked(
    [input.parentPath, input.path],
    () => createIsolatedTaskUnlocked(input),
  );
}

const proveMergeOwner = (terminalId: string): MergeOwnerProof => {
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  const session = getSession(terminalId);
  const sessionIsLive = Boolean(session && !session.exited);
  if (
    runtime?.occupancy === "present" &&
    runtime.lifecycle === "idle" &&
    sessionIsLive
  ) {
    return {
      terminalId,
      generation: runtime.generation,
      occupancy: runtime.occupancy,
      lifecycle: runtime.lifecycle,
      runtimeChangedAt: runtime.changedAt,
      sessionIsLive,
    };
  }
  if (
    runtime?.occupancy === "absent" ||
    runtime?.occupancy === "exited" ||
    (!runtime && !sessionIsLive)
  ) {
    return {
      terminalId,
      generation: runtime?.generation ?? null,
      occupancy: runtime?.occupancy ?? null,
      lifecycle: runtime?.lifecycle ?? null,
      runtimeChangedAt: runtime?.changedAt ?? null,
      sessionIsLive,
    };
  }
  throw new Error(
    "The task agent must be proven idle or stopped before its branch can be merged. Wait for process detection to settle or close the agent terminal.",
  );
};

const mergeOwnerStillSafe = (proof: MergeOwnerProof): boolean => {
  const runtime = useAgentRuntimeStore.getState().states[proof.terminalId];
  const session = getSession(proof.terminalId);
  return mergeOwnerProofMatches(proof, runtime, Boolean(session && !session.exited));
};

export function mergeIsolatedTask(task: IsolatedTask): Promise<void> {
  return withWorktreePathsLocked(
    [task.parentWorkspacePath, task.worktreePath],
    async () => {
      const before = useIsolatedTasksStore.getState().tasks[task.id];
      if (
        !before ||
        before.outcome !== "active" ||
        before.parentWorkspacePath !== task.parentWorkspacePath ||
        before.worktreePath !== task.worktreePath
      ) {
        throw new Error("The task changed before its branch could be merged.");
      }
      const proof = before.agentTerminalId
        ? proveMergeOwner(before.agentTerminalId)
        : null;
      await gitWorktreeMerge(task.parentWorkspacePath, task.worktreePath);
      const latestTask = useIsolatedTasksStore.getState().tasks[task.id];
      const taskChanged =
        !latestTask ||
        latestTask.outcome !== before.outcome ||
        latestTask.parentWorkspacePath !== before.parentWorkspacePath ||
        latestTask.worktreePath !== before.worktreePath ||
        latestTask.agentTerminalId !== before.agentTerminalId;
      if (taskChanged || (proof && !mergeOwnerStillSafe(proof))) {
        throw new Error(
          "The task or its agent changed state while Git was merging. Git may already have merged the previously reviewed commits, but the task was not marked Applied; review its current changes before merging again.",
        );
      }
      if (!useIsolatedTasksStore.getState().transitionOutcome(task.id, "active", "applied")) {
        throw new Error("The task outcome changed before its merge could be recorded.");
      }
    },
  );
}

export function keepIsolatedTaskBranch(task: IsolatedTask): Promise<void> {
  return withWorktreePathsLocked(
    [task.parentWorkspacePath, task.worktreePath],
    async () => {
      if (!useIsolatedTasksStore.getState().transitionOutcome(task.id, "active", "kept")) {
        throw new Error("The task outcome changed before its branch could be kept.");
      }
    },
  );
}

export function archiveIsolatedTask(task: IsolatedTask): Promise<void> {
  return withWorktreePathsLocked(
    [task.parentWorkspacePath, task.worktreePath],
    async () => {
      const before = useIsolatedTasksStore.getState().tasks[task.id];
      if (
        !before ||
        before.outcome !== task.outcome ||
        before.outcome === "archived" ||
        before.outcome === "discarded"
      ) {
        throw new Error("The task outcome changed before it could be archived.");
      }
      await useWorkspacesStore.getState().closeWorkspace(task.worktreePath);
      if (useWorkspacesStore.getState().workspaces.some((ws) => ws.path === task.worktreePath)) {
        return;
      }
      if (!useIsolatedTasksStore.getState().transitionOutcome(
        task.id,
        before.outcome,
        "archived",
      )) {
        throw new Error("The task outcome changed before it could be archived.");
      }
    },
  );
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

const liveWorkspaceTerminalIds = (path: string): string[] =>
  useWorkspacesStore.getState().workspaces
    .filter((workspace) => workspace.path === path)
    .flatMap((workspace) => Object.keys(workspace.terminal.getState().terminals))
    .filter((id) => {
      const session = getSession(id);
      return Boolean(session && !session.exited);
    });

const liveCheckoutTerminalIds = (path: string): string[] => [
  ...new Set([...liveGlobalTerminalIds(path), ...liveWorkspaceTerminalIds(path)]),
];

const checkoutHasLiveGlobalTerminals = async (path: string): Promise<boolean> => {
  const live = liveGlobalTerminalIds(path);
  if (live.length === 0) return false;
  await message(
    `Stop or close the ${live.length} live global terminal${live.length === 1 ? "" : "s"} bound to this checkout before removing it.`,
    { title: "Checkout Is Still In Use", kind: "warning" },
  );
  return true;
};

const liveDependentTasks = (path: string): IsolatedTask[] =>
  Object.values(useIsolatedTasksStore.getState().tasks).filter(
    (task) =>
      task.parentWorkspacePath === path &&
      task.worktreePath !== path &&
      task.outcome !== "discarded" &&
      task.checkoutRemovedAt === null,
  );

const checkoutHasDependentTasks = async (path: string): Promise<boolean> => {
  const dependents = liveDependentTasks(path);
  if (dependents.length === 0) return false;
  const names = dependents.slice(0, 3).map((task) => `“${task.name}”`).join(", ");
  const remainder = dependents.length > 3 ? ` and ${dependents.length - 3} more` : "";
  await message(
    `This checkout is the parent repository for ${dependents.length} retained isolated task${dependents.length === 1 ? "" : "s"}: ${names}${remainder}. Remove or re-create those task checkouts before removing their parent.`,
    { title: "Checkout Has Dependent Tasks", kind: "warning" },
  );
  return true;
};

/**
 * Explicitly remove a linked checkout while retaining its branch. Workspace
 * editor prompts and live global terminals get a chance to stop the removal
 * before Git is invoked. Returns false when any safety gate stops the removal.
 */
async function removeWorktreeCheckoutUnlocked(
  repoPath: string,
  worktreePath: string,
  branch: string | null,
): Promise<boolean> {
  if (await checkoutHasDependentTasks(worktreePath)) return false;
  if (await checkoutHasLiveGlobalTerminals(worktreePath)) return false;
  await useWorkspacesStore.getState().closeWorkspace(worktreePath);
  if (useWorkspacesStore.getState().workspaces.some((ws) => ws.path === worktreePath)) return false;
  if (await checkoutHasDependentTasks(worktreePath)) return false;
  if (await checkoutHasLiveGlobalTerminals(worktreePath)) return false;
  try {
    await gitWorktreeRemove(repoPath, worktreePath, false);
  } catch (error) {
    const force = await confirm(
      `Git refused to remove the checkout:\n\n${String(error)}\n\nForce removal? ${branch ? `The branch “${branch}” will be kept, but ` : ""}the worktree lock will be overridden and uncommitted checkout changes will be lost.`,
      { title: "Force Remove Worktree?", kind: "warning" },
    );
    if (!force) return false;
    if (await checkoutHasDependentTasks(worktreePath)) return false;
    if (await checkoutHasLiveGlobalTerminals(worktreePath)) return false;
    await gitWorktreeRemove(repoPath, worktreePath, true);
  }
  for (const terminalId of boundGlobalTerminalIds(worktreePath)) {
    closeAgentTerminal(terminalId);
  }
  // Global terminal groupings remember their last workspace independently of
  // their tabs. Clear that navigation target after the checkout is gone so an
  // empty or background grouping can never try to reopen the deleted path.
  useAgentTerminalsStore.getState().forgetWorkspace(
    worktreePath,
    useWorkspacesStore.getState().activePath,
  );
  return true;
}

export function removeWorktreeCheckout(
  repoPath: string,
  worktreePath: string,
  branch: string | null,
): Promise<boolean> {
  return withWorktreePathsLocked(
    [repoPath, worktreePath],
    () => removeWorktreeCheckoutUnlocked(repoPath, worktreePath, branch),
  );
}

/** Remove a task's checkout but retain its task record under Removed tasks. */
export function removeIsolatedTaskWorktree(task: IsolatedTask): Promise<boolean> {
  return withWorktreePathsLocked(
    [task.parentWorkspacePath, task.worktreePath],
    async () => {
      const before = useIsolatedTasksStore.getState().tasks[task.id];
      if (
        !before ||
        before.outcome !== task.outcome ||
        before.outcome === "discarded" ||
        before.parentWorkspacePath !== task.parentWorkspacePath ||
        before.worktreePath !== task.worktreePath
      ) {
        throw new Error("The task outcome changed before its checkout could be removed.");
      }
      const removed = await removeWorktreeCheckoutUnlocked(
        task.parentWorkspacePath,
        task.worktreePath,
        task.branch,
      );
      if (!removed) return false;
      if (!useIsolatedTasksStore.getState().transitionOutcome(
        task.id,
        before.outcome,
        "discarded",
        { checkoutRemovedAt: Date.now() },
      )) {
        throw new Error(
          "The task outcome changed after Git removed its checkout. The checkout is gone, but the task record was left unchanged for review.",
        );
      }
      return true;
    },
  );
}

export async function discardIsolatedTask(task: IsolatedTask): Promise<boolean> {
  if (task.cleanupProvenance !== "created-by-talos") {
    throw new Error("Talos did not create this checkout, so it will not remove it automatically.");
  }
  return removeIsolatedTaskWorktree(task);
}

/** Permanently delete Talos metadata only; the checkout and branch remain. */
export function deleteIsolatedTaskRecord(task: IsolatedTask): void {
  if (worktreePathOperationPending(task.worktreePath)) {
    throw new Error(
      "Wait for this task's worktree creation, merge, or removal operation to finish before deleting its record.",
    );
  }
  const live = liveCheckoutTerminalIds(task.worktreePath);
  if (live.length > 0) {
    throw new Error(
      `Close the ${live.length} live terminal${live.length === 1 ? "" : "s"} bound to this task before deleting its record. This keeps its reserved PORT from being assigned to another live task.`,
    );
  }
  useReviewCommentsStore.getState().clearTask(task.id);
  useIsolatedTasksStore.getState().deleteTask(task.id);
}

export const activeTaskForPath = (path: string): IsolatedTask | undefined =>
  isolatedTaskForPath(path);

/** Batch session-only line comments into one bounded follow-up. Writes are
 * allowed only while the same detected occupant generation owns an agent
 * prompt: idle, or a screen-classified question (never permission/auth). */
export async function sendIsolatedTaskFeedback(task: IsolatedTask): Promise<void> {
  const latestIsolatedTask = useIsolatedTasksStore.getState().tasks[task.id];
  if (!latestIsolatedTask || latestIsolatedTask.agentTerminalId !== task.agentTerminalId) {
    throw new Error("The task's owning agent changed before feedback could be sent");
  }
  const terminalId = latestIsolatedTask.agentTerminalId;
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
  if (!owner.latestFingerprint) {
    throw new Error("Current review evidence is not available yet");
  }
  const expectedGeneration = owner.generation;
  const expectedFingerprint = owner.latestFingerprint;
  const comments = useReviewCommentsStore
    .getState()
    .comments.filter((comment) => comment.taskId === task.id);
  if (comments.length === 0) throw new Error("Add at least one line comment first");
  if (comments.some((comment) =>
    comment.terminalId !== terminalId ||
    comment.generation !== expectedGeneration ||
    comment.fingerprint !== expectedFingerprint
  )) {
    throw new Error(
      "Review evidence changed after one or more comments were drafted. Remove the outdated comments and review the current changes before sending feedback.",
    );
  }
  const batch = buildReviewFeedbackBatch(comments);
  await queueAgentPrompt(terminalId, batch.prompt, undefined, (checkpoint) => {
    const latest = useAgentTasksStore.getState().tasks[terminalId];
    const latestTaskOwner = useIsolatedTasksStore.getState().tasks[task.id];
    const currentComments = useReviewCommentsStore.getState().comments;
    if (
      !latest ||
      latestTaskOwner?.agentTerminalId !== terminalId ||
      latest.isolatedTaskId !== task.id ||
      latest.generation !== expectedGeneration ||
      latest.latestFingerprint !== expectedFingerprint ||
      checkpoint.checkpoint.snapshot.fingerprint !== expectedFingerprint ||
      batch.comments.some((comment) =>
        !currentComments.some((current) =>
          current.id === comment.id &&
          current.terminalId === terminalId &&
          current.generation === expectedGeneration &&
          current.fingerprint === expectedFingerprint
        )
      )
    ) {
      throw new Error(
        "Review evidence or its drafted comments changed before feedback reached the terminal. Review the current changes and try again.",
      );
    }
  });
  const marked = markAgentTaskFeedback(
    terminalId,
    expectedGeneration,
    expectedFingerprint,
  );
  for (const comment of batch.comments) {
    useReviewCommentsStore.getState().remove(comment.id);
  }
  if (!marked) {
    throw new Error(
      "Feedback was delivered for the reviewed evidence, but newer changes arrived before it could be marked Needs changes. The sent comments were removed; review the current evidence before sending more.",
    );
  }
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
  return openGlobalTerminal(
    task.worktreePath,
    "codex",
    built.environmentPrelude ?? undefined,
    built.command,
  );
}

export function restoreTaskCode(task: IsolatedTask): Promise<void> {
  return withWorktreePathsLocked(
    [task.parentWorkspacePath, task.worktreePath],
    async () => {
      const before = useIsolatedTasksStore.getState().tasks[task.id];
      if (!before || before.outcome !== "archived") {
        throw new Error("The task outcome changed before its code could be restored.");
      }
      await useWorkspacesStore.getState().openWorkspace(task.worktreePath);
      if (!useIsolatedTasksStore.getState().transitionOutcome(task.id, "archived", "active")) {
        throw new Error("The task outcome changed before its code could be restored.");
      }
    },
  );
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
        codexCliCommand("--yolo", "resume", ref.id),
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
        ? codexCliCommand("--yolo", candidatePrompt)
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
