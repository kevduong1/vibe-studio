import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  reconcileAgentEvidence,
  registerAgentRuntime,
  setAgentPaneVisibility,
  subscribeAgentTransitions,
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

const screen = (
  id: string,
  lifecycle: "working" | "blocked" | "idle" | "unknown",
  watched: boolean,
  extra: { reason?: "permission" | "question"; matchedRule?: string } = {},
) => {
  applyAgentScreen(
    id,
    state(id).generation,
    { lifecycle, strong: lifecycle === "blocked", ...extra },
    watched,
  );
};

/** What the tracker reports when a turn's quiet survives its grace window. */
const completedTurn = { busy: false, attention: false, completed: true };

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  for (const id of ids) unregisterAgentRuntime(id);
  ids.clear();
  mockAgentProcessSnapshot.mockReset();
  vi.useRealTimers();
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

  it("lets explicit working screen evidence override activity and falls back when it disappears", () => {
    register("a");
    makePresent("a");
    applyAgentScreen("a", 1, { lifecycle: "working", matchedRule: "work", strong: false }, true);
    applyAgentActivity("a", { busy: true, attention: false }, false);
    expect(state("a")).toMatchObject({ lifecycle: "working", authority: "screen" });
    applyAgentScreen("a", 1, { lifecycle: "unknown", strong: false }, false);
    expect(state("a")).toMatchObject({ lifecycle: "working", authority: "activity" });
  });
});

describe("completion evidence", () => {
  it("creates unseen done when a background stretch ends through an inconclusive read", () => {
    register("a");
    makePresent("a");
    screen("a", "working", false);
    // The routine path out of a turn: one screen read that cannot classify,
    // then the tracker reporting the quiet survived.
    screen("a", "unknown", false);
    expect(state("a").lifecycle).toBe("unknown");
    applyAgentActivity("a", completedTurn, false);
    expect(displayAgentState(state("a"))).toBe("done");
  });

  it("settles a short background turn the tracker never pinged", () => {
    register("a");
    makePresent("a");
    applyAgentActivity("a", { busy: true, attention: false }, false);
    applyAgentActivity("a", completedTurn, false);
    expect(displayAgentState(state("a"))).toBe("done");
  });

  it("settles a background blocked prompt nobody answered as plain idle", () => {
    register("a");
    makePresent("a");
    screen("a", "blocked", false, { reason: "question", matchedRule: "q" });
    screen("a", "idle", false);
    expect(displayAgentState(state("a"))).toBe("idle");
    expect(state("a").seen).toBe(true);
  });

  it("keeps an unseen done unseen while its idle prompt is redrawn", () => {
    register("a");
    makePresent("a");
    screen("a", "working", false);
    screen("a", "idle", false);
    expect(displayAgentState(state("a"))).toBe("done");
    screen("a", "idle", false);
    expect(displayAgentState(state("a"))).toBe("done");
  });
});

