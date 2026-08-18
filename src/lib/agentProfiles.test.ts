import { describe, expect, it } from "vitest";
import {
  boundedLogicalTail,
  classifyAgentScreen,
  extractAgentScreenAnnotations,
} from "./agentProfiles";

/**
 * Fixtures are shaped the way the installed CLIs render: framed dialogs, a
 * framed composer that stays on screen in every state, and a footer hint row
 * underneath it. Classification normalizes the frame away itself, so these
 * stay verbatim.
 */
const claude = {
  idle: [
    "⏺ Updated src/lib/status.ts",
    "",
    "╭──────────────────────────────────────────────╮",
    "│ >                                            │",
    "╰──────────────────────────────────────────────╯",
    "  ? for shortcuts",
  ],
  idleWithDraft: [
    "╭──────────────────────────────────────────────╮",
    "│ > fix the failing status test                │",
    "╰──────────────────────────────────────────────╯",
    "  ? for shortcuts",
  ],
  working: [
    "✻ Percolating… (12s · ↓ 1.2k tokens)",
    "",
    "╭──────────────────────────────────────────────╮",
    "│ >                                            │",
    "╰──────────────────────────────────────────────╯",
    "  esc to interrupt · ctrl+o show tasks",
  ],
  permission: [
    "╭──────────────────────────────────────────────╮",
    "│ Bash command                                 │",
    "│                                              │",
    "│   rm -rf build                               │",
    "│                                              │",
    "│ Do you want to proceed?                      │",
    "│ ❯ 1. Yes                                     │",
    "│   2. Yes, allow all edits during this        │",
    "│      session (shift+tab)                     │",
    "│   3. No, and tell Claude what to do          │",
    "│      differently (esc)                       │",
    "╰──────────────────────────────────────────────╯",
  ],
  plan: [
    "╭──────────────────────────────────────────────╮",
    "│ Ready to code?                               │",
    "│                                              │",
    "│ Here is Claude's plan:                       │",
    "│ 1. Extract the tail walk                     │",
    "│                                              │",
    "│ ❯ 1. Yes, and auto-accept edits              │",
    "│   2. No, keep planning                       │",
    "╰──────────────────────────────────────────────╯",
  ],
  question: [
    "│ How should retries be handled?               │",
    "│                                              │",
    "│ ❯ 1. Exponential backoff                     │",
    "│   2. Fixed delay                             │",
    "│                                              │",
    "│ ←/→ to switch · ↑/↓ to navigate · Enter to select · Esc to cancel │",
  ],
  auth: ["Not logged in · Please run /login"],
  quota: ["Usage limit reached · resets at 3pm"],
  error: ["API Error: 400 duplicate tool_use ID in conversation history."],
} as const;

const codex = {
  idle: [
    "╭──────────────────────────────────────────────╮",
    "│ › Ask Codex to do anything                   │",
    "╰──────────────────────────────────────────────╯",
    "  ⏎ send   Shift+⏎ newline   Ctrl+C quit",
  ],
  idleWithDraft: [
    "╭──────────────────────────────────────────────╮",
    "│ › rerun the failing worktree test            │",
    "╰──────────────────────────────────────────────╯",
    "  ⏎ send   Shift+⏎ newline   Ctrl+C quit",
  ],
  working: ["• Working (12s · Esc to interrupt)"],
  permission: [
    "╭──────────────────────────────────────────────╮",
    "│ Do you want to approve this command?         │",
    "│                                              │",
    "│   $ rm -rf build                             │",
    "│                                              │",
    "│ > 1. Yes, just this once                     │",
    "│   2. Yes, and don't ask again for commands   │",
    "│      that start with `rm`                    │",
    "│   3. No, and tell Codex what to do           │",
    "│                                              │",
    "│ Esc to cancel                                │",
    "╰──────────────────────────────────────────────╯",
  ],
  question: [
    "│ Question 2/3 (1 unanswered)                  │",
    "│ Which database should the worker use?        │",
    "│ › 1. PostgreSQL                              │",
    "│   2. SQLite                                  │",
  ],
  auth: ["Not signed in"],
  quota: ["You've hit your usage limit. Upgrade to Plus to continue."],
} as const;

