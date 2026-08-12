import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentControlRequest } from "./ipc";

const mocks = vi.hoisted(() => ({
  gitOpen: vi.fn(),
  openWorkspace: vi.fn(),
  openGlobalTerminal: vi.fn<(...args: unknown[]) => string>(() => "terminal-1"),
  createIsolatedTask: vi.fn(),
  boundary: vi.fn(),
  queuePrompt: vi.fn(),
  runtimeStates: {} as Record<string, unknown>,
  respond: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  sync: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  cancelQueuedPrompt: vi.fn(),
  requestListener: null as null | ((request: AgentControlRequest) => void),
  cancelListener: null as null | ((request: {
    requestId: string;
    deliveryId: string;
  }) => void),
}));

vi.mock("./ipc", () => ({
  agentControlRespond: (...args: unknown[]) => mocks.respond(...args),
  agentControlCommit: (...args: unknown[]) => mocks.boundary(...args),
  agentControlSync: (...args: unknown[]) => mocks.sync(...args),
  onAgentControlCancel: vi.fn(async (callback) => {
    mocks.cancelListener = callback;
    return () => {};
  }),
  onAgentControlRequest: vi.fn(async (callback) => {
    mocks.requestListener = callback;
    return () => {};
  }),
  gitOpen: (...args: unknown[]) => mocks.gitOpen(...args),
}));

vi.mock("./agentInbox", () => ({
  focusAgentTerminal: vi.fn(),
}));

vi.mock("./agentPromptQueue", () => ({
  cancelQueuedAgentPrompt: (...args: unknown[]) => mocks.cancelQueuedPrompt(...args),
  queueAgentPrompt: (...args: unknown[]) => mocks.queuePrompt(...args),
  steerAgentPrompt: vi.fn(),
}));

vi.mock("./isolatedTasks", () => ({
  createIsolatedTask: (...args: unknown[]) => mocks.createIsolatedTask(...args),
  defaultWorktreePath: () => "/worktrees/task",
  slugifyTaskName: () => "task",
  uniqueTaskSuffix: () => "suffix",
}));

vi.mock("./agentSessions", () => ({
  openGlobalTerminal: (...args: unknown[]) => mocks.openGlobalTerminal(...args),
}));

vi.mock("../stores/agentDefinitions", () => ({
  BUILTIN_AGENT_DEFINITIONS: [{ id: "codex", detectionProfile: "codex" }],
  BUILTIN_LAUNCH_PROFILES: [{ id: "profile", definitionId: "codex" }],
  launchCommand: () => ({ command: "codex --yolo", environmentPrelude: null }),
}));

