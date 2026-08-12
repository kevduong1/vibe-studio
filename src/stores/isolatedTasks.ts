import { create } from "zustand";
import type { AgentKind } from "../lib/agentState";

const STORAGE_KEY = "vibe-studio:isolated-tasks";
const ROOT_KEY = "vibe-studio:worktree-root";

export type IsolatedTaskOutcome =
  | "active"
  | "applied"
  | "kept"
  | "archived"
  | "discarded";

export type TaskPlanStepStatus = "draft" | "approved" | "running" | "completed" | "blocked";
export type TaskPlanDispatch = "worktree" | "queue" | "steer";

export interface TaskPlanStep {
  id: string;
  title: string;
  prompt: string;
  status: TaskPlanStepStatus;
  dispatch: TaskPlanDispatch;
  dependsOn: string[];
  /** 1 is a normal isolated run; 2-4 create parallel Best-of-N candidates. */
  candidateCount: number;
  childTaskIds: string[];
}

export interface IsolatedTask {
  id: string;
  name: string;
  parentWorkspacePath: string;
  worktreePath: string;
  baseCommit: string;
  branch: string;
  agentKind: AgentKind | null;
  agentTerminalId: string | null;
  nativeSessionRef: { transport: "agent-hook"; id: string } | null;
  plan: TaskPlanStep[];
  previewPort: number;
  bootstrapCommand: string | null;
  includeIgnored: string[];
  createdAt: number;
  updatedAt: number;
  outcome: IsolatedTaskOutcome;
  /** Checkout cleanup is separate from task/workspace state. */
  checkoutRemovedAt: number | null;
  /** Records that Vibe Studio created the checkout and may offer cleanup. */
  cleanupProvenance: "created-by-vibe" | "opened-existing";
}

interface PersistedState {
  version: 1;
  tasks: Record<string, IsolatedTask>;
}

interface IsolatedTasksState {
  tasks: Record<string, IsolatedTask>;
  addTask: (task: IsolatedTask) => void;
  patchTask: (id: string, patch: Partial<IsolatedTask>) => void;
  /** Permanently remove one task record and references to it from parent plans. */
  deleteTask: (id: string) => void;
}

const PLAN_STATUSES: TaskPlanStepStatus[] = ["draft", "approved", "running", "completed", "blocked"];
const PLAN_DISPATCHES: TaskPlanDispatch[] = ["worktree", "queue", "steer"];
const TASK_OUTCOMES: IsolatedTaskOutcome[] = ["active", "applied", "kept", "archived", "discarded"];

const sanitizePlanStep = (value: unknown): TaskPlanStep | null => {
  if (!value || typeof value !== "object") return null;
  const step = value as Record<string, unknown>;
  if (typeof step.id !== "string" || typeof step.title !== "string") return null;
  return {
    id: step.id,
    title: step.title,
    prompt: typeof step.prompt === "string" ? step.prompt : step.title,
    status: PLAN_STATUSES.includes(step.status as TaskPlanStepStatus)
      ? step.status as TaskPlanStepStatus
      : "draft",
    dispatch: PLAN_DISPATCHES.includes(step.dispatch as TaskPlanDispatch)
      ? step.dispatch as TaskPlanDispatch
      : "worktree",
    dependsOn: Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((item): item is string => typeof item === "string")
      : [],
    candidateCount: Math.max(1, Math.min(4, Number(step.candidateCount) || 1)),
    childTaskIds: Array.isArray(step.childTaskIds)
      ? step.childTaskIds.filter((item): item is string => typeof item === "string")
      : [],
  };
};

