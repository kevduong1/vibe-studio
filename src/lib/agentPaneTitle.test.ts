import { describe, expect, it } from "vitest";
import { agentPaneTitle } from "./agentPaneTitle";

describe("agent pane titles", () => {
  it("removes Codex activity frames and redundant project-only titles", () => {
    expect(agentPaneTitle("codex", "⠹ clean-up-agent-stuff", ["clean-up-agent-stuff"]))
      .toBe("");
    expect(agentPaneTitle("codex", "clean-up-agent-stuff", ["clean-up-agent-stuff"]))
      .toBe("");
    expect(agentPaneTitle("codex", "Fix titles ⠹ Tasks 1/3"))
      .toBe("Fix titles | Tasks 1/3");
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

  it("removes Codex context meters without swallowing ordinary topic prose", () => {
    expect(
      agentPaneTitle(
        "codex",
        "Ready | 01a01178-b445-74c2-bc06-10a8dd0a97cf | Context 100% left",
      ),
    ).toBe("");
    expect(agentPaneTitle("codex", "Fix titles | Context 42% left | Tasks 1/3"))
      .toBe("Fix titles | Tasks 1/3");
    expect(agentPaneTitle("codex", "Context 12% used")).toBe("");
    expect(agentPaneTitle("codex", "Explain Context 100% left in the screenshot"))
      .toBe("Explain Context 100% left in the screenshot");
  });

  it("removes both phases of Codex's activity action-required title", () => {
    expect(agentPaneTitle("codex", "[ ! ] Action Required | minimal-ide", ["minimal-ide"]))
      .toBe("");
    expect(
      agentPaneTitle(
        "codex",
        "[ . ] Action Required | Fix launch titles | Tasks 2/3",
      ),
    ).toBe("Fix launch titles | Tasks 2/3");
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
