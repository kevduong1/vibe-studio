import { describe, expect, it } from "vitest";
import {
  boundedLogicalTail,
  classifyAgentScreen,
} from "./agentProfiles";

const fixtures = {
  claude: {
    idle: ["Claude Code v2.1.226", "> "],
    working: ["✻ Reading files…", "esc to interrupt"],
    permission: ["Do you want to proceed?", "1. Yes, allow", "2. No"],
    question: ["Which approach should I use?", "Enter to select"],
    auth: ["Authentication required. Run claude login."],
    quota: ["Usage limit reached · resets at 3pm"],
    error: ["API Error: connection failed"],
  },
  codex: {
    idle: ["OpenAI Codex (v0.147.0)", "› "],
    working: ["• Working (12s)", "esc to interrupt"],
    permission: ["Would you like to run the following command?", "Press enter to confirm"],
    question: ["Choose an option", "waiting for your response"],
    auth: ["Not signed in. Sign in to continue."],
    quota: ["Usage limit reached"],
    error: ["Error: stream disconnected"],
  },
} as const;

describe("agent screen profiles", () => {
  for (const kind of ["claude", "codex"] as const) {
    it(`${kind} recognizes the recorded idle prompt`, () => {
      expect(classifyAgentScreen(kind, fixtures[kind].idle).lifecycle).toBe("idle");
    });

    it(`${kind} recognizes active work`, () => {
      expect(classifyAgentScreen(kind, fixtures[kind].working).lifecycle).toBe("working");
    });

    for (const reason of ["permission", "question", "auth", "quota", "error"] as const) {
      it(`${kind} recognizes ${reason} blocking evidence`, () => {
        expect(classifyAgentScreen(kind, fixtures[kind][reason])).toMatchObject({
          lifecycle: "blocked",
          reason,
        });
      });
    }
  }

  it("ignores stale blocked text above a newer idle prompt", () => {
    expect(
      classifyAgentScreen("claude", [
        "Do you want to proceed?",
        "Yes, allow",
        "completed",
        "> ",
      ]),
    ).toMatchObject({ lifecycle: "idle", matchedRule: "claude.idle" });
  });

  it("recognizes current structured question overlays", () => {
    expect(
      classifyAgentScreen("claude", [
        "Review your answers",
        "Ready to submit your answers?",
        "Submit answers",
      ]),
    ).toMatchObject({
      lifecycle: "blocked",
      reason: "question",
      matchedRule: "claude.question",
      strong: true,
    });
    expect(
      classifyAgentScreen("codex", [
        "Question 1/2 (2 unanswered)",
        "Database strategy",
        "› 1. PostgreSQL",
        "enter to submit answer",
      ]),
    ).toMatchObject({
      lifecycle: "blocked",
      reason: "question",
      matchedRule: "codex.question",
      strong: true,
    });
  });

  it("treats a conversational final question followed by the main prompt as idle", () => {
    expect(
      classifyAgentScreen("codex", [
        "• Which approach should I tackle next?",
        "› ",
      ]),
    ).toMatchObject({ lifecycle: "idle", matchedRule: "codex.idle" });
  });

  it("classifies ordinary shells, exits, and unsupported output as unknown", () => {
    for (const lines of [
      ["kevin@mac repo %"],
      ["logout", "[process exited with code 0]"],
      ["vim alternate screen", "~", "~"],
    ]) {
      expect(classifyAgentScreen("codex", lines).lifecycle).toBe("unknown");
    }
  });

  it("bounds snapshots to 40 logical lines and 16 KiB", () => {
    const tail = boundedLogicalTail(Array.from({ length: 80 }, (_, i) => `${i}:${"x".repeat(600)}`));
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(16 * 1024);
    expect(tail.at(-1)?.startsWith("79:")).toBe(true);
  });
});
