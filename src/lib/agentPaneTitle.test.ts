import { describe, expect, it } from "vitest";
import { agentPaneTitle } from "./agentPaneTitle";

describe("agent pane titles", () => {
  it("removes Codex activity frames and redundant project-only titles", () => {
    expect(agentPaneTitle("codex", "⠹ clean-up-agent-stuff", ["clean-up-agent-stuff"]))
      .toBe("");
    expect(agentPaneTitle("codex", "clean-up-agent-stuff", ["clean-up-agent-stuff"]))
      .toBe("");
  });

  it("keeps nonredundant Codex metadata and Claude topics", () => {
    expect(agentPaneTitle("codex", "⠋ model: gpt-5", ["project"]))
      .toBe("model: gpt-5");
    expect(agentPaneTitle("claude", "⠋ Investigating tests", ["project"]))
      .toBe("⠋ Investigating tests");
  });
});
