import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeAgentRuntime,
  applyAgentActivity,
  applyAgentProcessResult,
  applyAgentScreen,
  markAgentLaunching,
  markAgentProcessQueryFailed,
  registerAgentRuntime,
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
});

describe("agent runtime transitions", () => {
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

  it("uses unknown rather than false absence on process-query failure", () => {
    register("a");
    makePresent("a");
    markAgentProcessQueryFailed(["a"]);
    expect(state("a").occupancy).toBe("unknown");
    expect(displayAgentState(state("a"))).toBe("unknown");
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
