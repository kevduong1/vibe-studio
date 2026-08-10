import { describe, expect, it } from "vitest";
import {
  agentAlertAction,
  type AgentRuntimeState,
} from "./agentState";

const runtime = (
  lifecycle: AgentRuntimeState["lifecycle"],
  seen: boolean,
): AgentRuntimeState => ({
  terminalId: "agent-1",
  workspacePath: "/repo",
  scope: "global",
  kind: "codex",
  occupancy: "present",
  occupantPid: 7,
  generation: 1,
  lifecycle,
  seen,
  changedAt: 1,
});

describe("semantic notification edges", () => {
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

  it("dismisses on acknowledgement, resumed work, exit, close, and disable-equivalent removal", () => {
    const blocked = runtime("blocked", false);
    expect(agentAlertAction(blocked, { ...blocked, seen: true })).toBe("dismiss");
    expect(agentAlertAction(blocked, runtime("working", true))).toBe("dismiss");
    expect(agentAlertAction(blocked, { ...blocked, occupancy: "absent", lifecycle: "unknown" })).toBe("dismiss");
    expect(agentAlertAction(blocked, undefined)).toBe("dismiss");
  });
});
