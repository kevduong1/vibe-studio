import { describe, expect, it } from "vitest";
import type { GitReviewSnapshot } from "../lib/ipc";
import type { AgentRuntimeState } from "../lib/agentState";
import {
  checkStateFor,
  inboxTier,
  isInboxActionable,
  nextActionableId,
  reviewStateFor,
  sortInboxItems,
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
  fingerprint: "fp",
  ...patch,
});

describe("agent review state", () => {
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