describe("agent screen annotations", () => {
  it.each([
    ["1 shell", 1],
    ["2 shells", 2],
    ["1 monitor", 1],
    ["3 monitors", 3],
    ["1 team", 1],
    ["2 teams", 2],
    ["1 local agent", 1],
    ["4 local agents", 4],
  ])("extracts the Claude footer task chip %s", (summary, count) => {
    expect(
      extractAgentScreenAnnotations("claude", [
        "⏺ Finished the foreground turn",
        "> ",
        `  ⏵⏵ auto mode on · ${summary} · ← for agents`,
      ]),
    ).toEqual({ background: { count, summary } });
  });

  it("sums comma-joined task groups and shares box normalization", () => {
    expect(
      extractAgentScreenAnnotations("claude", [
        "│ >                                            │",
        "│ ⏵⏵ auto mode on · 2 shells, 1 monitor, 3 local agents · ← for agents │",
      ]),
    ).toEqual({
      background: {
        count: 6,
        summary: "2 shells, 1 monitor, 3 local agents",
      },
    });
  });

  it("never treats scrollback, prose, drafts, or an obscured footer as live work", () => {
    for (const lines of [
      ["✻ Churned for 3m 12s · 1 shell still running"],
      ["I found 2 shells and 1 local agent in the test fixtures."],
      ["> kill the 2 shells please"],
      [
        "⏵⏵ auto mode on · 1 shell · ← for agents",
        "Bash command",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
      ],
    ]) {
      expect(extractAgentScreenAnnotations("claude", lines)).toEqual({});
    }
  });

  it("has no Codex annotation rules", () => {
    expect(
      extractAgentScreenAnnotations("codex", [
        "⏵⏵ auto mode on · 2 shells · ← for agents",
      ]),
    ).toEqual({});
  });
});

