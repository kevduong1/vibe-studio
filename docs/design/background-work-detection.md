# Background-work detection for agent sessions

Status: **implemented on main on 2026-08-18; manual GUI layout verification
remains.** The design was written from a review of the installed CLIs (Claude
Code homebrew build authored-as 2.1.233 profile era, Codex CLI 0.147.0), with
the footer behavior subsequently confirmed by a live Claude Code 2.1.235
capture.

## Problem

A Claude Code session that starts a background task (background Bash, a
Monitor, a subagent/teammate) and then returns to its composer classifies as
**Idle** in our pipeline — which is semantically true (it accepts input) but
hides that work is still in flight. Example: `Bash(sleep 600 && …)` →
"Running in the background" → Claude prints its turn summary and idles for ten
minutes while the shell runs. The user looking at Agent Sessions sees a quiet
Idle row and has no way to tell it apart from a genuinely finished session.

Codex does not have this problem: while it waits on a background terminal it
keeps its working presentation on screen, so it already classifies as Working.

Goal: detect Claude's background shells / monitors / subagents / teammate
teams, carry that as session state, and surface it in Agent Sessions — without
disturbing any existing lifecycle semantics.

## Verified evidence (what the binaries actually render)

The noun grammar below was extracted from the shipped binaries' strings. The
shell footer, stale turn summary, working/idle repaint, `←` agents glyph, and
subagent footer behavior were also captured live on Claude Code 2.1.235.

### Claude Code

Two on-screen signals exist. **Only the footer is usable.**

1. **Turn-summary scrollback line** — `✳ Worked for 17s · 1 shell still
   running`. Composed as
   `` `${verb} for ${duration}` `` plus a conditional
   `` ` · ${summary} still running` `` (the `·` is U+00B7). Two disqualifying
   gotchas, both confirmed in the binary:
   - The verb is **randomized** from a large list ("Worked", "Churned",
     "Cogitated", "Cooked", "Crunched", "Sautéed", …). Never anchor a rule on
     "Worked".
   - The line is **scrollback, not status UI**: it persists verbatim after the
     background task completes. A rule matching it would keep reporting
     background work forever (and our newest-line-wins scan would keep finding
     it above older content). It must never be evidence. At most it could be
     used defensively in tests as a must-NOT-match fixture.

2. **Footer status line** — live-captured as
   `⏵⏵ auto mode on · 1 shell · ← for agents`.
   This is live-repainted status UI: the count chip disappears on the next
   repaint after the task finishes, and the row sits **below the composer**,
   i.e. nearest the tail — so in our newest-to-oldest scan order it is
   examined before the composer's idle marker. This is the signal to use.

   The count chip is produced by a single summary composer (found as `mBt` in
   the minified build) with these exact pluralized forms, comma-joined when a
   group has multiple task types:
   - `1 shell` / `N shells` (background Bash; monitors are split out)
   - `1 monitor` / `N monitors`
   - `1 team` / `N teams` (in-process teammates, deduped by team name)
   - `1 local agent` / `N local agents` (subagents)
   - remote-agent variants exist too (including ultraplan phase labels); treat
     any unrecognized noun before "still running"/inside the footer as opaque
     rather than enumerating them.

   The same composer output feeds both the footer chip and the turn-summary
   suffix — one noun grammar to match in both places (though only the footer
   is trusted).

   A separate footer chip covers **backgrounded agent sessions** (the
   left-arrow agents view): `← for agents` when none, `← N agents` while
   running (count capped at `99+`), `← N done` when finished. Its arrow glyph
   is a variable in the build (rendered as `←`/`⇐` depending on version);
   the live 2.1.235 capture used `←`. This separate chip remains out of scope:
   a background local subagent rendered `/tasks to see subagents · ← for agents`
   rather than a stable running count in that build.

### Codex

- While waiting on a background terminal, the TUI shows a working status
  ("Waiting for background terminal" + the interrupt hint) — already matched
  by the existing `codex.working` rule. The user-visible symptom "Codex thinks
  it's working" is thus *correct* classification; no change needed.
- No idle-footer background-terminal count exists in the binary. All other
  background-terminal strings ("No background terminals running.", "Stopping
  all background terminals.", "Waited for background terminal: …",
  "Interacted with background terminal: …") are command/tool outputs, i.e.
  agent-adjacent prose our rule discipline forbids matching (complete
  app-owned UI phrases only, never text that can appear in ordinary output).
- Conclusion: **no Codex rules in this feature.** If a future Codex version
  idles while a background terminal runs, revisit with a live capture.

### Process-table detection — rejected as authority

`pty_agent_process_snapshot` (src-tauri/src/pty.rs) already runs one
aggregated `ps -axo pid=,ppid=,pgid=,comm=` and BFS-walks **every** descendant
of each PTY shell; it merely filters the report down to registered agent
executables. Reporting "this agent process has non-agent descendants" would be
nearly free (same ps output, same walk). But it cannot be evidence:

- The snapshot is privacy-bounded to `comm=` — arguments and environments are
  never read. With basenames only, a background `node` dev server is
  indistinguishable from an MCP server child, and any session with MCP servers
  configured has permanent non-agent children. Every such session would read
  as "background work" forever.
