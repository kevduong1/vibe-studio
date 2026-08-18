import { describe, expect, it } from "vitest";
import {
  CODEX_TERMINAL_TITLE_CONFIG,
  codexCliCommand,
  codexTerminalTitleArguments,
} from "./codexTerminalTitle";

describe("Codex terminal-title launch configuration", () => {
  it("pins app-owned launches to topic-oriented title fields", () => {
    expect(codexTerminalTitleArguments()).toEqual([
      "-c",
      'tui.terminal_title=["activity","thread-title","task-progress"]',
    ]);
    expect(codexCliCommand("--yolo", "resume", "thread-id")).toBe(
      `'codex' '-c' '${CODEX_TERMINAL_TITLE_CONFIG}' '--yolo' 'resume' 'thread-id'`,
    );
  });
});
