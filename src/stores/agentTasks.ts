import { create } from "zustand";
import {
  gitReviewHead,
  gitReviewSnapshot,
  gitCheckpointSnapshot,
  onRepoChanged,
  type GitCheckpointSnapshot,
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
import { isolatedTaskForPath } from "./isolatedTasks";

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
  /** Stable isolated-checkout owner when this generation was launched there. */
  isolatedTaskId: string | null;
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
  /** Opaque per-path boundary captured when the current/last turn began. */
  turnBaseFileFingerprints: Record<string, string> | null;
  /** Unreachable Git tree captured immediately before the latest user turn. */
  turnBaseTree: string | null;
  /** Paths whose opaque hashes changed during the current/last turn. */
  latestTurnChangedFiles: string[];
  /** Evidence successfully opened for inspection, but not yet acknowledged. */
  reviewOpenedFingerprint: string | null;
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
  checkpointSequences.delete(terminalId);
  pendingTurnCheckpoints.delete(terminalId);
  pendingPromptTurns.delete(terminalId);
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
const checkpointSequences = new Map<string, number>();
/** App-owned prompts consume their captured boundary on the next Working edge. */
const pendingTurnCheckpoints = new Map<string, number>();
/** Input was committed while this lifecycle owned the prompt, but the agent
 * has not rendered evidence that it consumed the turn yet. This closes the
 * gap where a PTY write resolves before the first Working frame is parsed. */
const pendingPromptTurns = new Map<
  string,
  { generation: number; lifecycle: AgentRuntimeState["lifecycle"] }
>();

export const agentPromptTurnPending = (
  terminalId: string,
  generation: number,
): boolean => pendingPromptTurns.get(terminalId)?.generation === generation;

export function changedReviewPaths(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

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
  const latestTurnChangedFiles = task.turnBaseFileFingerprints
    ? changedReviewPaths(task.turnBaseFileFingerprints, snapshot.fileFingerprints)
    : task.latestTurnChangedFiles;
  const reviewState = reviewStateFor(candidate, snapshot);
  const meaningful = task.latestFingerprint !== snapshot.fingerprint || task.reviewState !== reviewState;
  return {
    ...candidate,
    latestTurnChangedFiles,
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
    isolatedTaskId: isolatedTaskForPath(meta.workspacePath)?.id ?? null,
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
    turnBaseFileFingerprints: null,
    turnBaseTree: null,
    latestTurnChangedFiles: [],
    reviewOpenedFingerprint: null,
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

const runtimeAcceptsPrompt = (
  runtime: AgentRuntimeState,
  allowWorking: boolean,
): boolean =>
  runtime.occupancy === "present" &&
  (runtime.lifecycle === "idle" ||
    (runtime.lifecycle === "blocked" && runtime.reason === "question") ||
    (allowWorking && runtime.lifecycle === "working"));

export interface PreparedAgentTurnCheckpoint {
  terminalId: string;
  generation: number;
  allowWorking: boolean;
  sequence: number;
  checkpoint: GitCheckpointSnapshot;
}

/** Prepare a turn boundary without publishing it. Queue cancellation can occur
 * while Git snapshots the checkout or an async dispatch guard runs; publishing
 * here would falsely attribute later changes to a prompt that was never sent. */
export async function prepareAgentTurnCheckpoint(
  terminalId: string,
  generation: number,
  allowWorking = false,
): Promise<PreparedAgentTurnCheckpoint> {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (!task || task.generation !== generation) {
    throw new Error("The task checkpoint owner is no longer available.");
  }
  if (!runtime || runtime.generation !== generation || !runtimeAcceptsPrompt(runtime, allowWorking)) {
    throw new Error("The terminal occupant changed or no longer owns an agent prompt.");
  }
  const sequence = (checkpointSequences.get(terminalId) ?? 0) + 1;
  checkpointSequences.set(terminalId, sequence);
  const checkpoint = await gitCheckpointSnapshot(
    task.workspacePath,
    task.baseHead,
    task.baseHead === null,
  );
  const latest = useAgentTasksStore.getState().tasks[terminalId];
  const latestRuntime = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !latest ||
    latest.generation !== generation ||
    !latestRuntime ||
    latestRuntime.generation !== generation ||
    !runtimeAcceptsPrompt(latestRuntime, allowWorking) ||
    checkpointSequences.get(terminalId) !== sequence
  ) {
    throw new Error("The terminal occupant changed while its checkpoint was being created.");
  }
  return { terminalId, generation, allowWorking, sequence, checkpoint };
}

/** Publish a prepared boundary synchronously at the prompt dispatch commit
 * point. The caller must invoke the PTY write without yielding afterward. */
export function commitAgentTurnCheckpoint(
  prepared: PreparedAgentTurnCheckpoint,
): void {
  const {
    terminalId,
    generation,
    allowWorking,
    sequence,
    checkpoint,
  } = prepared;
  const latest = useAgentTasksStore.getState().tasks[terminalId];
  const latestRuntime = useAgentRuntimeStore.getState().states[terminalId];
  if (
    !latest ||
    latest.generation !== generation ||
    !latestRuntime ||
    latestRuntime.generation !== generation ||
    !runtimeAcceptsPrompt(latestRuntime, allowWorking) ||
    checkpointSequences.get(terminalId) !== sequence
  ) {
    throw new Error("The terminal occupant changed before its prompt was dispatched.");
  }
  const refreshed = taskWithSnapshot(latest, checkpoint.snapshot);
  replaceTask({
    ...refreshed,
    turnBaseTree: checkpoint.tree,
    turnBaseFileFingerprints: checkpoint.snapshot.fileFingerprints,
    latestTurnChangedFiles: [],
  });
  if (latestRuntime.lifecycle === "working") {
    pendingTurnCheckpoints.delete(terminalId);
    pendingPromptTurns.delete(terminalId);
  } else {
    pendingTurnCheckpoints.set(terminalId, generation);
    pendingPromptTurns.set(terminalId, {
      generation,
      lifecycle: latestRuntime.lifecycle,
    });
  }
}

/** Capture and immediately publish a physical user-submit boundary. */
export async function captureAgentTurnCheckpoint(
  terminalId: string,
  generation: number,
  allowWorking = false,
): Promise<void> {
  const prepared = await prepareAgentTurnCheckpoint(terminalId, generation, allowWorking);
  commitAgentTurnCheckpoint(prepared);
}

/** A physical Enter is also used for permission UIs and shell interaction.
 * Checkpoint only when semantic state proves that Enter submits a new turn. */
export async function checkpointAgentUserSubmit(terminalId: string): Promise<void> {
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  if (!runtime || !runtimeAcceptsPrompt(runtime, false)) return;
  await captureAgentTurnCheckpoint(terminalId, runtime.generation);
}

export function markAgentTaskFeedback(
  terminalId: string,
  expectedGeneration: number,
  expectedFingerprint: string,
): boolean {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (
    !task?.latestFingerprint ||
    task.generation !== expectedGeneration ||
    task.latestFingerprint !== expectedFingerprint
  ) return false;
  replaceTask({
    ...task,
    reviewOpenedFingerprint: null,
    reviewedFingerprint: null,
    feedbackFingerprint: expectedFingerprint,
    acceptedFingerprint: null,
    reviewState: "feedback",
    updatedAt: Date.now(),
    attentionSince: Date.now(),
  });
  return true;
}

export function markAgentTaskReviewOpened(
  terminalId: string,
  expectedGeneration: number,
  expectedFingerprint: string,
): boolean {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (
    !task?.latestFingerprint ||
    task.generation !== expectedGeneration ||
    task.latestFingerprint !== expectedFingerprint
  ) return false;
  replaceTask({
    ...task,
    reviewOpenedFingerprint: expectedFingerprint,
  });
  return true;
}

/** Mark only the evidence the user actually opened. Navigation can await
 * workspace/repository work, so a newer generation or fingerprint must not be
 * acknowledged by a stale completion. */
export function markAgentTaskReviewed(
  terminalId: string,
  expectedGeneration: number,
  expectedFingerprint: string,
): boolean {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (
    !task?.latestFingerprint ||
    task.generation !== expectedGeneration ||
    task.latestFingerprint !== expectedFingerprint ||
    task.reviewOpenedFingerprint !== expectedFingerprint
  ) return false;
  replaceTask({
    ...task,
    reviewedFingerprint: task.latestFingerprint,
    reviewState: "reviewed",
    updatedAt: Date.now(),
    attentionSince: Date.now(),
  });
  return true;
}

export function acceptAgentTask(
  terminalId: string,
  expectedGeneration: number,
  expectedFingerprint: string,
): boolean {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (
    !task?.latestFingerprint ||
    task.generation !== expectedGeneration ||
    task.latestFingerprint !== expectedFingerprint ||
    task.reviewedFingerprint !== expectedFingerprint
  ) return false;
  replaceTask({
    ...task,
    acceptedFingerprint: expectedFingerprint,
    reviewState: "accepted",
    updatedAt: Date.now(),
    attentionSince: Date.now(),
  });
  void refreshAgentTask(terminalId);
  return true;
}

export function beginCheckRun(terminalId: string, generation: number, run: CheckRun): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task || task.generation !== generation) return;
  replaceTask({ ...task, checkRuns: [...task.checkRuns, run].slice(-20), updatedAt: Date.now() });
}

