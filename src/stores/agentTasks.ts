import { create } from "zustand";
import {
  gitReviewHead,
  gitReviewSnapshot,
  onRepoChanged,
  type GitReviewSnapshot,
} from "../lib/ipc";
import {
  displayAgentState,
  type AgentKind,
  type AgentRuntimeState,
} from "../lib/agentState";
import { projectDisplayName } from "../lib/projectNames";
import {
  subscribeAgentTransitions,
  useAgentRuntimeStore,
} from "./agentRuntime";

export type ReviewState =
  | "clean"
  | "unreviewed"
  | "reviewed"
  | "feedback"
  | "stale"
  | "accepted";

export type CheckState =
  | "not_run"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "stale";

export type CheckNodeStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface CheckNodeRun {
  label: string;
  status: CheckNodeStatus;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  terminalId: string | null;
  exitCode: number | null;
}

export interface CheckRun {
  id: string;
  pipelineLabel: string;
  source: "manual" | "auto";
  status: "running" | "passed" | "failed" | "cancelled" | "invalidated";
  startedAt: number;
  finishedAt: number | null;
  fingerprint: string | null;
  nodes: CheckNodeRun[];
}

export interface AgentTask {
  terminalId: string;
  generation: number;
  workspacePath: string;
  scope: "global" | "workspace";
  kind: AgentKind;
  createdAt: number;
  /** Last meaningful task/review transition (not a no-op evidence refresh). */
  updatedAt: number;
  lastRefreshedAt: number | null;
  attentionSince: number;
  baseHead: string | null;
  baseHeadCaptured: boolean;
  baseline: "capturing" | "ready" | "failed";
  baselineCapturedLate: boolean;
  baselineError: string | null;
  reviewState: ReviewState;
  selectedPipeline: string | null;
  autoRun: boolean;
  latestSnapshot: GitReviewSnapshot | null;
  latestFingerprint: string | null;
  reviewedFingerprint: string | null;
  feedbackFingerprint: string | null;
  acceptedFingerprint: string | null;
  checkRuns: CheckRun[];
}

interface AgentTasksState {
  tasks: Record<string, AgentTask>;
}

export const useAgentTasksStore = create<AgentTasksState>(() => ({ tasks: {} }));

const replaceTask = (task: AgentTask): void =>
  useAgentTasksStore.setState((state) => ({
    tasks: { ...state.tasks, [task.terminalId]: task },
  }));

export function removeAgentTask(terminalId: string): void {
  refreshSequences.delete(terminalId);
  useAgentTasksStore.setState((state) => {
    if (!state.tasks[terminalId]) return state;
    const tasks = { ...state.tasks };
    delete tasks[terminalId];
    return { tasks };
  });
}

export function reviewStateFor(
  task: AgentTask,
  snapshot: GitReviewSnapshot,
): ReviewState {
  if (snapshot.changedFiles.length === 0) return "clean";
  const fingerprint = snapshot.fingerprint;
  if (task.acceptedFingerprint === fingerprint) return "accepted";
  if (task.feedbackFingerprint === fingerprint) return "feedback";
  if (task.reviewedFingerprint === fingerprint) return "reviewed";
  if (task.acceptedFingerprint) return "stale";
  return "unreviewed";
}

/** Latest evidence for the selected check pipeline, kept independent from the
 * human review decision. Repository changes make completed evidence stale. */
export function checkStateFor(task: AgentTask): CheckState {
  if (!task.selectedPipeline) return "not_run";
  const run = [...task.checkRuns]
    .reverse()
    .find((candidate) => candidate.pipelineLabel === task.selectedPipeline);
  if (!run) return "not_run";
  if (run.status === "running") return "running";
  if (
    run.fingerprint &&
    task.latestFingerprint &&
    run.fingerprint !== task.latestFingerprint
  ) return "stale";
  if (run.status === "passed") return "passed";
  if (run.status === "failed" || run.status === "invalidated") return "failed";
  return "cancelled";
}

const snapshotRequests = new Map<string, Promise<GitReviewSnapshot>>();
const refreshSequences = new Map<string, number>();