describe("blocked evidence", () => {
  it("retains a blocked prompt through an inconclusive screen read", () => {
    register("a");
    makePresent("a");
    screen("a", "blocked", false, { reason: "permission", matchedRule: "perm" });
    screen("a", "unknown", false);
    expect(state("a")).toMatchObject({
      lifecycle: "blocked",
      reason: "permission",
      matchedRule: "perm",
      seen: false,
    });
  });

  it("does not clear an osc blocked prompt when the user merely views the pane", () => {
    register("a");
    makePresent("a");
    applyAgentActivity(
      "a",
      { busy: false, attention: true, attentionSource: "notification" },
      false,
    );
    expect(state("a")).toMatchObject({ lifecycle: "blocked", authority: "osc", seen: false });
    // Viewing the pane: the tracker drops its attention and the session
    // acknowledges. Neither is an answer to the prompt.
    applyAgentActivity("a", { busy: false, attention: false }, true);
    acknowledgeAgentRuntime("a");
    expect(state("a")).toMatchObject({ lifecycle: "blocked", seen: true });
  });

  it("keeps an acknowledged prompt seen through redraws but alerts for a new one", () => {
    register("a");
    makePresent("a");
    screen("a", "blocked", false, { reason: "permission", matchedRule: "perm" });
    acknowledgeAgentRuntime("a");
    screen("a", "blocked", false, { reason: "permission", matchedRule: "perm" });
    expect(state("a")).toMatchObject({ lifecycle: "blocked", seen: true });
    screen("a", "blocked", false, { reason: "question", matchedRule: "ask" });
    expect(state("a")).toMatchObject({ lifecycle: "blocked", seen: false });
  });

  it("treats a latched ring under a screen-read prompt as corroboration", () => {
    register("a");
    makePresent("a");
    screen("a", "blocked", false, { reason: "permission", matchedRule: "perm" });
    acknowledgeAgentRuntime("a");
    // The CLI also rings while its prompt is up. Nothing clears that latch
    // for a pane the user is already looking at.
    applyAgentActivity(
      "a",
      { busy: false, attention: true, attentionSource: "notification" },
      true,
    );
    screen("a", "unknown", false); // an inconclusive read hands over to it
    expect(state("a")).toMatchObject({
      lifecycle: "blocked",
      reason: "permission",
      matchedRule: "perm",
      seen: true,
    });
  });

  it("lets a turn boundary observed after a ring clear an osc prompt", () => {
    vi.useFakeTimers();
    register("a");
    makePresent("a");
    applyAgentActivity(
      "a",
      { busy: false, attention: true, attentionSource: "notification" },
      false,
    );
    expect(state("a")).toMatchObject({ lifecycle: "blocked", authority: "osc" });

    vi.advanceTimersByTime(4000);
    applyAgentActivity(
      "a",
      { busy: false, attention: true, attentionSource: "notification", completed: true },
      false,
    );
    // The ring is still latched: it is the more specific evidence, and the
    // background alert must stand.
    expect(state("a").lifecycle).toBe("blocked");

    // Viewing unlatches the ring; the boundary observed after it is now the
    // newest thing this pane knows.
    applyAgentActivity("a", { busy: false, attention: false, completed: true }, true);
    expect(state("a")).toMatchObject({ lifecycle: "idle", seen: true });
  });

  it("ignores a turn boundary that predates the ring", () => {
    vi.useFakeTimers();
    register("a");
    makePresent("a");
    applyAgentActivity("a", { busy: true, attention: false }, false);
    applyAgentActivity("a", completedTurn, false);
    expect(displayAgentState(state("a"))).toBe("done");

    vi.advanceTimersByTime(1000);
    applyAgentActivity(
      "a",
      { busy: false, attention: true, attentionSource: "notification", completed: true },
      false,
    );
    applyAgentActivity("a", { busy: false, attention: false, completed: true }, true);
    expect(state("a").lifecycle).toBe("blocked");
  });

  it("never lets a turn boundary clear a prompt the screen classifier read", () => {
    register("a");
    makePresent("a");
    screen("a", "blocked", false, { reason: "permission", matchedRule: "perm" });
    applyAgentActivity("a", completedTurn, true);
    screen("a", "unknown", false);
    expect(state("a")).toMatchObject({ lifecycle: "blocked", matchedRule: "perm" });
  });

  it("lets resumed work clear a blocked prompt", () => {
    register("a");
    makePresent("a");
    applyAgentActivity(
      "a",
      { busy: false, attention: true, attentionSource: "notification" },
      false,
    );
    applyAgentActivity("a", { busy: true, attention: false }, false);
    expect(state("a")).toMatchObject({ lifecycle: "working" });
  });

  it("displays a blocked prompt raised during the launch grace", () => {
    register("a");
    markAgentLaunching("a");
    applyAgentScreen(
      "a",
      0,
      { lifecycle: "blocked", reason: "auth", matchedRule: "login", strong: true },
      false,
    );
    expect(state("a").occupancy).toBe("starting");
    expect(displayAgentState(state("a"))).toBe("blocked");
  });
});

