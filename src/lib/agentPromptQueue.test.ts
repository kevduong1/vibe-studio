import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeState } from "./agentState";

const mocks = vi.hoisted(() => ({
  states: {} as Record<string, AgentRuntimeState>,
  transition: null as null | ((value: {
    previous?: AgentRuntimeState;
    current?: AgentRuntimeState;
  }) => void),
  checkpoint: vi.fn<(...args: unknown[]) => Promise<void>>(),
  sendPrompt: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("../stores/agentTasks", () => ({
  captureAgentTurnCheckpoint: (...args: unknown[]) => mocks.checkpoint(...args),
}));

vi.mock("../stores/agentRuntime", () => ({
  useAgentRuntimeStore: { getState: () => ({ states: mocks.states }) },
  subscribeAgentTransitions: (callback: typeof mocks.transition) => {
    mocks.transition = callback;
    return () => {};
  },
}));

vi.mock("./termSessions", () => ({
  getSession: () => ({ exited: false, sendPrompt: mocks.sendPrompt }),
}));

import {
  cancelQueuedAgentPrompt,
  MAX_AGENT_PROMPT_CHARS,
  queueAgentPrompt,
} from "./agentPromptQueue";

const runtime = (terminalId: string): AgentRuntimeState => ({
  terminalId,
  workspacePath: "/repo",
  scope: "global",
  kind: "codex",
  occupancy: "present",
  generation: 3,
  lifecycle: "idle",
  seen: true,
  changedAt: 1,
});

describe("agent prompt queue", () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.states)) delete mocks.states[key];
    mocks.checkpoint.mockReset().mockResolvedValue();
    mocks.sendPrompt.mockReset().mockResolvedValue();
  });

  it("cancels a request while its checkpoint is still in flight", async () => {
    const state = runtime("cancelled");
    mocks.states.cancelled = state;
    let finishCheckpoint!: () => void;
    mocks.checkpoint.mockImplementationOnce(() => new Promise((resolve) => {
      finishCheckpoint = resolve;
    }));

    const queued = queueAgentPrompt("cancelled", "do the thing", "request-1");
    const rejected = expect(queued).rejects.toThrow("cancelled before dispatch");
    expect(cancelQueuedAgentPrompt("request-1")).toBe(true);
    finishCheckpoint();

    await rejected;
    await Promise.resolve();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it("rejects a queued prompt when its occupant disappears during checkpointing", async () => {
    const state = runtime("replaced");
    mocks.states.replaced = state;
    let finishCheckpoint!: () => void;
    mocks.checkpoint.mockImplementationOnce(() => new Promise((resolve) => {
      finishCheckpoint = resolve;
    }));

    const queued = queueAgentPrompt("replaced", "do the thing", "request-2");
    delete mocks.states.replaced;
    mocks.transition?.({ previous: state });
    finishCheckpoint();

    await expect(queued).rejects.toThrow("occupant changed");
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it("dispatches successive prompts without waiting for another state edge", async () => {
    mocks.states.successive = runtime("successive");
    const first = queueAgentPrompt("successive", "first", "request-3");
    const second = queueAgentPrompt("successive", "second", "request-4");

    await expect(first).resolves.toBe("request-3");
    await expect(second).resolves.toBe("request-4");
    expect(mocks.sendPrompt).toHaveBeenNthCalledWith(1, "first");
    expect(mocks.sendPrompt).toHaveBeenNthCalledWith(2, "second");
  });

  it("rejects instead of silently truncating oversized prompts", () => {
    mocks.states.bounded = runtime("bounded");
    expect(() => queueAgentPrompt("bounded", "x".repeat(MAX_AGENT_PROMPT_CHARS + 1)))
      .toThrow("character limit");
  });
});
