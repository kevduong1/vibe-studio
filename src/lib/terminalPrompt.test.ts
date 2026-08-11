import { describe, expect, it } from "vitest";
import { terminalPromptInput } from "./terminalPrompt";

describe("terminalPromptInput", () => {
  it("uses one sanitized bracketed paste and one final Enter", () => {
    expect(terminalPromptInput("line 1\nline \x1b[201~2", true)).toBe(
      "\x1b[200~line 1\nline [201~2\x1b[201~\r",
    );
  });

  it("flattens multiline text when bracketed paste is unavailable", () => {
    expect(terminalPromptInput("one\r\ntwo\tthree", false)).toBe("one two three\r");
  });
});