vi.mock("../stores/agentRuntime", () => ({
  useAgentRuntimeStore: {
    getState: () => ({ states: mocks.runtimeStates }),
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock("../stores/workspaces", () => ({
  useWorkspacesStore: {
    getState: () => ({
      openWorkspace: (...args: unknown[]) => mocks.openWorkspace(...args),
    }),
  },
}));

import { handleAgentControlRequest, listenAgentControlPlane } from "./agentControlPlane";

const request = (isolated: boolean): AgentControlRequest => ({
  requestId: "request-1",
  deliveryId: "delivery-1",
  action: "start",
  terminalId: null,
  generation: null,
  text: "do the thing",
  mode: null,
  workspacePath: "/repo",
  kind: "codex",
  taskName: "Task",
  isolated,
  deadlineAtMs: Date.now() + 60_000,
});

describe("agent control frontend start", () => {
  beforeEach(() => {
    mocks.gitOpen.mockReset();
    mocks.openWorkspace.mockReset();
    mocks.openGlobalTerminal.mockReset().mockReturnValue("terminal-1");
    mocks.createIsolatedTask.mockReset();
    mocks.boundary.mockReset().mockResolvedValue({ seq: 1, working: false });
    mocks.queuePrompt.mockReset();
    for (const key of Object.keys(mocks.runtimeStates)) delete mocks.runtimeStates[key];
    mocks.respond.mockClear();
    mocks.sync.mockClear();
    mocks.cancelQueuedPrompt.mockClear();
    mocks.requestListener = null;
    mocks.cancelListener = null;
  });

  it("does not open or launch after cancellation during repository resolution", async () => {
    let resolveGit!: (value: { root: string }) => void;
    mocks.gitOpen.mockImplementationOnce(() => new Promise((resolve) => {
      resolveGit = resolve;
    }));
    let cancelled = false;
    const handling = handleAgentControlRequest(request(false), () => cancelled);

    cancelled = true;
    resolveGit({ root: "/repo" });

    await expect(handling).rejects.toThrow("request cancelled");
    expect(mocks.openWorkspace).not.toHaveBeenCalled();
    expect(mocks.openGlobalTerminal).not.toHaveBeenCalled();
  });

  it("does not launch after cancellation while opening a shared workspace", async () => {
    mocks.gitOpen.mockResolvedValueOnce({ root: "/repo" });
    let finishOpen!: () => void;
    mocks.openWorkspace.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishOpen = resolve;
    }));
    let cancelled = false;
    const handling = handleAgentControlRequest(request(false), () => cancelled);
    await vi.waitFor(() => expect(mocks.openWorkspace).toHaveBeenCalled());

    cancelled = true;
    finishOpen();

    await expect(handling).rejects.toThrow("request cancelled");
    expect(mocks.openGlobalTerminal).not.toHaveBeenCalled();
  });

  it("treats cancellation as too late after the backend commits a shared launch", async () => {
    mocks.gitOpen.mockResolvedValueOnce({ root: "/repo" });
    mocks.openWorkspace.mockResolvedValueOnce(undefined);
    let cancelled = false;
    mocks.boundary.mockImplementationOnce(async () => {
      cancelled = true;
      return { seq: 1, working: false };
    });

    await expect(handleAgentControlRequest(request(false), () => cancelled)).resolves.toEqual({
      terminalId: "terminal-1",
      workspacePath: "/repo",
    });
    expect(mocks.openGlobalTerminal).toHaveBeenCalledOnce();
  });

  it("passes the live cancellation guard into isolated task creation", async () => {
    let cancelled = false;
    mocks.createIsolatedTask.mockImplementationOnce(async (input: {
      cancelled?: () => boolean;
    }) => {
      expect(input.cancelled).toBeTypeOf("function");
      cancelled = true;
      expect(input.cancelled?.()).toBe(true);
      throw new Error("Isolated task creation was cancelled.");
    });

    await expect(handleAgentControlRequest(request(true), () => cancelled))
      .rejects.toThrow("cancelled");
    expect(mocks.openGlobalTerminal).not.toHaveBeenCalled();
  });

  it("returns the atomic sequence and working-state prompt boundary", async () => {
    mocks.runtimeStates.agent = { generation: 4, occupancy: "present" };
    mocks.boundary.mockResolvedValueOnce({ seq: 29, working: true });
    mocks.queuePrompt.mockImplementationOnce(async (
      _terminalId: string,
      _text: string,
      _promptId: string,
      beforeDispatch: () => Promise<void>,
    ) => {
      await beforeDispatch();
      return "delivery-1";
    });
    const promptRequest: AgentControlRequest = {
      ...request(false),
      action: "prompt",
      terminalId: "agent",
      generation: 4,
      mode: "queue",
      workspacePath: null,
    };

    await expect(handleAgentControlRequest(promptRequest, () => false)).resolves.toMatchObject({
      promptBaselineSeq: 29,
      promptBaselineWorking: true,
    });
    expect(mocks.boundary).toHaveBeenCalledWith("request-1", "delivery-1");
    expect(mocks.queuePrompt).toHaveBeenCalledWith(
      "agent",
      "do the thing",
      "delivery-1",
      expect.any(Function),
    );
  });
});

describe("agent control delivery identity", () => {
  it("does not apply a stale cancel to a reused caller request ID", async () => {
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeout: vi.fn(),
    });
    const cancellations: Array<() => boolean> = [];
    const completions: Array<(value: {
      id: string;
      agentTerminalId: string;
      worktreePath: string;
    }) => void> = [];
    mocks.createIsolatedTask.mockImplementation((input: {
      cancelled: () => boolean;
    }) => {
      cancellations.push(input.cancelled);
      return new Promise((resolve) => completions.push(resolve));
    });

    const dispose = listenAgentControlPlane();
    await vi.waitFor(() => {
      expect(mocks.requestListener).toBeTypeOf("function");
      expect(mocks.cancelListener).toBeTypeOf("function");
    });
    const oldRequest = { ...request(true), requestId: "reused", deliveryId: "old" };
    const newRequest = { ...request(true), requestId: "reused", deliveryId: "new" };
    mocks.requestListener?.(oldRequest);
    mocks.requestListener?.(newRequest);
    expect(cancellations).toHaveLength(2);

    mocks.cancelListener?.({ requestId: "different", deliveryId: "new" });
    expect(cancellations[1]()).toBe(false);
    mocks.cancelListener?.({ requestId: "reused", deliveryId: "old" });
    expect(cancellations[0]()).toBe(true);
    expect(cancellations[1]()).toBe(false);
    expect(mocks.cancelQueuedPrompt).toHaveBeenCalledExactlyOnceWith("old");

    completions[0]({ id: "old-task", agentTerminalId: "old-terminal", worktreePath: "/old" });
    completions[1]({ id: "new-task", agentTerminalId: "new-terminal", worktreePath: "/new" });
    await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(2));
    expect(mocks.respond).toHaveBeenCalledWith("reused", "old", true, expect.anything());
    expect(mocks.respond).toHaveBeenCalledWith("reused", "new", true, expect.anything());
    dispose();
    vi.unstubAllGlobals();
  });
});