- Start-time heuristics (children spawned after session launch) are fragile:
  MCP servers can restart mid-session, and `ps` start-time adds parsing
  surface for a weak signal.

Verdict: screen evidence is the only trustworthy source. A descendant-count
field is at most **phase 2 corroboration** (see below) — it may help *expire*
a screen-derived flag, never create one.

## Design: an annotation, not a fifth lifecycle

An agent with background work **is idle** for every semantic consumer we have:

- The prompt queue may safely dispatch to it (the composer is empty and
  focused; sending a prompt while a background shell runs is exactly what the
  CLI supports).
- Blocked/Done derivation must keep working unchanged: when the background
  task finishes, Claude is notified, starts a turn (working), and lands back
  on idle — the existing per-generation work-stretch flag then produces unseen
  **Done** correctly. A new lifecycle value would have to re-answer every one
  of those questions (blocked retention, queue settlement, alert edges,
  rollup, checkpoint gating) for zero benefit.

So: `AgentLifecycle` stays exactly `working | blocked | idle | unknown`, and
background work becomes an **orthogonal annotation** on the runtime state,
generation-pinned like everything else.

### Data model

`src/lib/agentState.ts`:

```ts
export interface AgentBackgroundWork {
  /** Total running background tasks parsed from the footer chip. */
  count: number;
  /** The CLI's own comma-joined summary, verbatim ("2 shells, 1 monitor"). */
  summary: string;
}

export interface AgentRuntimeState {
  // ...existing fields...
  /** Present while the CLI's footer advertises running background tasks.
   * Orthogonal to lifecycle: an idle agent with background work is still
   * idle for input purposes. Never persisted. */
  background?: AgentBackgroundWork;
}
```

`AgentDisplayState` is **unchanged**. Chrome that wants to present the
combination reads `display === "idle" && state.background` (and may also show
the chip alongside `working` — Claude shows the footer chip during a turn
too, which is fine and still true).

### Detection (`src/lib/agentProfiles.ts`)

Add a second, independent scan — **not** new entries in the lifecycle rule
list:

```ts
export interface AgentScreenAnnotations {
  background?: AgentBackgroundWork;
}

export function extractAgentScreenAnnotations(
  kind: AgentKind,
  logicalLines: readonly string[],
  normalized = false,
): AgentScreenAnnotations;
```

Rationale for a separate pass:

- `classifyAgentScreen` stops at the first line any rule matches (recency
  wins). An annotation rule inside that list would either shadow the idle
  composer or be shadowed by it, and would spend one of the small bounded
  `tailLines` windows either way.
- Annotations and lifecycle answer different questions and may both be true on
  the same screen.

Scan shape: normalize (shared `normalizeAgentScreenLines`), then examine only
the last **3–4** logical lines (the footer region; the composer sits directly
above it, and anything above the composer is scrollback — this bound is what
structurally excludes the poisonous "still running" scrollback line). Claude
only; the Codex extractor returns `{}`.

Pattern, authored after the live shell capture:

```ts
// Matches the footer's task-count chip: a middot-delimited segment of one or
// more comma-joined "<n> <noun>" groups. Nouns are the composer's exact
// pluralized forms; the count sums the numbers.
const CLAUDE_FOOTER_TASKS =
  /(?:^|·\s*)(\d+\s+(?:shells?|monitors?|teams?|local agents?)(?:,\s*\d+\s+(?:shells?|monitors?|teams?|local agents?))*)(?=\s*·|\s*$)/;
```

Must-not-match fixtures for the test suite:

- `✻ Churned for 3m 12s · 1 shell still running` (scrollback summary — the
  `still running` suffix and its position above the composer keep it out; the
  3–4-line bound is the structural guard, and the regex's segment-boundary
  lookahead `(?=\s*·|\s*$)` fails on ` still` as a belt-and-suspenders check).
- Agent prose containing "2 shells" or "1 local agent" mid-transcript (bound
  excludes it; also never on the footer line shape).
- A composer draft the user typed: `> kill the 2 shells please` (the composer
  line starts with the marker glyph; require the middot-delimited segment
  shape, and the draft sits above the footer anyway).
- Dialogs covering the footer (permission prompt overlays): the footer is not
  in the last lines → annotation simply not observed that frame; retention
  (below) carries it.

Bump `CLAUDE_PROFILE.version` to 4 and record the 2.1.235 background-footer
capture in its `authoredFor` provenance.

### Runtime integration (`src/stores/agentRuntime.ts`, `src/lib/termSession.ts`)

`termSession.ts` `inspectSemanticScreen()` already computes the logical tail
once; call `extractAgentScreenAnnotations` on the same normalized tail and
pass the result through the debounced landing:

```ts
applyAgentScreen(id, generation, classification, watched, annotations);
```

Rules inside `applyAgentScreen` / the fallback paths:

- **Set/refresh** `background` only from a **conclusive** screen read
  (lifecycle `idle` or `working` verdicts — the frames where the footer is
  actually legible). Store the parsed `{count, summary}`; replace on change so
  "2 shells" → "1 shell" updates live.
