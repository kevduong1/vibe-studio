# Semantic agent runtime

This document is the source of truth for Talos' semantic state for
Claude and Codex processes. It covers dedicated agent tabs and agents
discovered in plain shell tabs in both terminal docks.

## Scope

Talos distinguishes the requested tab kind from the process currently
inside it. A tab created for Claude may contain Claude or Codex, may be starting
Claude, or may have returned to an ordinary shell after either agent exits.
Its saved icon remains Claude because that is its launch/default identity;
semantic classification and generation ownership follow the detected process.
Plain shell tabs have no requested identity and acquire a dynamic
Claude/Codex identity only while an exact supported executable is their PTY
descendant.

Runtime state is ephemeral. Global tab metadata and layouts persist, but PTYs
and semantic state do not. After an app restart, restored agent tabs open as
fresh shells and correctly show **No Agent** until an agent is launched.

## State model

`src/lib/agentState.ts` defines the public model:

- `occupancy`: `absent | starting | present | exited | unknown`
- `requestedKind`: the dedicated tab's stable launch identity, or `null` for a
  discovery-only shell
- `kind`: the detected occupant profile while present/masked, otherwise the
  requested fallback for a dedicated tab
- `lifecycle`: `working | blocked | idle | unknown`
- `seen`: whether the current blocked/completed state has been viewed
- `authority`: `screen | osc | activity`
- optional structured `reason` and diagnostic `matchedRule`
- `generation`: incremented when an agent appears or its PID/detected kind
  changes

Presentation is derived, never stored. In particular, **Done** means a present
agent is `lifecycle === "idle"` with `seen === false`; the store (below) only
ever sets `seen: false` on that idle transition when a work stretch actually
ran, so by the time this pure derivation sees it, Done already excludes idle
reached without background work. The display states are `starting`, `working`,
`blocked`, `done`, `idle`, `unknown`, and `absent`. Blocked outranks the
`starting`/launch-grace occupancy: an agent that asks for permission before its
PID has even been captured still displays as blocked rather than Working, so
the prompt and its alert are never hidden. Done is therefore a
turn-completion/attention state, not a judgment about the meaning of the final
response: an agent can finish a turn with a conversational question and still
be Done. **Needs Input** is reserved for explicit structured question/permission
UI or a notification signal, where the terminal provides stronger evidence
than arbitrary response prose.

`src/stores/agentRuntime.ts` is the one global ephemeral store. It includes
both terminal scopes, so workspace and related-workspace rollups see project
and global agent tabs. A global grouping rollup is restricted to terminal IDs
owned by that grouping.

## Occupancy authority

On macOS, the frontend runs one shared one-second monitor while any dedicated
or discovery-enabled shell tabs are registered. One
`pty_agent_process_snapshot` IPC call covers all non-exited registered terminal
IDs. The Rust backend:

1. Reads each PTY's shell PID and foreground process group.
2. Runs one `ps` snapshot.
3. Groups descendants under the correct shell.
4. Matches exact executable basenames from the typed Claude/Codex profiles and
   every valid custom definition. All semantic terminals receive the same
   registry, regardless of their requested tab kind.
5. Returns only PID, parent/root matching-agent PIDs, executable basename, and
   foreground membership—never arguments or environment.

A successful query with no match means `absent`, unless the terminal is still
inside its launch grace (below), in which case it stays `starting` — the grace
already owns that window and a masked `unknown` would only spend it early. A
query failure on an otherwise-present occupant means `unknown`; proven
`absent`, `starting`, and `exited` states remain unchanged, so an unavailable
query cannot manufacture an Idle rollup for an empty terminal. The runtime
retains the last-known PID,
generation, child-process rows, and lifecycle evidence while the query
authority is unavailable. This masking/unmasking of `occupancy` is bookkeeping,
not a semantic change, so it deliberately never restamps `changedAt` — doing so
would reorder Agent Sessions' waiting age and restart age-based graces for no real
transition. Rediscovering that same PID restores the existing occupant without
replacing its generation and immediately reclassifies the bounded screen tail,
including output parsed during the outage. A process result that was already
in flight cannot overwrite the stronger fact that the owning PTY exited. The
`ps` child is bounded to two seconds, drained concurrently, and killed/reaped
on timeout so the frontend poll guard always recovers. Unsupported platforms
return the same query-failure path and retain last-known occupancy. The
process-table parser treats
the complete final `comm` column as the executable path, including spaces.
Generation checks reject delayed screen results from a previous agent
occupant.