function sharedSnapshot(
  workspacePath: string,
  baseHead: string | null,
  baseUnborn: boolean,
): Promise<GitReviewSnapshot> {
  const key = `${workspacePath}\0${baseUnborn ? "unborn" : (baseHead ?? "none")}`;
  const active = snapshotRequests.get(key);
  if (active) return active;
  const request = gitReviewSnapshot(workspacePath, baseHead, baseUnborn);
  snapshotRequests.set(key, request);
  void request.finally(() => {
    if (snapshotRequests.get(key) === request) snapshotRequests.delete(key);
  }).catch(() => {});
  return request;
}

function taskWithSnapshot(task: AgentTask, snapshot: GitReviewSnapshot): AgentTask {
  const now = Date.now();
  const candidate = {
    ...task,
    latestSnapshot: snapshot,
    latestFingerprint: snapshot.fingerprint,
    lastRefreshedAt: now,
  };
  const reviewState = reviewStateFor(candidate, snapshot);
  const meaningful = task.latestFingerprint !== snapshot.fingerprint || task.reviewState !== reviewState;
  return {
    ...candidate,
    reviewState,
    updatedAt: meaningful ? now : task.updatedAt,
    attentionSince: meaningful ? now : task.attentionSince,
  };
}

async function captureBaseline(terminalId: string, generation: number): Promise<void> {
  const current = useAgentTasksStore.getState().tasks[terminalId];
  if (!current || current.generation !== generation || !current.baseHeadCaptured) return;
  try {
    const snapshot = await sharedSnapshot(
      current.workspacePath,
      current.baseHead,
      current.baseHead === null,
    );
    const latest = useAgentTasksStore.getState().tasks[terminalId];
    if (!latest || latest.generation !== generation) return;
    const next = taskWithSnapshot({
      ...latest,
      baseline: "ready",
      baselineError: null,
    }, snapshot);
    replaceTask(next);
  } catch (error) {
    const latest = useAgentTasksStore.getState().tasks[terminalId];
    if (!latest || latest.generation !== generation) return;
    replaceTask({
      ...latest,
      baseline: "failed",
      baselineError: String(error),
      reviewState: "unreviewed",
      updatedAt: Date.now(),
    });
  }
}

export function createAgentTask(meta: {
  terminalId: string;
  generation: number;
  workspacePath: string;
  scope: "global" | "workspace";
  kind: AgentKind;
  baselineCapturedLate?: boolean;
}): Promise<void> {
  const now = Date.now();
  const task: AgentTask = {
    ...meta,
    createdAt: now,
    updatedAt: now,
    lastRefreshedAt: null,
    attentionSince: now,
    baseHead: null,
    baseHeadCaptured: false,
    baseline: "capturing",
    baselineCapturedLate: meta.baselineCapturedLate ?? false,
    baselineError: null,
    reviewState: "clean",
    selectedPipeline: null,
    autoRun: false,
    latestSnapshot: null,
    latestFingerprint: null,
    reviewedFingerprint: null,
    feedbackFingerprint: null,
    acceptedFingerprint: null,
    checkRuns: [],
  };
  replaceTask(task);
  ensureRepoListener();
  // App-owned launches await only this cheap boundary. The expensive content
  // digest continues asynchronously and never delays typing the agent command.
  return gitReviewHead(meta.workspacePath).then((baseHead) => {
    const latest = useAgentTasksStore.getState().tasks[meta.terminalId];
    if (!latest || latest.generation !== meta.generation) return;
    replaceTask({ ...latest, baseHead, baseHeadCaptured: true, baselineError: null });
    void captureBaseline(meta.terminalId, meta.generation);
  }, (error) => {
    const latest = useAgentTasksStore.getState().tasks[meta.terminalId];
    if (!latest || latest.generation !== meta.generation) return;
    replaceTask({
      ...latest,
      baseline: "failed",
      baselineError: String(error),
      reviewState: "unreviewed",
      updatedAt: Date.now(),
      attentionSince: Date.now(),
    });
  });
}

