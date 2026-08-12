import { describe, expect, it } from "vitest";
import type { AgentRuntimeState } from "./agentState";
import {
  advanceSemanticDebounceWindow,
  semanticRuntimeTransitionAction,
} from "./termSession";

const runtime = (
  occupancy: AgentRuntimeState["occupancy"],
  generation: number,
  occupantPid?: number,
): AgentRuntimeState => ({
  terminalId: "agent",
  workspacePath: "/repo",
  scope: "global",
  kind: "codex",
  occupancy,
  occupantPid,
  generation,
  lifecycle: "unknown",
  seen: true,
  changedAt: 1,
});

describe("terminal semantic generation boundaries", () => {
  it("waits for new output after an unannounced PID replacement", () => {
    expect(
      semanticRuntimeTransitionAction(
        runtime("present", 1, 10),
        runtime("present", 2, 11),
        1,
        false,
      ),
    ).toBe("generation-reset-wait");
  });

  it("inspects an app-owned launch and a same-PID query recovery", () => {
    expect(
      semanticRuntimeTransitionAction(
        runtime("starting", 1),
        runtime("present", 2, 11),
        1,
        true,
      ),
    ).toBe("generation-inspect");
    expect(
      semanticRuntimeTransitionAction(
        runtime("unknown", 2, 11),
        runtime("present", 2, 11),
        2,
        false,
      ),
    ).toBe("recovery-inspect");
  });
});

describe("terminal semantic debounce", () => {
  it("gives changed evidence a fresh stability budget", () => {
    const working = advanceSemanticDebounceWindow(
      { key: "working", since: 0 },
      "working",
      700,
    );
    expect(working.remaining).toBe(100);

    const idle = advanceSemanticDebounceWindow(
      working.window,
      "idle",
      700,
    );
    expect(idle).toEqual({
      window: { key: "idle", since: 700 },
      remaining: 800,
    });
    expect(advanceSemanticDebounceWindow(idle.window, "idle", 900).remaining)
      .toBe(600);
  });
});