describe("agent screen profiles", () => {
  it("recognizes a framed Claude composer, empty or holding a draft", () => {
    expect(classifyAgentScreen("claude", claude.idle)).toMatchObject({
      lifecycle: "idle",
      matchedRule: "claude.idle",
    });
    expect(classifyAgentScreen("claude", claude.idleWithDraft)).toMatchObject({
      lifecycle: "idle",
      matchedRule: "claude.idle",
    });
  });

  it("recognizes a framed Codex composer, empty or holding a draft", () => {
    expect(classifyAgentScreen("codex", codex.idle)).toMatchObject({
      lifecycle: "idle",
      matchedRule: "codex.idle",
    });
    expect(classifyAgentScreen("codex", codex.idleWithDraft)).toMatchObject({
      lifecycle: "idle",
      matchedRule: "codex.idle",
    });
  });

  it("reads Claude's footer interrupt hint below the composer as work", () => {
    expect(classifyAgentScreen("claude", claude.working)).toMatchObject({
      lifecycle: "working",
      matchedRule: "claude.working.interrupt",
    });
  });

  it("reads a Claude spinner frame as work without enumerating its verbs", () => {
    for (const verb of ["Percolating", "Boondoggling", "Clauding", "Thinking"]) {
      expect(
        classifyAgentScreen("claude", [`✻ ${verb}… (4s · ↓ 210 tokens)`]),
      ).toMatchObject({ lifecycle: "working", matchedRule: "claude.working.spinner" });
    }
    for (const glyph of ["✢", "✳", "✶", "✻", "✽"]) {
      expect(classifyAgentScreen("claude", [`${glyph} Vibing…`]).lifecycle)
        .toBe("working");
    }
  });

  it("reads Codex's parenthesized interrupt hint as work", () => {
    expect(classifyAgentScreen("codex", codex.working)).toMatchObject({
      lifecycle: "working",
      matchedRule: "codex.working",
    });
  });

  it("recognizes a framed Claude permission dialog by its option labels", () => {
    expect(classifyAgentScreen("claude", claude.permission)).toMatchObject({
      lifecycle: "blocked",
      reason: "permission",
      matchedRule: "claude.permission",
      strong: true,
    });
  });

  it("recognizes Claude plan-mode approval", () => {
    expect(classifyAgentScreen("claude", claude.plan)).toMatchObject({
      lifecycle: "blocked",
      reason: "permission",
      strong: true,
    });
    expect(classifyAgentScreen("claude", ["Ready to code?"]).matchedRule)
      .toBe("claude.plan");
  });

  it("recognizes Claude's composite question navigation hint", () => {
    expect(classifyAgentScreen("claude", claude.question)).toMatchObject({
      lifecycle: "blocked",
      reason: "question",
      matchedRule: "claude.question",
      strong: true,
    });
    for (const line of [
      "↑/↓ to navigate · Enter to select · ←/→ to switch · Esc to cancel",
      "Ready to submit your answers?",
      "Submit answers",
      "You have not answered all questions",
    ]) {
      expect(classifyAgentScreen("claude", [line])).toMatchObject({
        lifecycle: "blocked",
        reason: "question",
      });
    }
  });

  it("recognizes a framed Codex approval dialog", () => {
    expect(classifyAgentScreen("codex", codex.permission)).toMatchObject({
      lifecycle: "blocked",
      reason: "permission",
      matchedRule: "codex.permission",
      strong: true,
    });
    for (const line of [
      "Do you want to approve network access to \"registry.npmjs.org\"?",
      "1. Yes, proceed",
      "2. Yes, and allow this host for this conversation",
      "The build step needs your approval.",
    ]) {
      expect(classifyAgentScreen("codex", [line])).toMatchObject({
        lifecycle: "blocked",
        reason: "permission",
      });
    }
  });

  it("recognizes the Codex structured question overlay", () => {
    expect(classifyAgentScreen("codex", codex.question)).toMatchObject({
      lifecycle: "blocked",
      reason: "question",
      matchedRule: "codex.question",
      strong: true,
    });
    for (const line of [
      "Type your answer (optional) | Add notes",
      "Submit with unanswered questions?",
      "Answer required fields before submitting.",
    ]) {
      expect(classifyAgentScreen("codex", [line]).reason).toBe("question");
    }
  });

  it("recognizes authentication and quota lines the CLIs own", () => {
    expect(classifyAgentScreen("claude", claude.auth)).toMatchObject({
      lifecycle: "blocked",
      reason: "auth",
      strong: false,
    });
    expect(classifyAgentScreen("codex", codex.auth).reason).toBe("auth");
    expect(classifyAgentScreen("claude", claude.quota).reason).toBe("quota");
    expect(classifyAgentScreen("codex", codex.quota).reason).toBe("quota");
  });

  it("recognizes only Claude's own API error line", () => {
    expect(classifyAgentScreen("claude", claude.error)).toMatchObject({
      lifecycle: "blocked",
      reason: "error",
      strong: false,
    });
  });
});

describe("evidence recency", () => {
  it("lets a newer idle composer supersede an older blocked dialog", () => {
    expect(
      classifyAgentScreen("claude", [
        "Do you want to proceed?",
        "  2. Yes, allow all edits during this session",
        "⏺ Removed build/",
        "│ >  │",
      ]),
    ).toMatchObject({ lifecycle: "idle", matchedRule: "claude.idle" });
  });

  it("lets newer working evidence supersede a stale approval overlay", () => {
    expect(
      classifyAgentScreen("codex", [
        "1. Yes, just this once",
        "command accepted",
        "• Working (1s · Esc to interrupt)",
      ]),
    ).toMatchObject({ lifecycle: "working", matchedRule: "codex.working" });
  });

  it("prefers a newer idle line even when an older rule has the wider window", () => {
    // claude.working.spinner reaches 10 lines back and claude.idle only 5, so
    // an outside-in scan would have let the older spinner win.
    expect(
      classifyAgentScreen("claude", [
        "✻ Simmering… (30s)",
        "⏺ Wrote src/lib/path.ts",
        "⏺ Wrote src/lib/fuzzy.ts",
        "│ >  │",
      ]),
    ).toMatchObject({ lifecycle: "idle" });
  });

  it("prefers strong evidence over weak evidence on the same line", () => {
    expect(classifyAgentScreen("claude", ["❯ 1. Yes, allow all edits"]))
      .toMatchObject({ strong: true, reason: "permission" });
  });

  it("ignores evidence older than its rule's window", () => {
    expect(
      classifyAgentScreen("claude", [
        "API Error: 500 internal error",
        ...Array.from({ length: 6 }, (_, i) => `⏺ step ${i}`),
      ]).lifecycle,
    ).toBe("unknown");
  });
});