const sanitizeTask = (id: string, value: unknown): IsolatedTask | null => {
  if (!value || typeof value !== "object") return null;
  const task = value as Record<string, unknown>;
  if (
    typeof task.name !== "string" ||
    typeof task.parentWorkspacePath !== "string" ||
    typeof task.worktreePath !== "string" ||
    typeof task.baseCommit !== "string" ||
    typeof task.branch !== "string"
  ) return null;
  const nativeRef = task.nativeSessionRef as Record<string, unknown> | null;
  const previewPort = Number(task.previewPort);
  return {
    id,
    name: task.name,
    parentWorkspacePath: task.parentWorkspacePath,
    worktreePath: task.worktreePath,
    baseCommit: task.baseCommit,
    branch: task.branch,
    agentKind: task.agentKind === "claude" || task.agentKind === "codex" ? task.agentKind : null,
    agentTerminalId: typeof task.agentTerminalId === "string" ? task.agentTerminalId : null,
    nativeSessionRef:
      nativeRef &&
      typeof nativeRef.id === "string" &&
      nativeRef.transport === "agent-hook"
        ? { id: nativeRef.id, transport: "agent-hook" }
        : null,
    plan: Array.isArray(task.plan)
      ? task.plan.flatMap((step) => {
          const sanitized = sanitizePlanStep(step);
          return sanitized ? [sanitized] : [];
        })
      : [],
    previewPort: Number.isInteger(previewPort) && previewPort >= 1024 && previewPort <= 65535
      ? previewPort
      : 4100,
    bootstrapCommand: typeof task.bootstrapCommand === "string" ? task.bootstrapCommand : null,
    includeIgnored: Array.isArray(task.includeIgnored)
      ? task.includeIgnored.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: typeof task.createdAt === "number" && Number.isFinite(task.createdAt)
      ? task.createdAt
      : 0,
    updatedAt: typeof task.updatedAt === "number" && Number.isFinite(task.updatedAt)
      ? task.updatedAt
      : 0,
    outcome: TASK_OUTCOMES.includes(task.outcome as IsolatedTaskOutcome)
      ? task.outcome as IsolatedTaskOutcome
      : "archived",
    checkoutRemovedAt:
      typeof task.checkoutRemovedAt === "number" && Number.isFinite(task.checkoutRemovedAt)
        ? task.checkoutRemovedAt
        : null,
    cleanupProvenance: task.cleanupProvenance === "created-by-vibe"
      ? "created-by-vibe"
      : "opened-existing",
  };
};

const load = (): Record<string, IsolatedTask> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as
      | PersistedState
      | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.tasks ||
      typeof parsed.tasks !== "object" ||
      Array.isArray(parsed.tasks)
    ) return {};
    return Object.fromEntries(
      Object.entries(parsed.tasks)
        .flatMap(([id, task]) => {
          const sanitized = sanitizeTask(id, task);
          return sanitized ? [[id, sanitized] as const] : [];
        }),
    );
  } catch {
    return {};
  }
};

const save = (tasks: Record<string, IsolatedTask>): void =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks }));

export const useIsolatedTasksStore = create<IsolatedTasksState>((set) => ({
  tasks: load(),
  addTask: (task) => set((state) => ({ tasks: { ...state.tasks, [task.id]: task } })),
  patchTask: (id, patch) =>
    set((state) => {
      const task = state.tasks[id];
      if (!task) return state;
      return {
        tasks: {
          ...state.tasks,
          [id]: { ...task, ...patch, id, updatedAt: Date.now() },
        },
      };
    }),
  deleteTask: (id) =>
    set((state) => {
      if (!state.tasks[id]) return state;
      const tasks = { ...state.tasks };
      delete tasks[id];
      for (const [taskId, task] of Object.entries(tasks)) {
        const plan = task.plan.map((step) => ({
          ...step,
          childTaskIds: step.childTaskIds.filter((childId) => childId !== id),
        }));
        if (plan.some((step, index) => step.childTaskIds.length !== task.plan[index].childTaskIds.length)) {
          tasks[taskId] = { ...task, plan, updatedAt: Date.now() };
        }
      }
      return { tasks };
    }),
}));

useIsolatedTasksStore.subscribe((state, previous) => {
  if (state.tasks !== previous.tasks) save(state.tasks);
});

export const isolatedTaskForPath = (path: string): IsolatedTask | undefined =>
  Object.values(useIsolatedTasksStore.getState().tasks).find(
    (task) => task.worktreePath === path && task.outcome !== "discarded",
  );

export const tasksForParent = (path: string): IsolatedTask[] =>
  Object.values(useIsolatedTasksStore.getState().tasks)
    .filter((task) => task.parentWorkspacePath === path)
    .sort((a, b) => b.updatedAt - a.updatedAt);

export const getWorktreeRoot = (): string | null =>
  localStorage.getItem(ROOT_KEY)?.trim() || null;

export const setWorktreeRoot = (path: string | null): void => {
  if (path?.trim()) localStorage.setItem(ROOT_KEY, path.trim().replace(/\/$/, ""));
  else localStorage.removeItem(ROOT_KEY);
};
