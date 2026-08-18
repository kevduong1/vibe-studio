import { describe, expect, it } from "vitest";
import {
  agentAlertAction,
  agentStateLabel,
  agentStateTooltip,
  displayAgentState,
  rollupAgentStates,
  type AgentRuntimeState,
} from "./agentState";

const runtime = (
  lifecycle: AgentRuntimeState["lifecycle"],
  seen: boolean,
): AgentRuntimeState => ({
  terminalId: "agent-1",
  workspacePath: "/repo",
  scope: "global",
  requestedKind: "codex",
  kind: "codex",
  occupancy: "present",
  occupantPid: 7,
  generation: 1,
  lifecycle,
  seen,
  changedAt: 1,
});

describe("semantic notification edges", () => {
  it("explains when the detected occupant differs from the tab default", () => {
    const state = { ...runtime("idle", true), requestedKind: "claude" as const };
    expect(agentStateTooltip(state)).toContain("Codex — Idle\nTab default: Claude");
  });

  it("composes background work into labels and tooltips without changing idle", () => {
    const state = {
      ...runtime("idle", true),
      background: { count: 1, summary: "1 shell" },
    };
    expect(displayAgentState(state)).toBe("idle");
    expect(agentStateLabel(state)).toBe("Idle · 1 shell running");
    expect(agentStateTooltip(state)).toContain("Background: 1 shell");
  });

  it("does not create or dismiss an alert for an annotation-only edge", () => {
    const idle = runtime("idle", true);
    expect(
      agentAlertAction(idle, {
        ...idle,
        background: { count: 2, summary: "2 shells" },
        changedAt: 2,
      }),
    ).toBe("none");
  });

  it("alerts once for background blocked and not on redraw", () => {
    const blocked = runtime("blocked", false);
    expect(agentAlertAction(runtime("working", true), blocked)).toBe("blocked");
    expect(agentAlertAction(blocked, { ...blocked })).toBe("none");
  });

  it("alerts once for unseen completion", () => {
    const done = runtime("idle", false);
    expect(agentAlertAction(runtime("working", true), done)).toBe("done");
    expect(agentAlertAction(done, { ...done })).toBe("none");
  });

  it("does not replay an alert when the same generation recovers from an occupancy query outage", () => {
    for (const lifecycle of ["blocked", "idle"] as const) {
      const recovered = runtime(lifecycle, false);
      expect(
        agentAlertAction(
          { ...recovered, occupancy: "unknown" },
          recovered,
        ),
      ).toBe("none");
    }
  });

  it("alerts again for a new prompt after the first one was acknowledged", () => {
    const acknowledged = runtime("blocked", true);
    const second: AgentRuntimeState = {
      ...acknowledged,
      seen: false,
      reason: "question",
      matchedRule: "ask",
    };
    expect(agentAlertAction(acknowledged, second)).toBe("blocked");
    expect(agentAlertAction(second, { ...second })).toBe("none");
  });

  it("does not dismiss a live prompt raised during the launch grace", () => {
    const blocked = runtime("blocked", false);
    const starting: AgentRuntimeState = { ...blocked, occupancy: "starting" };
    expect(displayAgentState(starting)).toBe("blocked");
    expect(agentAlertAction(runtime("unknown", true), starting)).toBe("blocked");
    expect(agentAlertAction(starting, blocked)).toBe("none");
  });

  it("dismisses on acknowledgement, resumed work, exit, close, and disable-equivalent removal", () => {
    const blocked = runtime("blocked", false);
    expect(agentAlertAction(blocked, { ...blocked, seen: true })).toBe("dismiss");
    expect(agentAlertAction(blocked, runtime("working", true))).toBe("dismiss");
    expect(agentAlertAction(blocked, { ...blocked, occupancy: "absent", lifecycle: "unknown" })).toBe("dismiss");
    expect(agentAlertAction(blocked, undefined)).toBe("dismiss");
  });
});

describe("rollups", () => {
  it("reports nothing to roll up separately from a present idle agent", () => {
    expect(rollupAgentStates([])).toBeNull();
    expect(rollupAgentStates([undefined])).toBeNull();
    expect(
      rollupAgentStates([{ ...runtime("unknown", true), occupancy: "absent" }]),
    ).toBeNull();
    expect(rollupAgentStates([runtime("idle", true)])).toBe("idle");
  });

  it("uses blocked > done > working > idle", () => {
    const idle = runtime("idle", true);
    const working = runtime("working", true);
    const done = runtime("idle", false);
    const blocked = runtime("blocked", false);
    expect(rollupAgentStates([idle, working])).toBe("working");
    expect(rollupAgentStates([working, done])).toBe("done");
    expect(rollupAgentStates([done, blocked])).toBe("blocked");
  });
});