export async function retryAgentTaskBaseline(terminalId: string): Promise<void> {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task) return;
  replaceTask({ ...task, baseline: "capturing", baselineError: null });
  if (!task.baseHeadCaptured) {
    try {
      const baseHead = await gitReviewHead(task.workspacePath);
      const latest = useAgentTasksStore.getState().tasks[terminalId];
      if (!latest || latest.generation !== task.generation) return;
      replaceTask({
        ...latest,
        baseHead,
        baseHeadCaptured: true,
        baselineCapturedLate: true,
      });
    } catch (error) {
      const latest = useAgentTasksStore.getState().tasks[terminalId];
      if (latest?.generation === task.generation) {
        replaceTask({ ...latest, baseline: "failed", baselineError: String(error) });
      }
      return;
    }
  }
  await captureBaseline(terminalId, task.generation);
}

export async function refreshAgentTask(terminalId: string): Promise<void> {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task || task.baseline !== "ready") return;
  const sequence = (refreshSequences.get(terminalId) ?? 0) + 1;
  refreshSequences.set(terminalId, sequence);
  try {
    const snapshot = await sharedSnapshot(task.workspacePath, task.baseHead, task.baseHead === null);
    const latest = useAgentTasksStore.getState().tasks[terminalId];
    if (
      !latest ||
      latest.generation !== task.generation ||
      refreshSequences.get(terminalId) !== sequence
    ) return;
    replaceTask(taskWithSnapshot(latest, snapshot));
  } catch (error) {
    const latest = useAgentTasksStore.getState().tasks[terminalId];
    if (
      latest?.generation === task.generation &&
      refreshSequences.get(terminalId) === sequence
    ) {
      replaceTask({ ...latest, baselineError: String(error), lastRefreshedAt: Date.now() });
    }
  }
}

export const refreshTasksForWorkspace = (workspacePath: string): void => {
  for (const task of Object.values(useAgentTasksStore.getState().tasks)) {
    if (task.workspacePath === workspacePath) void refreshAgentTask(task.terminalId);
  }
};

export function setAgentTaskPipeline(terminalId: string, label: string | null): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task) return;
  replaceTask({ ...task, selectedPipeline: label, updatedAt: Date.now() });
}

export function setAgentTaskAutoRun(terminalId: string, enabled: boolean): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (task) replaceTask({ ...task, autoRun: enabled, updatedAt: Date.now() });
}

export function markAgentTaskFeedback(terminalId: string): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task?.latestFingerprint) return;
  replaceTask({
    ...task,
    reviewedFingerprint: null,
    feedbackFingerprint: task.latestFingerprint,
    acceptedFingerprint: null,
    reviewState: "feedback",
    updatedAt: Date.now(),
    attentionSince: Date.now(),
  });
}

export function markAgentTaskReviewed(terminalId: string): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task?.latestFingerprint) return;
  replaceTask({
    ...task,
    reviewedFingerprint: task.latestFingerprint,
    reviewState: "reviewed",
    updatedAt: Date.now(),
    attentionSince: Date.now(),
  });
}

export function acceptAgentTask(terminalId: string): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (
    !task?.latestFingerprint ||
    task.reviewedFingerprint !== task.latestFingerprint
  ) return;
  replaceTask({
    ...task,
    acceptedFingerprint: task.latestFingerprint,
    reviewState: "accepted",
    updatedAt: Date.now(),
    attentionSince: Date.now(),
  });
  void refreshAgentTask(terminalId);
}

export function beginCheckRun(terminalId: string, run: CheckRun): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task) return;
  replaceTask({ ...task, checkRuns: [...task.checkRuns, run].slice(-20), updatedAt: Date.now() });
}

export function updateCheckRun(terminalId: string, run: CheckRun): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task) return;
  const checkRuns = task.checkRuns.map((item) => item.id === run.id ? run : item).slice(-20);
  replaceTask({ ...task, checkRuns, updatedAt: Date.now() });
}

let repoListenerStarted = false;
function ensureRepoListener(): void {
  if (repoListenerStarted || typeof window === "undefined") return;
  repoListenerStarted = true;
  void onRepoChanged((change) => refreshTasksForWorkspace(change.repoPath)).catch(() => {
    repoListenerStarted = false;
  });
}