describe("stale screen authority", () => {
  it("lets confirmed output override Claude's ambiguous idle composer", () => {
    register("a");
    makePresent("a");
    screen("a", "idle", true, { matchedRule: "claude.idle" });

    // Claude keeps this same composer painted while it works. The activity
    // tracker has already debounced the output before publishing busy=true.
    applyAgentActivity("a", { busy: true, attention: false }, true);
    expect(state("a")).toMatchObject({
      lifecycle: "working",
      authority: "activity",
    });

    // A repaint of the unchanged composer must not pin the tab back to idle
    // while output is still arriving.
    screen("a", "idle", true, { matchedRule: "claude.idle" });
    expect(state("a")).toMatchObject({
      lifecycle: "working",
      authority: "activity",
    });

    // Once output stops, the next stable composer read is authoritative idle.
    applyAgentActivity("a", { busy: false, attention: false }, true);
    screen("a", "idle", true, { matchedRule: "claude.idle" });
    expect(state("a")).toMatchObject({
      lifecycle: "idle",
      authority: "screen",
      matchedRule: "claude.idle",
    });
  });

  it("keeps a fresh screen verdict above activity and yields a stale one", () => {
    vi.useFakeTimers();
    register("a");
    makePresent("a");
    screen("a", "working", false);
    applyAgentActivity("a", completedTurn, false);
    expect(state("a")).toMatchObject({ lifecycle: "working", authority: "screen" });

    vi.advanceTimersByTime(20_000);
    reconcileAgentEvidence();
    expect(displayAgentState(state("a"))).toBe("done");
  });

  it("asks the pane, not the last signal, whether the user is watching", () => {
    vi.useFakeTimers();
    register("a");
    makePresent("a");
    screen("a", "working", false);
    applyAgentActivity("a", completedTurn, false);
    // The user revealed the pane afterwards. A silent screen produces no
    // further calls, so the cached watched=false is all the store would have.
    const unwatch = setAgentPaneVisibility("a", () => true);

    vi.advanceTimersByTime(20_000);
    reconcileAgentEvidence();
    expect(displayAgentState(state("a"))).toBe("idle");
    unwatch();
  });

  it("sweeps a stale verdict once instead of restamping it every tick", () => {
    vi.useFakeTimers();
    const transitions: unknown[] = [];
    const unsubscribe = subscribeAgentTransitions((t) => transitions.push(t));
    register("a");
    makePresent("a");
    screen("a", "working", false);
    applyAgentActivity("a", completedTurn, false);

    vi.advanceTimersByTime(20_000);
    reconcileAgentEvidence();
    expect(displayAgentState(state("a"))).toBe("done");
    const settledAt = state("a").changedAt;
    const count = transitions.length;

    vi.advanceTimersByTime(20_000);
    reconcileAgentEvidence();
    reconcileAgentEvidence();
    // An unseen Done keeps its inbox waiting age and emits nothing further.
    expect(state("a").changedAt).toBe(settledAt);
    expect(transitions).toHaveLength(count);
    unsubscribe();
  });

  it("leaves a screen verdict alone when the tracker already agrees with it", () => {
    vi.useFakeTimers();
    register("a");
    makePresent("a");
    screen("a", "working", false);
    applyAgentActivity("a", completedTurn, false);
    screen("a", "idle", false, { matchedRule: "idle" });
    const { changedAt } = state("a");

    vi.advanceTimersByTime(20_000);
    reconcileAgentEvidence();
    expect(state("a")).toMatchObject({
      changedAt,
      authority: "screen",
      matchedRule: "idle",
    });
    expect(displayAgentState(state("a"))).toBe("done");
  });

  it("never expires a blocked screen verdict", () => {
    vi.useFakeTimers();
    register("a");
    makePresent("a");
    screen("a", "blocked", false, { reason: "permission", matchedRule: "perm" });
    applyAgentActivity("a", completedTurn, false);
    vi.advanceTimersByTime(60_000);
    reconcileAgentEvidence();
    expect(state("a")).toMatchObject({ lifecycle: "blocked", matchedRule: "perm" });
  });
});

describe("occupancy bookkeeping", () => {
  it("does not restamp the semantic changedAt when masking and unmasking occupancy", () => {
    vi.useFakeTimers();
    register("a");
    makePresent("a", 42);
    const changedAt = state("a").changedAt;

    vi.advanceTimersByTime(5000);
    markAgentProcessQueryFailed(["a"]);
    expect(state("a")).toMatchObject({ occupancy: "unknown", changedAt });

    vi.advanceTimersByTime(5000);
    applyAgentProcessResult("a", 42, 1);
    expect(state("a")).toMatchObject({ occupancy: "present", changedAt });
  });

  it("preserves the launch grace across a transient query failure", () => {
    vi.useFakeTimers();
    register("a");
    markAgentLaunching("a");
    markAgentProcessQueryFailed(["a"]);
    expect(state("a").occupancy).toBe("starting");

    applyAgentProcessResult("a", undefined, 0);
    expect(state("a").occupancy).toBe("starting");

    vi.advanceTimersByTime(5000);
    applyAgentProcessResult("a", undefined, 0);
    expect(state("a").occupancy).toBe("absent");
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