- **Retain** through `unknown`/inconclusive reads and through the
  Claude-ambiguous-idle branch (the one where `signal?.busy` overrides the
  composer): a clipped or overlaid pane hides the footer without ending the
  work — mirroring the blocked-retention discipline.
- **Clear** when:
  - a conclusive `idle` or `working` read has **no** footer chip (the CLI
    repainted without it → tasks finished), or
  - occupancy leaves `present` (exit/replacement), or
  - the generation changes (new occupant) — both fall out of the existing
    generation guards if `background` lives in the state object that
    `replaceState` swaps wholesale; audit `lifecyclePatch`/`changed` so the
    annotation is carried or cleared *explicitly* in every patch site rather
    than accidentally dropped (a `changed()` comparison must also treat a
    background change as a real change, or the store won't publish it).
- The one-second ambient reconcile and activity fallback paths never touch
  `background` (they have no screen evidence either way).
- Equality: compare by `count + summary` string to keep reference stability;
  build the patch object only when something actually changed (zustand
  selector discipline).

Nothing in blocked/Done/queue logic reads the annotation. Explicit
non-interactions to assert in tests:

- Unseen-Done still fires after background work completes and the follow-up
  turn ends unseen.
- Prompt-queue settlement (`promptTurnSettledByScreen`) ignores annotations.
- `agentAlertAction` edges are computed from display state only — an
  annotation change is never an alert edge (no banner for "background work
  started/finished"; Done covers the finish).

### Surfacing

- **`agentState.ts` labels/tooltips** — tooltip gains a line while present:
  `Background: 1 shell` (use the CLI's own summary verbatim). Row subtitle for
  idle-with-background: `Idle · 1 shell running`.
- **Agent Sessions** (`useAgentSessionItems.ts` / `AgentSessionsPanel.tsx`) —
  a small chip on the row while `background` is present (same treatment as
  existing lifecycle/review/check chips; theme tokens only). The row stays in
  its normal section: this is *not* attention (nothing needs the user).
- **Rollup ordering** — `ROLLUP_PRIORITY` and `AgentRollup` unchanged.
  Optional cosmetic tie-break where rows are sorted: idle-with-background
  sorts above plain idle. Do not surface it as `working` anywhere — a rollup
  that says Working implies "don't type here yet", which is false.
- **Notifications** — none. No new banner types.

### Persistence

Like all runtime evidence, `background` is ephemeral and never written to
localStorage. The Rust control-plane semantic snapshot carries it as read-only
semantic state: only the count and CLI-authored noun summary cross that
boundary, never command text. Document in
`docs/architecture/agent-control.md`.

## Phase 2 (optional, not part of this change): process corroboration

Extend `pty_agent_process_snapshot`'s per-agent info with
`hasNonAgentDescendants: boolean` (same ps table, extend the BFS bookkeeping;
serde camelCase; ipc.ts type update). Use it **only** to expire a stale
screen-derived `background` annotation: if the flag has been false for N
consecutive polls while `background` is retained through inconclusive reads
(e.g. the pane is permanently covered by a dialog), clear the annotation.
Never set the annotation from it (MCP-server false positives, documented
above). This is cheap but likely unnecessary — ship phase 1 and see whether
stale retention occurs in practice.

## Test coverage

Vitest, pure-logic (per the project's testing posture):

- `agentProfiles` extractor: footer fixtures for each noun form and
  comma-joined combinations; all must-not-match fixtures above; normalization
  interplay (box frames don't appear in Claude's footer, but the shared
  normalizer runs anyway).
- `agentRuntime`: set/retain/clear matrix — conclusive-with-chip,
  inconclusive retains, conclusive-without-chip clears, busy-override branch
  retains, generation change clears, occupancy mask retains-then-restores
  without a spurious publish.
- Non-interaction: unseen-Done and alert-edge tests with `background` present
  proving identical outcomes to today.
- `agentState`: tooltip/label composition.

## Implementation record

1. Live capture — **done** (Claude Code 2.1.235): background shell through
   working and idle footer repaints, the stale `still running` summary, the
   `←` glyph, and a local-subagent run. Monitor/team noun variants remain
   binary-verified fixtures; the shared middot-delimited chip shape was
   captured live.
2. `agentProfiles` extractor + tests — **done**.
3. Thread annotations through `termSession` → `agentRuntime` + tests — **done**.
4. Surface state labels, dock badges, diagnostics, and the Agent Sessions
   chip — **done**.
5. Same-change documentation — **done**: CLAUDE.md architecture-map rows for
   `agentProfiles.ts` / `agentRuntime.ts` / `agentState.ts`,
   `docs/architecture/agent-runtime.md` (annotation channel + retention
   rules), README/roadmap, and control-plane documentation.
6. Manual GUI layout verification remains Kevin's.

## Non-goals

- No new `AgentLifecycle` value; no change to blocked/Done/queue semantics.
- No Codex rules (its working state already covers the scenario truthfully).
- No parsing of the turn-summary scrollback line, ever.
- No process-tree-derived *positive* detection (privacy bound makes it
  indistinguishable from MCP/helper children).
- No notifications for background-work edges.
