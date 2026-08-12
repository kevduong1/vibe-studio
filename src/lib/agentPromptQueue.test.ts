import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeState } from "./agentState";

type PreparePromptWrite = () =>
  void | (() => void) | Promise<void | (() => void)>;

const mocks = vi.hoisted(() => ({
  states: {} as Record<string, AgentRuntimeState>,
  transition: null as null | ((value: {
    previous?: AgentRuntimeState;
    current?: AgentRuntimeState;
  }) => void),
  prepareCheckpoint: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  commitCheckpoint: vi.fn<(...args: unknown[]) => void>(),
  sendPrompt: vi.fn<(
    text: string,
    prepareWrite?: PreparePromptWrite,
  ) => Promise<void>>(),
  delivered: vi.fn<(text: string) => void>(),
  pendingTurns: new Set<string>(),
}));

vi.mock("../stores/agentTasks", () => ({
  prepareAgentTurnCheckpoint: (...args: unknown[]) => mocks.prepareCheckpoint(...args),
  commitAgentTurnCheckpoint: (...args: unknown[]) => mocks.commitCheckpoint(...args),
  agentPromptTurnPending: (terminalId: string) => mocks.pendingTurns.has(terminalId),
}));

vi.mock("../stores/agentRuntime", () => ({
  useAgentRuntimeStore: { getState: () => ({ states: mocks.states }) },
  subscribeAgentTransitions: (callback: typeof mocks.transition) => {
    mocks.transition = callback;
    return () => {};
  },
}));

