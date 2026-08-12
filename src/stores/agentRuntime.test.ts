import { afterEach, describe, expect, it, vi } from "vitest";

const { mockAgentProcessSnapshot } = vi.hoisted(() => ({
  mockAgentProcessSnapshot: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  agentProcessSnapshot: mockAgentProcessSnapshot,
}));

import {
  acknowledgeAgentRuntime,
  applyAgentActivity,
  applyAgentProcessResult,
  applyAgentProcessSnapshot,
  applyAgentScreen,
  markAgentLaunching,
  markAgentTerminalExited,
  markAgentProcessQueryFailed,
  pollAgentProcesses,
  registerAgentRuntime,
  selectAgentSubagents,
  selectTerminalRollup,
  selectWorkspaceRollup,
  unregisterAgentRuntime,
  useAgentRuntimeStore,
} from "./agentRuntime";
import { displayAgentState } from "../lib/agentState";

const ids = new Set<string>();
const register = (
  id: string,
  workspacePath = "/repo/a",
  scope: "global" | "workspace" = "global",
) => {
  ids.add(id);
  registerAgentRuntime({ terminalId: id, workspacePath, scope, kind: "claude" });
};
const state = (id: string) => useAgentRuntimeStore.getState().states[id];
const makePresent = (id: string, pid = 10) => {
  applyAgentProcessResult(id, pid, state(id).generation);
};

afterEach(() => {
  for (const id of ids) unregisterAgentRuntime(id);
  ids.clear();
  mockAgentProcessSnapshot.mockReset();
});