The detection registry always retains canonical Claude/Codex mappings. A
custom definition contributes the basename of its configured executable and
maps it to the definition's screen profile. Duplicate custom names using the
same profile coalesce. A custom name assigned to both profiles is excluded;
a custom definition that contradicts a canonical name is rejected while the
canonical mapping remains active. Integrations and the launch sheet surface
these conflicts instead of guessing.

Fresh launches call `markAgentLaunching()` before typing `claude` or
`codex --yolo` into the shell, which gives the tab up to 4 s (measured from the
launch call itself, not from `changedAt`) to reach exec before a clean
no-match snapshot may declare it an ordinary shell — bookkeeping updates and
query outages during that window must not shorten it. Dedicated Codex tabs
deliberately default to `--yolo` in both docks so they start fully autonomous.
Built-in Codex invocations also receive a launch-scoped
`tui.terminal_title = ["activity", "thread-title", "task-progress"]` override.
It makes Talos-owned topics deterministic without rewriting the user's global
Codex configuration; custom definitions and agents launched manually in a
shell retain their own title configuration.
The launch sheet exposes explicit permission/sandbox choices but preserves
this initial default unless the product decision changes explicitly.

## Lifecycle authorities

After xterm parses output, `termSession.ts` reads at most the bottom 40 logical
lines and 16,384 characters from the active normal or alternate-screen buffer.
The bound is applied AFTER normalization (below), not to raw physical rows:
normalizing first means the 40/16,384 caps count evidence lines, not box
borders and blank filler the classifier would immediately discard — applying
the bound to raw rows would let frame chrome spend the caller's budget and
push real evidence out of the window.

`src/lib/agentProfiles.ts` contains independently authored profiles for Claude
Code 2.1.233 (schema version 3) and Codex CLI 0.147.0 (schema version 4),
including their structured multi-question overlays. Every profile declares a
schema version and authored-for CLI version; Settings exposes rule counts and
current privacy-bounded match diagnostics.

Before rules run, the tail is normalized in two passes: wrapped physical rows
are joined into logical lines and trailing blank rows are trimmed
(`logicalLinesFromRows` in `termSession.ts`), then box-drawn frame edges are
stripped from each line and pure horizontal-rule lines are dropped entirely
(`normalizeAgentScreenLines` in `agentProfiles.ts`, idempotent —
`classifyAgentScreen` applies it again for free on tails a caller already
prepared). Only the resulting lines are matched against rules.

The scan walks the bounded tail newest line to oldest and stops at the first
line any eligible rule matches (a rule is eligible once the line's depth from
the bottom is within its own `tailLines` window) — recency wins across rule
classes, so newer working or idle UI always invalidates stale blocked text
above it, and there is no global priority ordering between blocked/working/idle
across different lines. Priority resolves only a same-line tie, where more than
one rule matches the same line: the strongest match wins, and among matches of
equal strength the first one in the profile's declared rule order wins. Strong
permission/question matches are anchored to complete CLI-owned action labels,
navigation hints, or form controls and apply immediately (no debounce). Blocked
rules match complete, CLI-owned UI phrases rather than isolated domain words.

Ordinary (non-strong) changes are debounced, and idle requires stable
evidence. The debounce is bounded per pending **lifecycle episode**
(`` `${generation}:${lifecycle}` ``), not per matched rule: two rules that
alternate while describing the same lifecycle — a spinner frame and a footer
hint, say — share one stability window instead of each restarting it, capped
at an 800 ms maximum so churn between rule variants cannot postpone landing
forever. A genuine lifecycle change still gets its own full window.
Arbitrary response prose in the bounded tail must not acquire screen authority
merely because it asks a conversational question or discusses concepts such as
quotas or rate limits.

