import { describe, expect, it } from "vitest";
import { agentPaneTitle } from "./agentPaneTitle";

describe("agent pane titles", () => {
  it("removes Codex activity frames and redundant project-only titles", () => {
    expect(agentPaneTitle("codex", "⠹ clean-up-agent-stuff", ["clean-up-agent-stuff"]))
      .toBe("");
    expect(agentPaneTitle("codex", "clean-up-agent-stuff", ["clean-up-agent-stuff"]))
      .toBe("");
  });

  it("removes configured Codex state, unnamed-thread, and project fields", () => {
    expect(
      agentPaneTitle(
        "codex",
        "⠹ Starting | 01a01178-b445-74c2-bc06-10a8dd0a97cf | main | minimal-ide",
        ["minimal-ide"],
      ),
    ).toBe("main");
    expect(
      agentPaneTitle(
        "codex",
        "Ready | 01a01178-b445-74c2-bc06-10a8dd0a97cf | minimal-ide",
        ["minimal-ide"],
      ),
    ).toBe("");
  });

  it("keeps nonredundant Codex metadata and Claude topics", () => {
    expect(agentPaneTitle("codex", "⠋ model: gpt-5", ["project"]))
      .toBe("model: gpt-5");
    expect(agentPaneTitle("codex", "⠋ Fix launch titles | minimal-ide", ["minimal-ide"]))
      .toBe("Fix launch titles");
    expect(agentPaneTitle("claude", "⠋ Investigating tests", ["project"]))
      .toBe("⠋ Investigating tests");
  });
});
