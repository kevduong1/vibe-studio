import { describe, expect, it } from "vitest";
import {
  boundedLogicalTail,
  classifyAgentScreen,
  normalizeAgentScreenLines,
} from "./agentProfiles";
import {
  logicalLinesFromRows,
  semanticBoundaryFirstLine,
  type ScreenRow,
} from "./termSession";

const row = (text: string, isWrapped = false): ScreenRow => ({ text, isWrapped });

/** xterm pre-fills the buffer to `rows`, so a short screen ends in blanks. */
const padded = (lines: string[], rows: number): ScreenRow[] => [
  ...lines.map((line) => row(line)),
  ...Array.from({ length: Math.max(0, rows - lines.length) }, () => row("")),
];

describe("logical tail extraction", () => {
  it("drops the blank rows xterm pre-fills a fresh screen with", () => {
    expect(logicalLinesFromRows(padded(["╭────╮", "│ >  │", "╰────╯"], 24)))
      .toEqual(["╭────╮", "│ >  │", "╰────╯"]);
  });

  it("keeps blank lines inside a dialog", () => {
    expect(
      logicalLinesFromRows(padded(["Do you want to proceed?", "", "1. Yes, allow"], 10)),
    ).toEqual(["Do you want to proceed?", "", "1. Yes, allow"]);
  });

  it("joins wrapped continuation rows into one logical line", () => {
    expect(
      logicalLinesFromRows([
        row("Yes, allow all edits during this "),
        row("session (shift+tab)", true),
        row("2. No"),
      ]),
    ).toEqual(["Yes, allow all edits during this session (shift+tab)", "2. No"]);
  });

  it("treats a continuation at the start of a bounded slice as its own line", () => {
    expect(logicalLinesFromRows([row("session (shift+tab)", true)]))
      .toEqual(["session (shift+tab)"]);
  });

  it("returns nothing for an entirely blank buffer", () => {
    expect(logicalLinesFromRows(padded([], 24))).toEqual([]);
  });
});

describe("box-drawing normalization", () => {
  it("strips frame edges and drops pure rules", () => {
    expect(
      normalizeAgentScreenLines([
        "╭──────────────────────────────╮",
        "│ > fix the failing test       │",
        "├──────────────────────────────┤",
        "│ 1. Yes, allow all edits      │",
        "╰──────────────────────────────╯",
      ]),
    ).toEqual(["> fix the failing test", "1. Yes, allow all edits"]);
  });

  it("keeps interior blank lines but trims trailing ones", () => {
    expect(normalizeAgentScreenLines(["a", "", "b", "   ", "│  │"]))
      .toEqual(["a", "", "b"]);
  });

  it("leaves an unframed line untouched apart from padding", () => {
    expect(normalizeAgentScreenLines(["  esc to interrupt  "]))
      .toEqual(["esc to interrupt"]);
  });

  it("is idempotent", () => {
    const once = normalizeAgentScreenLines(["│ ▌ Working…  │", "╰───╯"]);
    expect(normalizeAgentScreenLines(once)).toEqual(once);
  });

  it("must run before the bound for the window to hold evidence lines", () => {
    // Ten stacked frames: half the rows are borders the classifier discards.
    const framed = Array.from({ length: 10 }, (_, i) => [
      "╭────────────────╮",
      `│ evidence ${i}     │`,
      "╰────────────────╯",
    ]).flat();

    const boundFirst = normalizeAgentScreenLines(boundedLogicalTail(framed, 10));
    const normalizedFirst = boundedLogicalTail(normalizeAgentScreenLines(framed), 10);

    expect(normalizedFirst).toHaveLength(10);
    expect(normalizedFirst.every((line) => line.startsWith("evidence"))).toBe(true);
    expect(boundFirst.length).toBeLessThan(10);
  });

  it("lets a caller that already normalized skip the second pass", () => {
    const framed = ["╭────╮", "│ >  │", "╰────╯"];
    expect(classifyAgentScreen("claude", framed).lifecycle).toBe("idle");
    expect(classifyAgentScreen("claude", normalizeAgentScreenLines(framed), true).lifecycle)
      .toBe("idle");
    // Claiming normalization without doing it leaves the frame in place, so
    // the session must prepare its tail before asserting the flag.
    expect(classifyAgentScreen("claude", framed, true).lifecycle).toBe("unknown");
  });
});

describe("semantic screen boundary", () => {
  it("anchors the normal buffer one viewport above the end of content", () => {
    expect(
      semanticBoundaryFirstLine({ bufferType: "normal", rows: 30, lastContentRow: 199 }),
    ).toBe(170);
  });

  it("never collapses onto a short buffer", () => {
    expect(
      semanticBoundaryFirstLine({ bufferType: "normal", rows: 30, lastContentRow: 4 }),
    ).toBe(0);
    expect(
      semanticBoundaryFirstLine({ bufferType: "normal", rows: 30, lastContentRow: -1 }),
    ).toBe(0);
  });

  it("keeps rows painted below the reset point out of the window", () => {
    // The cursor sat at row 120 while a dialog was already painted through
    // row 180; anchoring on content rather than the cursor excludes it.
    const first = semanticBoundaryFirstLine({
      bufferType: "normal",
      rows: 24,
      lastContentRow: 180,
    });
    expect(first).toBeGreaterThan(120);
  });

  it("treats the whole alternate-screen viewport as post-boundary", () => {
    expect(
      semanticBoundaryFirstLine({ bufferType: "alternate", rows: 30, lastContentRow: 29 }),
    ).toBe(0);
  });
});