Each occupant generation also has a screen boundary
(`semanticBoundaryFirstLine`). App-initiated launches place it before the
launch command so startup UI remains eligible; unannounced process discovery
and PID replacement establish it at discovery and wait for new output. Old
xterm scrollback is never promoted into a new generation. Activity fallback
observed during startup is retained across the first PID capture, while
screen evidence is reclassified inside the new boundary.

The boundary means something different per buffer. On the normal buffer, the
cursor row is the wrong anchor — both CLIs redraw a bottom-anchored frame, so
rows below the cursor would survive a reset as stale evidence while rows a
repaint rewrites above it would be wrongly excluded. Instead the boundary
anchors on end-of-content minus one full viewport: a TUI repaint can only
rewrite rows currently on screen, so anything further back than one viewport
above the end of content is true scrollback that can never become the new
generation's evidence. The alternate screen has no scrollback and Codex
repaints the whole viewport every frame, so a row anchor is meaningless there:
the boundary is line 0 (the whole viewport is eligible), and stability comes
from the classification debounce instead. A prompt dispatch (user Enter or a
programmatic `sendPrompt`) resets the boundary the same way a launch does, so
older scrollback can never satisfy a new turn.

Unambiguous screen evidence has priority, but only while it is fresh. Claude's
composer is one deliberate exception: Claude keeps the same otherwise-idle
composer painted throughout a turn, so a confirmed sustained-output stretch
immediately outranks an `idle` composer verdict. Repaints of that composer
cannot renew idle screen authority until output stops. This restores the
generic activity behavior when the working footer is clipped, customized, or
temporarily absent without weakening structured prompts. When screen evidence
disappears (an inconclusive/`unknown` read), the runtime also falls back to the
activity tracker immediately:

- sustained normal- or alternate-screen output → `working` with `activity`
  authority (the latter covers Codex; process-authoritative occupancy prevents
  ordinary alternate-screen TUIs in shell tabs from surfacing as agents);
- BEL/OSC notification → `blocked` with `osc` authority;
- a confirmed busy stretch whose quiet survived the tracker's grace →
  `completed`, which the store turns into idle (and, if the stretch ran
  unwatched, unseen **Done**) regardless of the stretch's length or whether it
  also earned a ping.

A non-blocked screen verdict that stops being reproduced also yields to
contradicting activity evidence once it is more than ~15 s old; the ambiguous
idle-composer/busy-output conflict above yields immediately. A 1 Hz ambient
reconcile on the shared poll tick (`reconcileAgentEvidence`) re-checks every
screen-authority terminal's staleness so a hung tool call or a spinner frame
that stops redrawing cannot pin `working` forever against a tracker that
already observed the turn end. Blocked never expires this way — the 15 s bound
does not apply to it — because only *newer terminal evidence* proves a prompt
is gone, never the passage of time. Blocked state is not cleared merely by
viewing it: viewing acknowledges and dismisses its alert (clearing only the
activity tracker's `attention` ping, never its `completed` turn-boundary
signal — see below) without touching lifecycle. The occupant exiting or being
replaced by a new PID unconditionally resets lifecycle to `unknown` under a
fresh generation, independent of everything below.

The activity fallback's own priority, inside `fallbackFor`, is: a `busy`
signal wins unconditionally, checked before anything else and regardless of
the current lifecycle or authority; only then does a still-latched
notification or a `completed` turn boundary get considered. So resumed work
always clears blocked once the fallback path actually runs — including a
**screen**-authority blocked prompt, but only indirectly: `applyAgentActivity`
itself declines to touch a fresh screen-authority blocked state (screen
priority holds), yet it still records the incoming signal; the clear happens
the next time the screen classifier itself reads back `unknown` (an
inconclusive read), at which point `applyAgentScreen` hands off to
`fallbackFor` unconditionally and finds the already-recorded `busy` signal
waiting. A still-latched **notification** (BEL/OSC 9/777) under an existing
prompt, by contrast, never overwrites it regardless of authority: it is
corroboration, not a second prompt, so it must not rewrite the prompt's
reason/rule (which would break the "same prompt" identity check and wrongly
re-alert something already acknowledged).

