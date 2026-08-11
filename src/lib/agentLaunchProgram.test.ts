import { describe, expect, it } from "vitest";
import {
  agentLaunchProgram,
  combineAgentPreludes,
  isolatedTaskAgentPrelude,
  quoteShellArgument,
} from "./agentLaunchProgram";

describe("agentLaunchProgram", () => {
  it("runs environment exports in the shell that launches the agent", () => {
    expect(agentLaunchProgram("'codex' '--yolo'", "export PORT=4100 TOKEN='a b'"))
      .toBe("export PORT=4100 TOKEN='a b' && 'codex' '--yolo'");
  });

  it("leaves an environment-free command unchanged", () => {
    expect(agentLaunchProgram("claude")).toBe("claude");
  });

  it("combines isolated-task and profile exports without a subshell", () => {
    expect(combineAgentPreludes(
      isolatedTaskAgentPrelude("task-id", 4100),
      "export TOKEN='value'",
    )).toBe("export VIBE_TASK_ID='task-id' PORT=4100 && export TOKEN='value'");
  });

  it("quotes shell arguments containing apostrophes", () => {
    expect(quoteShellArgument("task's prompt")).toBe("'task'\\''s prompt'");
  });
});