vi.mock("./termSessions", () => {
  const session = {
    exited: false,
    sendPrompt: (text: string, prepareWrite?: PreparePromptWrite) =>
      mocks.sendPrompt(text, prepareWrite),
  };
  return { getSession: () => session };
});

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
    mocks.prepareCheckpoint.mockReset().mockResolvedValue({ checkpoint: true });
    mocks.commitCheckpoint.mockReset();
    mocks.pendingTurns.clear();
    mocks.delivered.mockReset();
    mocks.sendPrompt.mockReset().mockImplementation(async (text, prepareWrite) => {
      const commit = await prepareWrite?.();
      commit?.();
      mocks.delivered(text);
    });
  });

  it("cancels a request while its checkpoint is still in flight", async () => {
    const state = runtime("cancelled");
    mocks.states.cancelled = state;
    let finishCheckpoint!: () => void;
    mocks.prepareCheckpoint.mockImplementationOnce(() => new Promise((resolve) => {
      finishCheckpoint = () => resolve({ checkpoint: true });
    }));

    const queued = queueAgentPrompt("cancelled", "do the thing", "request-1");
    const rejected = expect(queued).rejects.toThrow("cancelled before dispatch");
    expect(cancelQueuedAgentPrompt("request-1")).toBe(true);
    finishCheckpoint();

    await rejected;
    await Promise.resolve();
    expect(mocks.commitCheckpoint).not.toHaveBeenCalled();
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it("does not dispatch or remove a replacement that reuses a cancelled request ID", async () => {
    const state = runtime("reused");
    mocks.states.reused = state;
    let finishFirstCheckpoint!: () => void;
    mocks.prepareCheckpoint.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirstCheckpoint = () => resolve({ checkpoint: true });
    }));

    const first = queueAgentPrompt("reused", "cancel me", "same-request");
    const firstRejected = expect(first).rejects.toThrow("cancelled before dispatch");
    expect(cancelQueuedAgentPrompt("same-request")).toBe(true);
    const replacement = queueAgentPrompt("reused", "replacement", "same-request");
    finishFirstCheckpoint();

    await firstRejected;
    await expect(replacement).resolves.toBe("same-request");
    expect(mocks.delivered).toHaveBeenCalledTimes(1);
    expect(mocks.delivered).toHaveBeenCalledWith("replacement");
  });

  it("rejects a queued prompt when its occupant disappears during checkpointing", async () => {
    const state = runtime("replaced");
    mocks.states.replaced = state;
    let finishCheckpoint!: () => void;
    mocks.prepareCheckpoint.mockImplementationOnce(() => new Promise((resolve) => {
      finishCheckpoint = () => resolve({ checkpoint: true });
    }));

    const queued = queueAgentPrompt("replaced", "do the thing", "request-2");
    delete mocks.states.replaced;
    mocks.transition?.({ previous: state });
    finishCheckpoint();

    await expect(queued).rejects.toThrow("occupant changed");
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it("waits for the preceding input turn before dispatching a successive prompt", async () => {
    mocks.states.successive = runtime("successive");
    mocks.commitCheckpoint.mockImplementationOnce(() => {
      mocks.pendingTurns.add("successive");
    });
    const first = queueAgentPrompt("successive", "first", "request-3");
    const second = queueAgentPrompt("successive", "second", "request-4");

    await expect(first).resolves.toBe("request-3");
    await Promise.resolve();
    expect(mocks.delivered).toHaveBeenCalledTimes(1);
    mocks.pendingTurns.delete("successive");
    mocks.transition?.({
      previous: { ...mocks.states.successive, lifecycle: "working" },
      current: mocks.states.successive,
    });
    await expect(second).resolves.toBe("request-4");
    expect(mocks.delivered).toHaveBeenNthCalledWith(1, "first");
    expect(mocks.delivered).toHaveBeenNthCalledWith(2, "second");
  });

  it("prepares and commits only after earlier terminal input leaves the queue", async () => {
    mocks.states.ordered = runtime("ordered");
    const order: string[] = [];
    let releasePriorInput!: () => void;
    const priorInput = new Promise<void>((resolve) => {
      releasePriorInput = resolve;
    });
    mocks.prepareCheckpoint.mockImplementationOnce(async () => {
      order.push("prepare");
      return { checkpoint: true };
    });
    mocks.commitCheckpoint.mockImplementationOnce(() => {
      order.push("commit");
    });
    mocks.sendPrompt.mockImplementationOnce(async (_text, prepareWrite) => {
      order.push("reserved");
      await priorInput;
      order.push("prior:done");
      const commit = await prepareWrite?.();
      commit?.();
      order.push("send");
    });

    const queued = queueAgentPrompt("ordered", "prompt", "request-ordered");
    await Promise.resolve();
    expect(order).toEqual(["reserved"]);
    releasePriorInput();
    await expect(queued).resolves.toBe("request-ordered");
    expect(order).toEqual(["reserved", "prior:done", "prepare", "commit", "send"]);
  });

  it("captures the control-plane turn boundary immediately before dispatch", async () => {
    mocks.states.boundary = runtime("boundary");
    const order: string[] = [];
    mocks.sendPrompt.mockImplementationOnce(async (_text, prepareWrite) => {
      const commit = await prepareWrite?.();
      commit?.();
      order.push("send");
    });
    mocks.commitCheckpoint.mockImplementationOnce(() => {
      order.push("commit");
    });

    await queueAgentPrompt("boundary", "prompt", "request-boundary", async () => {
      order.push("boundary");
    });

    expect(order).toEqual(["boundary", "commit", "send"]);
  });

  it("does not publish a checkpoint when cancellation wins an async dispatch guard", async () => {
    mocks.states.guarded = runtime("guarded");
    let guardStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      guardStarted = resolve;
    });
    let releaseGuard!: () => void;
    const guarded = queueAgentPrompt("guarded", "prompt", "request-guarded", async () => {
      guardStarted();
      await new Promise<void>((resolve) => {
        releaseGuard = resolve;
      });
    });

    await started;
    const rejected = expect(guarded).rejects.toThrow("cancelled before dispatch");
    expect(cancelQueuedAgentPrompt("request-guarded")).toBe(true);
    releaseGuard();

    await rejected;
    expect(mocks.commitCheckpoint).not.toHaveBeenCalled();
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it("cannot report cancellation after PTY delivery has started", async () => {
    mocks.states.committed = runtime("committed");
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    let finishDelivery!: () => void;
    mocks.sendPrompt.mockImplementationOnce(async (_text, prepareWrite) => {
      const commit = await prepareWrite?.();
      commit?.();
      deliveryStarted();
      await new Promise<void>((resolve) => {
        finishDelivery = resolve;
      });
    });

    const queued = queueAgentPrompt("committed", "prompt", "request-committed");
    await started;
    expect(cancelQueuedAgentPrompt("request-committed")).toBe(false);
    finishDelivery();

    await expect(queued).resolves.toBe("request-committed");
    expect(mocks.commitCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of silently truncating oversized prompts", () => {
    mocks.states.bounded = runtime("bounded");
    expect(() => queueAgentPrompt("bounded", "x".repeat(MAX_AGENT_PROMPT_CHARS + 1)))
      .toThrow("character limit");
  });
});