The `completed` turn-boundary signal is the one path that IS authority-gated:
it can only clear a prompt whose `authority === "osc"` — evidence that is
*only* the ring, with no corroborating screen read — and only when the
boundary was observed strictly *after* the ring that established the prompt
(`completionSeen`, a one-shot per-terminal set consumed on use). This is what
lets an agent that rings on completion, rather than rendering a static
prompt, settle back to idle instead of holding Needs Input for the rest of the
session. A **screen**-authority blocked prompt is never cleared by a
`completed` signal alone — only by resumed work (via the unknown-classification
handoff above) or a genuinely new screen classification. A boundary that
predates the ring, or that merely repeats an already-latched completion
(rising-edge only), does not count either way. Establishing a new prompt drops
any earlier unconsumed boundary, so a stale boundary from before the prompt
can never later be misread as evidence the prompt ended.

## Seen and acknowledgement

A pane is considered watched only when it is visible (`offsetParent !== null`)
**and** the application is foreground (`document.hasFocus()`). Each mounted
pane host (both docks) publishes this as a live predicate
(`setAgentPaneVisibility`); the 1 Hz ambient sweep in `reconcileAgentEvidence`
calls that predicate fresh off the DOM rather than trusting the watched flag
carried on the last activity signal, since a screen that has gone silent —
exactly the case the sweep exists to catch — is exactly when that cached value
is stalest. A terminal with no mounted pane host falls back to the last
signal's watched flag. Clicking/focusing a pane also acknowledges it, but
acknowledgement is narrower than it looks: it clears only the activity
tracker's `attention` ping, never its `completed` turn-boundary signal — the
turn-boundary bookkeeping above (`completionSeen`) depends on `completed`
surviving acknowledgement so a ring the user already dismissed can still later
prove an osc-authority prompt has ended. Unseen **Done** is derived from a per-
generation work-stretch flag, not from working→idle adjacency: the routine
path into a completed turn is working → unknown (one inconclusive screen
read) → idle, so adjacency alone would miss it, while an unanswered blocked
prompt going quiet, or idle reached fresh with no intervening work (a fresh
prompt right after launch), must settle to plain idle rather than announce a
turn that never ran. The important edges are:

- working → visible idle: idle, already seen;
- working → hidden/background idle: unseen **Done**;
- unseen Done → viewed: idle and seen;
- hidden blocked → viewed: blocked and seen (the alert dismisses; lifecycle
  does not change);
- agent process exits to shell: absent with lifecycle diagnostics cleared.

Acknowledgement is itself state-scoped, not global: an acknowledged blocked
prompt stays seen only while the *same* prompt keeps re-classifying (same
generation, reason, and matched rule — a redraw or a retained inconclusive
read). The alert edge is entering blocked-and-unseen from anything else,
including re-entry after acknowledgement, so a genuinely new prompt in the
same turn — or the same rule firing again after the lifecycle left blocked and
came back — alerts again.

Seen state is session-only and is never written to local storage.

## UI and rollups

Semantic status appears in existing terminal and application chrome. Each
dedicated agent's leaf tab keeps a persistent Claude or Codex identity icon;
the semantic state is a separate adjacent glyph, so transient state never
replaces agent identity:

| State | Adjacent state glyph |
|---|---|
| Starting / Working | Spinner |
| Needs Input | Warning dot |
| Unseen Done | Checkmark |
| Present idle / unknown | Persistent agent icon only |
| No Agent | Terminal icon |

