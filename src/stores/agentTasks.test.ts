import { describe, expect, it } from "vitest";
import type { GitReviewSnapshot } from "../lib/ipc";
import type { AgentRuntimeState } from "../lib/agentState";
import {
  acceptAgentTask,
  beginCheckRun,
  checkStateFor,
  changedReviewPaths,
  inboxTier,
  isInboxActionable,
  markAgentTaskFeedback,
  markAgentTaskReviewed,
  markAgentTaskReviewOpened,
  nextActionableId,
  reviewStateFor,
  sortInboxItems,
  updateCheckRun,
  useAgentTasksStore,
  type CheckRun,
  type AgentInboxItem,
  type AgentTask,
} from "./agentTasks";

const runtime = (id: string, lifecycle: AgentRuntimeState["lifecycle"], seen = true, changedAt = 10): AgentRuntimeState => ({
  terminalId: id,
  workspacePath: `/repo/${id}`,
  scope: id.startsWith("g") ? "global" : "workspace",
  kind: "claude",
  occupancy: "present",
  generation: 1,
  lifecycle,
  seen,
  changedAt,
});

const task = (state: AgentTask["reviewState"], updatedAt = 10): AgentTask => ({
  terminalId: "t",
  generation: 1,
  workspacePath: "/repo/t",
  scope: "workspace",
  kind: "claude",
  isolatedTaskId: null,
  createdAt: 1,
  updatedAt,
  lastRefreshedAt: null,
  attentionSince: updatedAt,
  baseHead: "base",
  baseHeadCaptured: true,
  baseline: "ready",
  baselineCapturedLate: false,
  baselineError: null,
  reviewState: state,
  selectedPipeline: "test",
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
});

const item = (id: string, lifecycle: AgentRuntimeState["lifecycle"], review?: AgentTask["reviewState"], seen = true, changedAt = 10): AgentInboxItem => ({
  runtime: runtime(id, lifecycle, seen, changedAt),
  task: review ? { ...task(review, changedAt), terminalId: id, workspacePath: `/repo/${id}` } : undefined,
  title: id,
  project: id,
  topic: "",
});

const snapshot = (patch: Partial<GitReviewSnapshot> = {}): GitReviewSnapshot => ({
  head: "head",
  baseAncestry: "same",
  changedFiles: ["a.ts"],
  conflictedFiles: [],
  fileFingerprints: { "a.ts": "file-fp" },
  fingerprint: "fp",
  ...patch,
});