describe("agent runtime transitions", () => {
  it("returns one stable empty child-process snapshot", () => {
    const first = selectAgentSubagents({ subagents: {} }, "missing");
    const second = selectAgentSubagents({ subagents: {} }, "missing");
    expect(first).toBe(second);
  });

  it("transitions absent → starting → present", () => {
    register("a");
    expect(displayAgentState(state("a"))).toBe("absent");
    markAgentLaunching("a");
    expect(displayAgentState(state("a"))).toBe("starting");
    applyAgentProcessResult("a", 42, 0);
    expect(state("a")).toMatchObject({ occupancy: "present", occupantPid: 42, generation: 1 });
  });

  it("does not create done when working becomes visible idle", () => {
    register("a");
    makePresent("a");
    applyAgentScreen("a", 1, { lifecycle: "working", matchedRule: "work", strong: false }, true);
    applyAgentScreen("a", 1, { lifecycle: "idle", matchedRule: "idle", strong: false }, true);
    expect(displayAgentState(state("a"))).toBe("idle");
  });

  it("creates unseen done in the background and viewing acknowledges it", () => {
    register("a");
    makePresent("a");
    applyAgentActivity("a", { busy: true, attention: false }, false);
    applyAgentActivity("a", { busy: false, attention: true, attentionSource: "completion" }, false);
    expect(displayAgentState(state("a"))).toBe("done");
    acknowledgeAgentRuntime("a");
    expect(displayAgentState(state("a"))).toBe("idle");
  });

  it("acknowledges a blocked prompt without clearing its lifecycle", () => {
    register("a");
    makePresent("a");
    applyAgentScreen("a", 1, { lifecycle: "blocked", reason: "permission", matchedRule: "permission", strong: true }, false);
    acknowledgeAgentRuntime("a");
    expect(state("a")).toMatchObject({ lifecycle: "blocked", seen: true });
  });

  it("increments generation on PID replacement and rejects stale classifications", () => {
    register("a");
    makePresent("a", 10);
    applyAgentScreen("a", 1, { lifecycle: "working", matchedRule: "old", strong: false }, false);
    applyAgentProcessResult("a", 11, 1);
    expect(state("a")).toMatchObject({ occupantPid: 11, generation: 2, lifecycle: "unknown" });
    applyAgentScreen("a", 1, { lifecycle: "blocked", reason: "question", matchedRule: "stale", strong: true }, false);
    expect(state("a").matchedRule).not.toBe("stale");
  });

  it("returns to absent when the agent exits to its shell", () => {
    register("a");
    makePresent("a");
    applyAgentProcessResult("a", undefined, 1);
    expect(state("a")).toMatchObject({ occupancy: "absent", lifecycle: "unknown" });
  });

  it("marks an exited PTY as proven stopped without inventing a generation", () => {
    register("a");
    makePresent("a", 42);
    markAgentTerminalExited("a");
    expect(state("a")).toMatchObject({
      occupancy: "exited",
      occupantPid: undefined,
      generation: 1,
      lifecycle: "unknown",
    });
    expect(displayAgentState(state("a"))).toBe("absent");
  });

  it("does not let an in-flight process poll overwrite a proven PTY exit", () => {
    register("a");
    makePresent("a", 42);
    markAgentTerminalExited("a");

    applyAgentProcessSnapshot("a", [
      {
        pid: 42,
        parentPid: 1,
        parentAgentPid: null,
        rootAgentPid: 42,
        executable: "claude",
        foreground: true,
      },
      {
        pid: 43,
        parentPid: 42,
        parentAgentPid: 42,
        rootAgentPid: 42,
        executable: "claude",
        foreground: false,
      },
    ], 1);
    markAgentProcessQueryFailed(["a"]);

    expect(state("a")).toMatchObject({
      occupancy: "exited",
      occupantPid: undefined,
      generation: 1,
      lifecycle: "unknown",
    });
    expect(selectAgentSubagents(useAgentRuntimeStore.getState(), "a")).toHaveLength(0);
  });

  it("does not query the backend when every retained terminal has exited", async () => {
    register("a");
    makePresent("a", 42);
    markAgentTerminalExited("a");

    await pollAgentProcesses();

    expect(mockAgentProcessSnapshot).not.toHaveBeenCalled();
  });

  it("omits retained exited terminals from a mixed process poll", async () => {
    register("active");
    register("exited");
    makePresent("active", 41);
    makePresent("exited", 42);
    markAgentTerminalExited("exited");
    mockAgentProcessSnapshot.mockResolvedValue([]);

    await pollAgentProcesses();

    expect(mockAgentProcessSnapshot).toHaveBeenCalledOnce();
    expect(mockAgentProcessSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ terminalId: "active" }),
    ]);
  });

  it("exposes additional matching processes as generation-owned read-only subagents", () => {
    register("a");
    applyAgentProcessSnapshot("a", [
      { pid: 10, parentPid: 1, parentAgentPid: null, rootAgentPid: 10, executable: "claude", foreground: true },
      { pid: 11, parentPid: 10, parentAgentPid: 10, rootAgentPid: 10, executable: "claude", foreground: false },
      { pid: 13, parentPid: 1, parentAgentPid: null, rootAgentPid: 13, executable: "claude", foreground: false },
      { pid: 12, parentPid: 10, parentAgentPid: 10, rootAgentPid: 10, executable: "node", foreground: false },
    ], 0);
    expect(state("a")).toMatchObject({ occupantPid: 10, generation: 1 });
    expect(useAgentRuntimeStore.getState().subagents.a).toEqual([
      expect.objectContaining({ id: "a:1:11", pid: 11, executable: "claude" }),
    ]);
    applyAgentProcessSnapshot("a", [], 1);
    expect(useAgentRuntimeStore.getState().subagents.a).toBeUndefined();
  });

  it("discovers the exact agent kind inside an ordinary shell", () => {
    ids.add("shell");
    registerAgentRuntime({
      terminalId: "shell",
      workspacePath: "/repo/a",
      scope: "workspace",
      kind: "claude",
      discovery: true,
    });
    applyAgentProcessSnapshot("shell", [
      { pid: 21, parentPid: 1, parentAgentPid: null, rootAgentPid: 21, executable: "node", foreground: false },
      { pid: 22, parentPid: 1, parentAgentPid: null, rootAgentPid: 22, executable: "codex", foreground: true },
    ], 0);
    expect(state("shell")).toMatchObject({
      kind: "codex",
      occupancy: "present",
      occupantPid: 22,
      generation: 1,
    });
  });

  it("uses unknown rather than false absence on process-query failure", () => {
    register("a");
    makePresent("a");
    markAgentProcessQueryFailed(["a"]);
    expect(state("a")).toMatchObject({
      occupancy: "unknown",
      occupantPid: 10,
      generation: 1,
    });
    expect(displayAgentState(state("a"))).toBe("unknown");
  });

  it("restores the same PID after a query failure without replacing its generation", () => {
    register("a");
    makePresent("a", 42);
    applyAgentScreen(
      "a",
      1,
      { lifecycle: "blocked", reason: "permission", matchedRule: "permission", strong: true },
      false,
    );
    markAgentProcessQueryFailed(["a"]);
    applyAgentProcessResult("a", 42, 1);
    expect(state("a")).toMatchObject({
      occupancy: "present",
      occupantPid: 42,
      generation: 1,
      lifecycle: "blocked",
      matchedRule: "permission",
    });
  });

  it("preserves startup activity but not unowned screen evidence on first PID discovery", () => {
    register("a");
    markAgentLaunching("a");
    applyAgentActivity("a", { busy: true, attention: false }, false);
    applyAgentScreen(
      "a",
      0,
      { lifecycle: "blocked", reason: "question", matchedRule: "stale", strong: true },
      false,
    );
    applyAgentProcessResult("a", 42, 0);
    expect(state("a")).toMatchObject({
      occupancy: "present",
      occupantPid: 42,
      generation: 1,
      lifecycle: "working",
      authority: "activity",
    });
    expect(state("a").matchedRule).toBeUndefined();
  });

  it("lets screen evidence override activity and falls back when it disappears", () => {
    register("a");
    makePresent("a");
    applyAgentScreen("a", 1, { lifecycle: "idle", matchedRule: "idle", strong: false }, true);
    applyAgentActivity("a", { busy: true, attention: false }, false);
    expect(state("a")).toMatchObject({ lifecycle: "idle", authority: "screen" });
    applyAgentScreen("a", 1, { lifecycle: "unknown", strong: false }, false);
    expect(state("a")).toMatchObject({ lifecycle: "working", authority: "activity" });
  });
});