Pane badges in both terminal docks add textual **Working**, **Needs Input**, or
**Done**, so status is not color-only, and append a cleaned OSC 0/2 topic when
one is available. Tooltips contain detected agent kind, requested tab default
when it differs, state, reason, authority, transition time, and matched rule
ID. Codex's terminal-title `activity` item continues to feed generic activity
detection, but presentation removes its braille spinner and blinking
action-required phases, configured run-state and project duplicates, and the
context-remaining/context-used meters and UUID fallback of an unnamed thread;
any nonredundant thread name, branch, model, or task metadata normally remains
visible. OSC title strings carry no field identity, so a user-authored value
that is itself an exact filtered run-state, context meter, or UUID is
intentionally treated as generated noise.
Claude's contextual title is retained verbatim. Titles are presentation-only
and never override process/screen lifecycle authority.
Workspace tabs, workspace families,
global grouping tabs, and the hidden-panel indicator roll up with priority:

`blocked > done > working (includes starting) > idle (includes unknown)`

`rollupAgentStates` skips `absent` states outright rather than ranking them at
the bottom, so a set containing only absent (or no) agents rolls up to `null`,
never a false `idle`. Chrome treats `null` as no badge — a terminal that never
held an agent must not present as a quiet one.

The activity rail's top, global section opens **Agent Sessions** over both
docks; workspace-scoped Explorer, Worktrees, Search, Source Control, and
Memories live below a divider. The view remains available with no workspace
open, preserves stable live-session sections, routes to the exact
workspace/group/tab/session, and projects review state beside (never into)
lifecycle state. Each row also resolves a large 80px pixel-art terrarium
through the pure `agentAvatars.ts` personality/state model and the
`AgentAvatar.tsx` Canvas renderer. Character identity is a pure function of the
project's current palette index and the *detected* runtime kind (not the tab's
requested/default kind), so changing a project's color updates visible rows
immediately:

| Project color | Claude | Codex |
|---|---|---|
| Blue (0) | Athena | Zeus |
| Purple (1) | Hera | Hades |
| Green (2) | Artemis | Demeter |
| Orange (3) | Hermes | Hephaestus |
| Pink (4) | Aphrodite | Aphrodite |
| Cyan (5) | Poseidon | Poseidon |
| Yellow (6) | Apollo | Apollo |
| Red (7) | Ares | Ares |

The derived display state selects a four-pose `starting`, `working`, `blocked`,
`done`, `idle`, or `unknown` stick-figure loop. Starting, blocked, done, idle,
and unknown own shared readable lifecycle postures—walking in, shrugging,
celebrating, sleeping, or inspecting a fault. Working is definition-owned:
each of the twelve deity personalities declares a unique activity and the
renderer supplies a matching pose, prop, and motion instead of a shared typing
pose or workstation. The shipped set is rose tending, lyre playing, sword
drill, archery, weaving, harvesting, summoning shades, smithing, a royal
peacock audience, courier running, tide calling, and storm calling. Greek
silhouettes such as a crown, crested helmet, laurel, robe, beard, or winged
helm keep identity visible throughout. Idle gods recline in identity-specific
resting places such as Zeus's cloud, Demeter's wheat, or Hades's underworld
rest. Scenes draw on a
40×40 integer pixel grid and scale to 80px with nearest-neighbor rendering.
Scene colors resolve from `theme.css` tokens, so changing the app palette
redraws the Canvas without embedding component-local colors. A single
module-level `requestAnimationFrame` clock serves only rows intersecting the
viewport, and each Canvas redraws only when its four-pose frame actually
changes; offscreen rows freeze on the state's descriptive pose.
Only an unseen blocked prompt adds a CSS attention-ring pulse, while an
acknowledged prompt keeps its waiting loop without the ring. `absent` draws an
empty, desaturated, slashed, non-animated terrarium next to the explicit **No
Agent** chip; it must never imply a live quiet agent. `prefers-reduced-motion`
freezes the most descriptive pose for the state and does not subscribe that
row to the animation clock. Avatar identity and state are exposed through
title/ARIA while the textual lifecycle chip remains the authoritative
non-visual presentation.

