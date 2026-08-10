import { groupOf } from "./dockTree";
import { gitReviewSnapshot } from "./ipc";
import { notifyAgentAttention } from "./agentNotifications";
import { getSession } from "./termSessions";
import { getOrCreateWorkspaceSession } from "./workspaceSessions";
import {
  loadTaskDocument,
  shellCommandLine,
} from "./tasks";
import { fingerprintDecision, validatePipeline } from "./pipelineModel";
export { selectablePipelineRoots, validatePipeline } from "./pipelineModel";
import {
  beginCheckRun,
  refreshAgentTask,
  updateCheckRun,
  useAgentTasksStore,
  type CheckNodeRun,
  type CheckRun,
} from "../stores/agentTasks";
import { subscribeAgentTransitions } from "../stores/agentRuntime";
import { useWorkspacesStore, type Workspace } from "../stores/workspaces";
import { useUiStore } from "../stores/ui";

const leases = new Map<string, string>();

function leaseTerminal(ws: Workspace, label: string, runId: string): string {
  // Check panes remain inspectable after a run, so a user may type into one.
  // Never inject a later check into a session whose prompt ownership is no
  // longer app-controlled; every node invocation gets a fresh reserved pane.
  const id = ws.terminal.getState().newTerminal(`Check: ${label}`);
  leases.set(id, runId);
  return id;
}

const releaseTerminal = (id: string, runId: string): void => {
  if (leases.get(id) === runId) leases.delete(id);
};

const running = new Map<string, Promise<CheckRun>>();
const followup = new Map<string, { rootLabel: string; source: "auto" }>();

const trustRecord = (): Record<string, true> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("vibe-studio:auto-check-trust") ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, true] => entry[1] === true),
    );
  } catch {
    return {};
  }
};

export const isAutoCheckTrusted = (workspacePath: string): boolean => {
  return trustRecord()[workspacePath] === true;
};

export const setAutoCheckTrusted = (workspacePath: string, trusted: boolean): void => {
  const value = trustRecord();
  if (trusted) value[workspacePath] = true;
  else delete value[workspacePath];
  localStorage.setItem("vibe-studio:auto-check-trust", JSON.stringify(value));
};

function patchNode(run: CheckRun, label: string, patch: Partial<CheckNodeRun>): CheckRun {
  return { ...run, nodes: run.nodes.map((node) => node.label === label ? { ...node, ...patch } : node) };
}