export function updateCheckRun(terminalId: string, generation: number, run: CheckRun): void {
  const task = useAgentTasksStore.getState().tasks[terminalId];
  if (!task || task.generation !== generation) return;
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
    if (pendingTurnCheckpoints.get(current.terminalId) !== current.generation) {
      pendingTurnCheckpoints.delete(current.terminalId);
    }
    if (pendingPromptTurns.get(current.terminalId)?.generation !== current.generation) {
      pendingPromptTurns.delete(current.terminalId);
    }
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
  const pendingPrompt = pendingPromptTurns.get(current.terminalId);
  if (
    pendingPrompt?.generation === current.generation &&
    pendingPrompt.lifecycle !== current.lifecycle
  ) {
    pendingPromptTurns.delete(current.terminalId);
  }
  if (previous?.lifecycle !== "working" && current.lifecycle === "working") {
    const task = useAgentTasksStore.getState().tasks[current.terminalId];
    if (task) {
      if (pendingTurnCheckpoints.get(current.terminalId) === current.generation) {
        pendingTurnCheckpoints.delete(current.terminalId);
        return;
      }
      replaceTask({
        ...task,
        turnBaseFileFingerprints: task.latestSnapshot?.fileFingerprints ?? {},
        turnBaseTree: null,
        latestTurnChangedFiles: [],
      });
    }
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