An attention filter and badge reuse the strict semantic ordering, while active
and quiet rows retain stable registration order. The titlebar shortcut and
⌘⇧I reveal this view; detailed review/check controls remain available through
its review action. Task ownership, review evidence, checks, and context-peek
privacy are specified in
[`attention-review.md`](attention-review.md).

The frontend synchronizes this same privacy-bounded semantic snapshot into
Rust for authenticated local automation. Rust does not reclassify terminal
text: it stores ordered changes to occupancy, lifecycle, generation, reason,
authority, and stable terminal/workspace identity. See
[`agent-control.md`](agent-control.md).

## Alerts

Notifications are opt-in per terminal. Global-tab toggles persist with global
tab metadata; project-tab toggles are ephemeral. One notification identifier
per terminal replaces repeated banners rather than stacking them.

Alerts fire once for a background transition into blocked and once when a
completed turn becomes unseen Done. They are dismissed on acknowledgement,
viewing Done, resumed work, agent exit, tab close, or notification disable.
Dismissal removes both pending requests and delivered banners, preventing an
asynchronously accepted request from appearing after its semantic state was
cleared. Per-terminal frontend ordering waits for Notification Center to accept
an add before a later dismissal is issued. Acceptance waits are bounded to five
seconds: timeout withdraws the request immediately, and the retained completion
handler removes it again if Notification Center accepts late, so neither the
blocking worker nor later per-terminal operations can hang indefinitely. A notification opt-in remains
visible and disableable if a plain-shell-discovered agent exits back to its
shell.
Alert edge selection is pure and tested in `src/lib/agentState.test.ts`.
The retained macOS delegate also handles notification responses. The terminal
identifier is emitted through a typed activation event after focusing the main
window; one early click is queued until the frontend listener reports ready.
Stale identifiers open the Agent Sessions/review surface with a nonfatal
explanation.

## PTY environment boundary

PTYs inherit the application environment so normal PATH and authentication
helpers continue working, but host-only terminal identity and automation flags
must not leak into interactive shells. `src-tauri/src/pty.rs`:

- sets `TERM=xterm-256color` and `COLORTERM=truecolor`;
- scrubs outer-terminal identity before optionally setting the dedicated-agent
  `TERM_PROGRAM=ghostty` compatibility masquerade;
- removes `NO_COLOR`, `CODEX_CI`, and `CODEX_THREAD_ID`;
- removes Codex-host `PAGER=cat` and `GIT_PAGER=cat` when applicable.

The login shell may deliberately set any of these again. Environment changes
only affect newly created PTYs; existing tabs must be recreated or adjusted in
their current shell.

## Testing and maintenance

Frontend Vitest coverage lives beside the model/profile modules and tests
fixtures, transitions, stale generations, authority precedence, rollups, and
notification edges. Rust unit tests cover process parsing, descendant grouping,
foreground membership, missing sessions, and command failure.

Run:

```sh
pnpm test
pnpm build
cd src-tauri && cargo test
cd src-tauri && cargo check
```

When Claude or Codex changes its terminal UI, update the relevant profile and
add a fixture before changing classifier behavior. Never persist terminal
snapshots, process arguments, environments, or matched evidence text.

## Explicit non-goals

Additional matching agent descendants are exposed as ephemeral, read-only child
agent process rows. Their stable row identity is terminal + occupant generation
+ PID; executable basename, PID, parent PID, and foreground membership are the
only displayed fields. Rust also returns nearest/root matching-agent PIDs so
shell siblings are not mislabeled as children; arguments, environments, and
process text never cross the privacy boundary. These rows are not native
conversation/subagent identity.

The runtime does not include ACP-native subagent identity, persistent
semantic/check history, or persistent PTYs. Isolated Codex tasks can retain an
opaque native conversation reference through a narrow read-only hook, but that
reference is task metadata rather than semantic runtime state. See
[`isolated-agent-tasks.md`](isolated-agent-tasks.md).
