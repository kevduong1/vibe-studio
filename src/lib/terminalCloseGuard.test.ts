import { describe, expect, it } from "vitest";
import type { AgentRuntimeState } from "./agentState";
import { terminalCloseConfirmation } from "./terminalCloseGuard";

const runtime = (
  occupancy: AgentRuntimeState["occupancy"],
): AgentRuntimeState => ({
  terminalId: "terminal-1",
  workspacePath: "/repo",
  scope: "workspace",
  requestedKind: null,
  kind: "claude",
  occupancy,
  generation: 1,
  lifecycle: "idle",
  seen: true,
  changedAt: 1,
});

describe("terminalCloseConfirmation", () => {
  it("does not interrupt closing an ordinary project shell", () => {
    expect(
      terminalCloseConfirmation("workspace", {
        title: "Terminal 1",
        kind: "shell",
      }),
    ).toBeNull();
    expect(
      terminalCloseConfirmation(
        "workspace",
        { title: "Terminal 1", kind: "shell" },
        runtime("absent"),
      ),
    ).toBeNull();
  });

  it("protects dedicated and discovered project agents", () => {
    expect(
      terminalCloseConfirmation("workspace", {
        title: "Claude",
        kind: "claude",
      }),
    ).toMatchObject({ title: "Close Agent Terminal" });
    expect(
      terminalCloseConfirmation(
        "workspace",
        { title: "Terminal 1", kind: "shell" },
        runtime("present"),
      ),
    ).toMatchObject({ title: "Close Agent Terminal" });
    // Unknown occupancy masks a previously present agent during a query
    // failure, so it must remain protected.
    expect(
      terminalCloseConfirmation(
        "workspace",
        { title: "Terminal 1", kind: "shell" },
        runtime("unknown"),
      ),
    ).toMatchObject({ title: "Close Agent Terminal" });
  });

  it("protects every global terminal, including plain shells", () => {
    expect(
      terminalCloseConfirmation("global", {
        title: "talos",
        kind: "shell",
      }),
    ).toEqual({
      title: "Close Global Terminal",
      message:
        'Close global terminal "talos"?\n\nThis will stop its process and remove the tab.',
    });
  });
});