async function executePipeline(
  terminalId: string,
  rootLabel: string,
  source: "manual" | "auto",
): Promise<CheckRun> {
  const owner = useAgentTasksStore.getState().tasks[terminalId];
  if (!owner) throw new Error("Agent task is no longer available");
  const ws = useWorkspacesStore.getState().workspaces.find((item) => item.path === owner.workspacePath);
  if (!ws) throw new Error("Open the owning project before running checks");
  if (source === "auto" && !isAutoCheckTrusted(owner.workspacePath)) {
    throw new Error("Automatic checks are not approved for this project");
  }
  await refreshAgentTask(terminalId);
  const refreshedOwner = useAgentTasksStore.getState().tasks[terminalId];
  if (!refreshedOwner || refreshedOwner.generation !== owner.generation || refreshedOwner.baseline !== "ready") {
    throw new Error("A proven review baseline is required before running checks");
  }
  const document = await loadTaskDocument(owner.workspacePath);
  const validation = validatePipeline(document, rootLabel);
  if (!validation.root || validation.errors.length) throw new Error(validation.errors.join("\n"));

  const runId = crypto.randomUUID();
  let run: CheckRun = {
    id: runId,
    pipelineLabel: rootLabel,
    source,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    fingerprint: null,
    nodes: validation.nodes.map((task) => ({
      label: task.label,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      terminalId: null,
      exitCode: null,
    })),
  };
  const publish = () => updateCheckRun(terminalId, run);
  beginCheckRun(terminalId, run);
  const byLabel = new Map(validation.nodes.map((task) => [task.label, task]));
  const promises = new Map<string, Promise<CheckNodeRun["status"]>>();

  const executeNode = (label: string): Promise<CheckNodeRun["status"]> => {
    const existing = promises.get(label);
    if (existing) return existing;
    const promise = (async () => {
      const task = byLabel.get(label)!;
      let dependencyStates: CheckNodeRun["status"][];
      if (task.dependsOrder === "sequence") {
        dependencyStates = [];
        for (const dependency of task.dependsOn) dependencyStates.push(await executeNode(dependency));
      } else {
        dependencyStates = await Promise.all(task.dependsOn.map(executeNode));
      }
      if (dependencyStates.some((status) => status !== "passed")) {
        const finishedAt = Date.now();
        run = patchNode(run, label, { status: "skipped", finishedAt, durationMs: 0 });
        publish();
        return "skipped";
      }
      if (!task.command) {
        const now = Date.now();
        run = patchNode(run, label, { status: "passed", startedAt: now, finishedAt: now, durationMs: 0 });
        publish();
        return "passed";
      }
      const nodeTerminalId = leaseTerminal(ws, label, runId);
      const startedAt = Date.now();
      run = patchNode(run, label, { status: "running", terminalId: nodeTerminalId, startedAt });
      publish();
      try {
        const session = getOrCreateWorkspaceSession(ws, nodeTerminalId);
        const result = await session.runTrackedCommand(shellCommandLine(task, ws), runId);
        const finishedAt = Date.now();
        const status = result.status === "cancelled" ? "cancelled" : result.exitCode === 0 ? "passed" : "failed";
        run = patchNode(run, label, {
          status,
          finishedAt,
          durationMs: finishedAt - startedAt,
          exitCode: result.status === "exited" ? result.exitCode : null,
        });
        publish();
        return status;
      } finally {
        releaseTerminal(nodeTerminalId, runId);
      }
    })();
    promises.set(label, promise);
    return promise;
  };

  const passStatus = (): CheckRun["status"] => {
    const statuses = run.nodes.map((node) => node.status);
    return statuses.includes("failed") || statuses.includes("skipped")
      ? "failed"
      : statuses.includes("cancelled")
        ? "cancelled"
        : "passed";
  };
  const resetPass = () => {
    promises.clear();
    run = {
      ...run,
      nodes: run.nodes.map((node) => ({
        ...node,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        terminalId: null,
        exitCode: null,
      })),
    };
    publish();
  };

  try {
    let before = await gitReviewSnapshot(
      owner.workspacePath,
      refreshedOwner.baseHead,
      refreshedOwner.baseHead === null,
    );
    await executeNode(validation.root.label);
    let status = passStatus();
    let after = await gitReviewSnapshot(
      owner.workspacePath,
      refreshedOwner.baseHead,
      refreshedOwner.baseHead === null,
    );
    if (fingerprintDecision(1, status, before.fingerprint, after.fingerprint) === "rerun") {
      // A formatter or another process changed the tree during the pass. Run
      // the complete DAG once more against that resulting tree; a second
      // mutation invalidates the evidence instead of certifying untested work.
      before = after;
      resetPass();
      await executeNode(validation.root.label);
      status = passStatus();
      after = await gitReviewSnapshot(
        owner.workspacePath,
        refreshedOwner.baseHead,
        refreshedOwner.baseHead === null,
      );
      if (fingerprintDecision(2, status, before.fingerprint, after.fingerprint) === "invalidated") {
        status = "invalidated";
      }
    }
    run = {
      ...run,
      status,
      finishedAt: Date.now(),
      fingerprint: after.fingerprint,
    };
  } catch (error) {
    run = { ...run, status: "invalidated", finishedAt: Date.now(), fingerprint: null };
    throw error;
  } finally {
    updateCheckRun(terminalId, run);
    await refreshAgentTask(terminalId);
  }
  if (source === "auto" && (run.status === "failed" || run.status === "invalidated")) {
    notifyAgentAttention(terminalId, "checks_failed");
  }
  return run;
}

export function runAgentTaskPipeline(
  terminalId: string,
  rootLabel: string,
  source: "manual" | "auto" = "manual",
): Promise<CheckRun> {
  const active = running.get(terminalId);
  if (active) {
    // Manual double-clicks are one authorization, not a request to queue a
    // second run. Autorun events coalesce to the latest selected root.
    if (source === "auto") followup.set(terminalId, { rootLabel, source });
    return active;
  }
  const promise = executePipeline(terminalId, rootLabel, source);
  running.set(terminalId, promise);
  void promise.finally(() => {
    if (running.get(terminalId) !== promise) return;
    running.delete(terminalId);
    const queued = followup.get(terminalId);
    if (queued) {
      followup.delete(terminalId);
      void runAgentTaskPipeline(terminalId, queued.rootLabel, queued.source).catch(() => {});
    }
  }).catch(() => {});
  return promise;
}

export function focusCheckNode(terminalId: string): void {
  const { workspaces } = useWorkspacesStore.getState();
  const ws = workspaces.find((item) => item.terminal.getState().terminals[terminalId]);
  if (!ws) return;
  useWorkspacesStore.getState().setActive(ws.path);
  const group = groupOf(ws.terminal.getState().root, terminalId);
  if (group) ws.terminal.getState().setActiveTerminal(group.id, terminalId);
  useUiStore.getState().setPanelGroup("terminal");
  window.setTimeout(() => {
    getSession(terminalId)?.focus();
  }, 0);
}

subscribeAgentTransitions(({ previous, current }) => {
  if (!current || previous?.lifecycle !== "working" || current.lifecycle !== "idle") return;
  window.setTimeout(async () => {
    await refreshAgentTask(current.terminalId);
    const task = useAgentTasksStore.getState().tasks[current.terminalId];
    if (
      task?.autoRun &&
      task.selectedPipeline &&
      task.latestSnapshot?.changedFiles.length &&
      isAutoCheckTrusted(task.workspacePath)
    ) {
      void runAgentTaskPipeline(current.terminalId, task.selectedPipeline, "auto").catch(() => {});
    }
  }, 0);
});