// A detected generation with no matching launch-owned task is a manually
// typed relaunch. Its first process detection becomes the necessarily-late
// baseline boundary. Turn completion refreshes evidence independently of
// the unseen Done projection.
export function reconcileDetectedAgentTasks(): void {
  for (const runtime of Object.values(useAgentRuntimeStore.getState().states)) {
    if (runtime.occupancy !== "present") continue;
    const task = useAgentTasksStore.getState().tasks[runtime.terminalId];
    if (task?.generation === runtime.generation) continue;
    void createAgentTask({
      terminalId: runtime.terminalId,
      generation: runtime.generation,
      workspacePath: runtime.workspacePath,
      scope: runtime.scope,
      kind: runtime.kind,
      baselineCapturedLate: true,
    });
  }
}

subscribeAgentTransitions(({ previous, current }) => {
  if (!current) return;
  if (current.occupancy === "present" && previous?.generation !== current.generation) {
    const task = useAgentTasksStore.getState().tasks[current.terminalId];
    if (!task || task.generation !== current.generation) {
      void createAgentTask({
        terminalId: current.terminalId,
        generation: current.generation,
        workspacePath: current.workspacePath,
        scope: current.scope,
        kind: current.kind,
        baselineCapturedLate: true,
      });
    } else {
      void refreshAgentTask(current.terminalId);
    }
  }
  if (previous?.lifecycle === "working" && current.lifecycle === "idle") {
    void refreshAgentTask(current.terminalId);
  }
});

// Runtime state can outlive this session-only store during frontend hot reload.
// Rebuild missing review ownership immediately instead of hiding the inbox's
// review/check controls until the agent happens to transition again.
reconcileDetectedAgentTasks();

export interface AgentInboxItem {
  runtime: AgentRuntimeState;
  task?: AgentTask;
  title: string;
  project: string;
  topic: string;
}

export function inboxTier(item: AgentInboxItem): number {
  const display = displayAgentState(item.runtime);
  if (display === "blocked") return 1;
  if (display === "working" || display === "starting") return 4;
  const reviewable = display === "idle" || display === "done" || display === "absent";
  if (!reviewable) return 5;
  if (
    item.task?.latestSnapshot?.conflictedFiles.length ||
    (item.task && checkStateFor(item.task) === "failed")
  ) return 2;
  if (
    display === "done" ||
    item.task?.reviewState === "unreviewed" ||
    item.task?.reviewState === "reviewed" ||
    item.task?.reviewState === "stale"
  ) return 3;
  return 5;
}

export const isInboxActionable = (item: AgentInboxItem): boolean => inboxTier(item) <= 3;

export const inboxWaitingAt = (item: AgentInboxItem): number => {
  const tier = inboxTier(item);
  if (tier === 1 || (tier === 3 && displayAgentState(item.runtime) === "done")) {
    return item.runtime.changedAt;
  }
  return tier === 2 || tier === 3
    ? (item.task?.attentionSince ?? item.runtime.changedAt)
    : item.runtime.changedAt;
};

export function sortInboxItems(items: AgentInboxItem[]): AgentInboxItem[] {
  return [...items].sort((a, b) =>
    inboxTier(a) - inboxTier(b) ||
    inboxWaitingAt(a) - inboxWaitingAt(b) ||
    projectDisplayName(a.runtime.workspacePath).localeCompare(projectDisplayName(b.runtime.workspacePath)) ||
    a.title.localeCompare(b.title) ||
    a.runtime.terminalId.localeCompare(b.runtime.terminalId),
  );
}

export function nextActionableId(
  items: AgentInboxItem[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  const actionable = sortInboxItems(items).filter(isInboxActionable);
  if (!actionable.length) return null;
  const index = actionable.findIndex((item) => item.runtime.terminalId === currentId);
  if (index < 0) return actionable[direction === 1 ? 0 : actionable.length - 1].runtime.terminalId;
  return actionable[(index + direction + actionable.length) % actionable.length].runtime.terminalId;
}

export const currentRuntime = (terminalId: string) =>
  useAgentRuntimeStore.getState().states[terminalId];