describe("agent review state", () => {
  it("pins check evidence to the terminal occupant generation", () => {
    useAgentTasksStore.setState({ tasks: { t: task("unreviewed") } });
    const run: CheckRun = {
      id: "run",
      pipelineLabel: "test",
      source: "manual",
      status: "running",
      startedAt: 1,
      finishedAt: null,
      fingerprint: null,
      nodes: [],
    };
    beginCheckRun("t", 2, run);
    expect(useAgentTasksStore.getState().tasks.t.checkRuns).toEqual([]);
    beginCheckRun("t", 1, run);
    updateCheckRun("t", 2, { ...run, status: "failed" });
    expect(useAgentTasksStore.getState().tasks.t.checkRuns[0].status).toBe("running");
    useAgentTasksStore.setState({ tasks: {} });
  });

  it("derives latest-turn paths from opaque per-file fingerprints", () => {
    expect(changedReviewPaths(
      { "same.ts": "1", "edited.ts": "before", "removed.ts": "old" },
      { "same.ts": "1", "edited.ts": "after", "added.ts": "new" },
    )).toEqual(["added.ts", "edited.ts", "removed.ts"]);
  });

  it("tracks human decisions by fingerprint and marks changed approvals stale", () => {
    const base = task("unreviewed");
    expect(reviewStateFor(base, snapshot({ changedFiles: [] }))).toBe("clean");
    expect(reviewStateFor({ ...base, feedbackFingerprint: "fp" }, snapshot())).toBe("feedback");
    expect(reviewStateFor({ ...base, feedbackFingerprint: "old" }, snapshot())).toBe("unreviewed");
    expect(reviewStateFor({ ...base, reviewedFingerprint: "fp" }, snapshot())).toBe("reviewed");
    expect(reviewStateFor({ ...base, acceptedFingerprint: "fp" }, snapshot())).toBe("accepted");
    expect(reviewStateFor({ ...base, acceptedFingerprint: "old" }, snapshot())).toBe("stale");
    expect(reviewStateFor({ ...base, acceptedFingerprint: "old", reviewedFingerprint: "fp" }, snapshot())).toBe("reviewed");
  });

  it("marks reviewed evidence only when generation and fingerprint still match", () => {
    useAgentTasksStore.setState({
      tasks: {
        t: { ...task("unreviewed"), latestFingerprint: "current" },
      },
    });
    expect(markAgentTaskReviewed("t", 2, "current")).toBe(false);
    expect(markAgentTaskReviewed("t", 1, "old")).toBe(false);
    expect(markAgentTaskReviewed("t", 1, "current")).toBe(false);
    expect(useAgentTasksStore.getState().tasks.t.reviewedFingerprint).toBeNull();
    expect(markAgentTaskReviewOpened("t", 1, "current")).toBe(true);
    expect(markAgentTaskReviewed("t", 1, "current")).toBe(true);
    expect(useAgentTasksStore.getState().tasks.t.reviewedFingerprint).toBe("current");
    useAgentTasksStore.setState({ tasks: {} });
  });

  it("marks feedback only for the selected generation and fingerprint", () => {
    useAgentTasksStore.setState({
      tasks: {
        t: { ...task("unreviewed"), latestFingerprint: "current" },
      },
    });
    expect(markAgentTaskFeedback("t", 2, "current")).toBe(false);
    expect(markAgentTaskFeedback("t", 1, "old")).toBe(false);
    expect(useAgentTasksStore.getState().tasks.t.feedbackFingerprint).toBeNull();
    expect(markAgentTaskFeedback("t", 1, "current")).toBe(true);
    expect(useAgentTasksStore.getState().tasks.t.feedbackFingerprint).toBe("current");
    useAgentTasksStore.setState({ tasks: {} });
  });

  it("accepts only the reviewed generation and fingerprint rendered by the action", () => {
    useAgentTasksStore.setState({
      tasks: {
        t: {
          ...task("reviewed"),
          latestFingerprint: "current",
          reviewedFingerprint: "current",
        },
      },
    });
    expect(acceptAgentTask("t", 2, "current")).toBe(false);
    expect(acceptAgentTask("t", 1, "old")).toBe(false);
    expect(useAgentTasksStore.getState().tasks.t.acceptedFingerprint).toBeNull();
    expect(acceptAgentTask("t", 1, "current")).toBe(true);
    expect(useAgentTasksStore.getState().tasks.t.acceptedFingerprint).toBe("current");
    useAgentTasksStore.setState({ tasks: {} });
  });

  it("keeps check results independent and marks old evidence stale", () => {
    const run = {
      id: "r", pipelineLabel: "test", source: "manual" as const,
      status: "passed" as const, startedAt: 1, finishedAt: 2,
      fingerprint: "fp", nodes: [],
    };
    const passed = { ...task("unreviewed"), latestFingerprint: "fp", checkRuns: [run] };
    expect(reviewStateFor(passed, snapshot())).toBe("unreviewed");
    expect(checkStateFor(passed)).toBe("passed");
    expect(checkStateFor({ ...passed, latestFingerprint: "new" })).toBe("stale");
    expect(checkStateFor({ ...passed, checkRuns: [{ ...run, status: "failed" }] })).toBe("failed");
    expect(checkStateFor({ ...passed, checkRuns: [{ ...run, status: "invalidated", fingerprint: null }] })).toBe("failed");
  });
});

describe("agent inbox ordering", () => {
  it("uses strict tiers across both terminal scopes and oldest stable ties", () => {
    const failed = item("failed", "idle", "unreviewed", true, 2);
    failed.task = {
      ...failed.task!,
      latestFingerprint: "fp",
      checkRuns: [{
        id: "r",
        pipelineLabel: "test",
        source: "manual",
        status: "failed",
        startedAt: 1,
        finishedAt: 2,
        fingerprint: "fp",
        nodes: [],
      }],
    };
    const values = [
      item("working", "working", undefined, true, 1),
      item("done-new", "idle", "clean", false, 20),
      failed,
      item("blocked-new", "blocked", "clean", false, 8),
      item("blocked-old", "blocked", "clean", false, 3),
      item("g-unreviewed", "idle", "unreviewed", true, 1),
    ];
    expect(sortInboxItems(values).map((value) => value.runtime.terminalId)).toEqual([
      "blocked-old", "blocked-new", "failed", "g-unreviewed", "done-new", "working",
    ]);
    expect(inboxTier(values[0])).toBe(4);
    expect(values.filter(isInboxActionable)).toHaveLength(5);
  });

  it("wraps actionable navigation and starts at an edge from non-actionable focus", () => {
    const values = [item("a", "blocked"), item("b", "idle", "unreviewed"), item("c", "working")];
    expect(nextActionableId(values, "a", -1)).toBe("b");
    expect(nextActionableId(values, "b", 1)).toBe("a");
    expect(nextActionableId(values, "c", 1)).toBe("a");
    expect(nextActionableId(values, "c", -1)).toBe("b");
  });

  it("does not expose review actions while the agent is working", () => {
    const working = item("active", "working", "unreviewed");
    expect(inboxTier(working)).toBe(4);
    expect(isInboxActionable(working)).toBe(false);
  });
});
