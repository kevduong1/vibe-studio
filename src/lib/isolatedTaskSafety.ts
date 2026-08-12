import type { AgentRuntimeState } from "./agentState";
import type { ReviewLineComment } from "../stores/reviewComments";
import { MAX_AGENT_PROMPT_CHARS } from "./agentPromptLimits";

export const MAX_REVIEW_FEEDBACK_COMMENTS = 50;
export const MAX_REVIEW_FEEDBACK_COMMENT_CHARS = 3_000;

export interface ReviewFeedbackBatch {
  comments: ReviewLineComment[];
  prompt: string;
}

/** Select the largest leading batch bounded by both comment count and the
 * prompt queue's total character limit. */
export function buildReviewFeedbackBatch(
  comments: readonly ReviewLineComment[],
): ReviewFeedbackBatch {
  const selected: ReviewLineComment[] = [];
  const entries: string[] = [];
  for (const comment of comments.slice(0, MAX_REVIEW_FEEDBACK_COMMENTS)) {
    const entry = `${comment.path}:${comment.line} — ${comment.body.replace(/[\r\n]+/g, " ").trim()}`;
    const candidate = `Review feedback: ${[...entries, entry].join("; ")}`;
    if (candidate.length > MAX_AGENT_PROMPT_CHARS) {
      if (selected.length === 0) {
        throw new Error(
          `The first review comment is too long for the ${MAX_AGENT_PROMPT_CHARS.toLocaleString()} character prompt limit. Shorten it before sending.`,
        );
      }
      break;
    }
    selected.push(comment);
    entries.push(entry);
  }
  if (selected.length === 0) throw new Error("Add at least one line comment first");
  return { comments: selected, prompt: `Review feedback: ${entries.join("; ")}` };
}

export interface MergeOwnerProof {
  terminalId: string;
  generation: number | null;
  occupancy: AgentRuntimeState["occupancy"] | null;
  lifecycle: AgentRuntimeState["lifecycle"] | null;
  runtimeChangedAt: number | null;
  sessionIsLive: boolean;
}

export const mergeOwnerProofMatches = (
  proof: MergeOwnerProof,
  runtime: AgentRuntimeState | undefined,
  sessionIsLive: boolean,
): boolean => {
  if (!runtime) {
    return proof.generation === null &&
      proof.occupancy === null &&
      proof.lifecycle === null &&
      proof.runtimeChangedAt === null &&
      sessionIsLive === proof.sessionIsLive;
  }
  return runtime.generation === proof.generation &&
    runtime.occupancy === proof.occupancy &&
    runtime.lifecycle === proof.lifecycle &&
    runtime.changedAt === proof.runtimeChangedAt &&
    sessionIsLive === proof.sessionIsLive;
};