describe("semantic rollups", () => {
  it("uses blocked > done > working > idle", () => {
    for (const id of ["idle", "work", "done", "block"]) {
      register(id);
      makePresent(id);
    }
    applyAgentActivity("work", { busy: true, attention: false }, false);
    applyAgentActivity("done", { busy: true, attention: false }, false);
    applyAgentActivity("done", { busy: false, attention: true, attentionSource: "completion" }, false);
    applyAgentActivity("block", { busy: false, attention: true, attentionSource: "notification" }, false);
    expect(selectTerminalRollup(useAgentRuntimeStore.getState(), ["idle", "work"])).toBe("working");
    expect(selectTerminalRollup(useAgentRuntimeStore.getState(), ["work", "done"])).toBe("done");
    expect(selectTerminalRollup(useAgentRuntimeStore.getState())).toBe("blocked");
  });

  it("includes both scopes in workspace families while terminal-id groups stay restricted", () => {
    register("global-a", "/repo/a", "global");
    register("project-a", "/repo/a", "workspace");
    register("global-b", "/repo/b", "global");
    for (const id of ids) makePresent(id);
    applyAgentActivity("project-a", { busy: true, attention: false }, false);
    applyAgentActivity("global-b", { busy: false, attention: true, attentionSource: "notification" }, false);
    expect(selectWorkspaceRollup(useAgentRuntimeStore.getState(), ["/repo/a"])).toBe("working");
    expect(selectWorkspaceRollup(useAgentRuntimeStore.getState(), ["/repo/a", "/repo/b"])).toBe("blocked");
    expect(selectTerminalRollup(useAgentRuntimeStore.getState(), ["global-a"])).toBe("idle");
  });
});