describe("routine terminal output is never blocked or working", () => {
  it("ignores test-runner and compiler failures", () => {
    for (const lines of [
      ["FAIL  src/lib/status.test.ts > statusPaths", "Error: expected 3 to be 4"],
      ["error[E0502]: cannot borrow `self` as mutable more than once"],
      ["error: cannot borrow immutable local variable"],
      ["  ✗ 2 tests failed", "Error: Command failed with exit code 1."],
      ["fatal: not a git repository", "connection failed"],
    ]) {
      for (const kind of ["claude", "codex"] as const) {
        expect(classifyAgentScreen(kind, lines)).toEqual({
          lifecycle: "unknown",
          strong: false,
        });
      }
    }
  });

  it("ignores this repository's own source when it is printed to the terminal", () => {
    const source = [
      "// Claude renders the spinner frame set followed by a randomized gerund;",
      "// the footer hint row sits below the composer.",
      "    { id: \"claude.working.interrupt\", lifecycle: \"working\", tailLines: 6,",
      "      pattern: /(?:^|·\\s*)esc to interrupt(?=$|[\\s·)])/i },",
      "    { id: \"codex.working\", lifecycle: \"working\", tailLines: 8,",
      "      pattern: /\\((?:[^()]{0,24}\\s)?(?:esc|ctrl\\+c) to interrupt\\)/i },",
    ];
    for (const kind of ["claude", "codex"] as const) {
      expect(classifyAgentScreen(kind, source).lifecycle).toBe("unknown");
    }
  });

  it("ignores prose about sign-in, limits, and approvals", () => {
    for (const [kind, line] of [
      ["claude", "The deploy user is not logged in to the registry yet."],
      ["claude", "Document the API rate limit and retry policy."],
      ["claude", "The concentration limit reached 10% yesterday."],
      ["claude", "Would you like me to implement the next improvement?"],
      ["codex", "The CI account is not signed in, so the job was skipped."],
      ["codex", "Authentication required for remote settings is a warning, not an error."],
      ["codex", "Would you like to run the tests next?"],
    ] as const) {
      expect(classifyAgentScreen(kind, [line])).toEqual({
        lifecycle: "unknown",
        strong: false,
      });
    }
  });

  it("treats a queued prompt echoed into the composer as idle, not working", () => {
    expect(
      classifyAgentScreen("claude", [
        "╭──────────────────────────────────────────────╮",
        "│ > add esc to interrupt handling to the dock  │",
        "╰──────────────────────────────────────────────╯",
      ]),
    ).toMatchObject({ lifecycle: "idle", matchedRule: "claude.idle" });
  });

  it("classifies ordinary shells, exits, and unsupported screens as unknown", () => {
    for (const lines of [
      ["kevin@mac repo %"],
      ["logout", "[process exited with code 0]"],
      ["~", "~", "~"],
      [],
    ]) {
      expect(classifyAgentScreen("codex", lines).lifecycle).toBe("unknown");
    }
  });
});

describe("tail preparation inside classification", () => {
  it("sees through trailing blank rows on a short screen", () => {
    expect(
      classifyAgentScreen("claude", [
        "│ >  │",
        ...Array.from({ length: 20 }, () => ""),
      ]),
    ).toMatchObject({ lifecycle: "idle" });
  });

  it("bounds snapshots to 40 logical lines and 16,384 characters", () => {
    const tail = boundedLogicalTail(Array.from({ length: 80 }, (_, i) => `${i}:${"x".repeat(600)}`));
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(16 * 1024);
    expect(tail.at(-1)?.startsWith("79:")).toBe(true);
  });
});
