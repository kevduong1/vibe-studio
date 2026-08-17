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
  it("gives a changed lifecycle a fresh stability budget", () => {
    const working = advanceSemanticDebounceWindow(
      { episode: "1:working", since: 0 },
      "1:working",
      700,
    );
    expect(working.remaining).toBe(100);

    const idle = advanceSemanticDebounceWindow(
      working.window,
      "1:idle",
      700,
    );
    expect(idle).toEqual({
      window: { episode: "1:idle", since: 700 },
      remaining: 800,
    });
    expect(advanceSemanticDebounceWindow(idle.window, "1:idle", 900).remaining)
      .toBe(600);
  });

  it("keeps the bounded maximum while rules churn inside one lifecycle", () => {
    let window = advanceSemanticDebounceWindow(
      { episode: null, since: null },
      "1:working",
      0,
    ).window;
    // A spinner frame and a footer hint alternate on every write; the episode
    // is unchanged, so the 800 ms cap keeps counting down to zero.
    for (const now of [200, 400, 600]) {
      const advanced = advanceSemanticDebounceWindow(window, "1:working", now);
      expect(advanced.remaining).toBe(800 - now);
      window = advanced.window;
    }
    expect(advanceSemanticDebounceWindow(window, "1:working", 900).remaining)
      .toBeLessThanOrEqual(0);
  });

  it("restarts the window when a new occupant generation owns the evidence", () => {
    const first = advanceSemanticDebounceWindow(
      { episode: "1:idle", since: 0 },
      "2:idle",
      500,
    );
    expect(first).toEqual({
      window: { episode: "2:idle", since: 500 },
      remaining: 800,
    });
  });
});
