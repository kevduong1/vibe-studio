import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { detectLineEnding, serializeText } from "./editorBuffers";
import { detectIndentation } from "./editorStatus";

describe("editor line endings", () => {
  it("detects the dominant separator", () => {
    expect(detectLineEnding("a\nb\n")).toBe("LF");
    expect(detectLineEnding("a\r\nb\r\n")).toBe("CRLF");
    expect(detectLineEnding("a\rb\r")).toBe("CR");
  });

  it("serializes CodeMirror text without normalizing the chosen separator", () => {
    const text = Text.of(["a", "b", ""]);
    expect(serializeText(text, "LF")).toBe("a\nb\n");
    expect(serializeText(text, "CRLF")).toBe("a\r\nb\r\n");
    expect(serializeText(text, "CR")).toBe("a\rb\r");
  });
});

describe("editor indentation", () => {
  it("distinguishes common space widths and tabs", () => {
    expect(detectIndentation("root\n  child\n    grandchild\n")).toBe("Spaces: 2");
    expect(detectIndentation("root\n    child\n        grandchild\n")).toBe("Spaces: 4");
    expect(detectIndentation("root\n\tchild\n\t\tgrandchild\n")).toBe("Tabs");
  });
});
