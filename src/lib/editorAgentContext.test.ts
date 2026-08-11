import { describe, expect, it } from "vitest";
import { formatAgentEditorContext } from "./editorAgentContextFormat";

describe("editor agent context", () => {
  it("labels a selection with its file and line range", () => {
    expect(formatAgentEditorContext({
      kind: "selection",
      selection: { path: "src/app.ts", text: "const x = 1", fromLine: 4, toLine: 4 },
    })).toContain("src/app.ts:4-4:\n\nconst x = 1");
  });

  it("bounds selected text before sending it to a terminal", () => {
    const prompt = formatAgentEditorContext({
      kind: "selection",
      selection: { path: "large.txt", text: "x".repeat(20_000), fromLine: 1, toLine: 1 },
    });
    expect(prompt).toContain("Selection truncated");
    expect(prompt.length).toBeLessThan(8 * 1024);
  });
});
