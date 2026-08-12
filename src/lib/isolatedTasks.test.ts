import { describe, expect, it } from "vitest";
import type { AgentRuntimeState } from "./agentState";
import type { ReviewLineComment } from "../stores/reviewComments";
import { MAX_AGENT_PROMPT_CHARS } from "./agentPromptLimits";
import {
  buildReviewFeedbackBatch,
  MAX_REVIEW_FEEDBACK_COMMENTS,
  mergeOwnerProofMatches,
  type MergeOwnerProof,
} from "./isolatedTaskSafety";

const comment = (id: string, body = "fix this"): ReviewLineComment => ({
  id,
  taskId: "task",
  terminalId: "terminal",
  generation: 1,
  fingerprint: "fingerprint",
  path: "src/file.ts",
  line: 1,
  body,
  createdAt: 1,
});

describe("isolated task review feedback", () => {
  it("bounds a batch by both comment count and total prompt characters", () => {
    const countBounded = buildReviewFeedbackBatch(
      Array.from({ length: MAX_REVIEW_FEEDBACK_COMMENTS + 5 }, (_, index) =>
        comment(String(index))),
    );
    expect(countBounded.comments).toHaveLength(MAX_REVIEW_FEEDBACK_COMMENTS);

    const characterBounded = buildReviewFeedbackBatch([
      comment("one", "x".repeat(3_000)),
      comment("two", "y".repeat(3_000)),
      comment("three", "z".repeat(3_000)),
    ]);
    expect(characterBounded.comments.map((item) => item.id)).toEqual(["one", "two"]);
    expect(characterBounded.prompt.length).toBeLessThanOrEqual(MAX_AGENT_PROMPT_CHARS);
  });

  it("rejects a single comment that cannot fit without truncation", () => {
    expect(() => buildReviewFeedbackBatch([
      comment("oversized", "x".repeat(MAX_AGENT_PROMPT_CHARS)),
    ])).toThrow("first review comment is too long");
  });
});

describe("isolated task merge ownership", () => {
  const current: AgentRuntimeState = {
    terminalId: "terminal",
    workspacePath: "/repo/task",
    scope: "global",
    kind: "codex",
    occupancy: "present",
    generation: 4,
    lifecycle: "idle",
    seen: true,
    changedAt: 1,
  };
  const proof: MergeOwnerProof = {
    terminalId: "terminal",
    generation: 4,
    occupancy: "present",
    lifecycle: "idle",
    runtimeChangedAt: 1,
    sessionIsLive: true,
  };

  it("requires the same safe state and generation after merge IPC", () => {
    expect(mergeOwnerProofMatches(proof, current, true)).toBe(true);
    expect(mergeOwnerProofMatches(proof, { ...current, generation: 5 }, true)).toBe(false);
    expect(mergeOwnerProofMatches(proof, { ...current, lifecycle: "working" }, true)).toBe(false);
    expect(mergeOwnerProofMatches(proof, { ...current, changedAt: 2 }, true)).toBe(false);
    expect(mergeOwnerProofMatches(proof, current, false)).toBe(false);
  });

  it("does not treat disappearance of previously observed state as unchanged", () => {
    const stopped: MergeOwnerProof = {
      terminalId: "terminal",
      generation: 4,
      occupancy: "exited",
      lifecycle: "idle",
      runtimeChangedAt: 1,
      sessionIsLive: false,
    };
    expect(mergeOwnerProofMatches(stopped, undefined, false)).toBe(false);
    expect(mergeOwnerProofMatches({
      terminalId: "terminal",
      generation: null,
      occupancy: null,
      lifecycle: null,
      runtimeChangedAt: null,
      sessionIsLive: false,
    }, undefined, false)).toBe(true);
  });
});
