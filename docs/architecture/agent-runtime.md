# Semantic agent runtime

This document is the source of truth for Vibe Studio's semantic state for
dedicated Claude and Codex terminal tabs. It covers agent tabs in both the
project-terminal dock and global terminal groupings.

## Scope

Vibe Studio distinguishes the requested tab kind from the process currently
inside it. A tab created for Claude may contain Claude, may be starting Claude,
or may have returned to an ordinary shell after Claude exits. Version 1 only
tracks dedicated Claude/Codex tabs; discovering agents inside tabs created as
plain shells is separate work.

Runtime state is ephemeral. Global tab metadata and layouts persist, but PTYs
and semantic state do not. After an app restart, restored agent tabs open as
fresh shells and correctly show **No Agent** until an agent is launched.

## State model

`src/lib/agentState.ts` defines the public model:

- `occupancy`: `absent | starting | present | exited | unknown`
- `lifecycle`: `working | blocked | idle | unknown`
- `seen`: whether the current blocked/completed state has been viewed
- `authority`: `screen | osc | activity`
- optional structured `reason` and diagnostic `matchedRule`
- `generation`: incremented when an agent process appears or its PID changes

Presentation is derived, never stored. In particular, **Done** means a present
agent is idle after background work and `seen === false`. The display states
are `starting`, `working`, `blocked`, `done`, `idle`, `unknown`, and `absent`.
Done is therefore a turn-completion/attention state, not a judgment about the
meaning of the final response: an agent can finish a turn with a conversational
question and still be Done. **Needs Input** is reserved for explicit structured
question/permission UI or a notification signal, where the terminal provides
stronger evidence than arbitrary response prose.

`src/stores/agentRuntime.ts` is the one global ephemeral store. It includes
both terminal scopes, so workspace and related-workspace rollups see project
and global agent tabs. A global grouping rollup is restricted to terminal IDs
owned by that grouping.

## Occupancy authority

On macOS, the frontend runs one shared one-second monitor while any dedicated
agent tabs are registered. One `pty_agent_process_snapshot` IPC call covers all
registered terminal IDs. The Rust backend:

1. Reads each PTY's shell PID and foreground process group.
2. Runs one `ps` snapshot.
3. Groups descendants under the correct shell.
4. Matches exact executable basenames from the typed Claude/Codex profiles.
5. Returns only PID, parent PID, executable basename, and foreground
   membership—never arguments or environment.

A successful query with no match means `absent`. A query failure means
`unknown`; it must never manufacture a false absence. Unsupported platforms
degrade to `unknown`. Generation checks reject delayed screen results from a
previous agent occupant.

Fresh launches call `markAgentLaunching()` before typing `claude` or
`codex --yolo` into the shell. Dedicated Codex tabs deliberately default to
`--yolo` in both docks so they start fully autonomous. A future launch-profile
UI may expose permission choices, but must preserve this default unless the
product decision changes explicitly.

## Lifecycle authorities

After xterm parses output, `termSession.ts` reads at most the bottom 40 logical
lines and 16 KiB from the active normal or alternate-screen buffer. Wrapped
physical rows are joined before classification.

`src/lib/agentProfiles.ts` contains independently authored profiles for Claude
Code 2.1.226 and Codex CLI 0.147.0, including their structured multi-question
overlays. Rules run in priority order:

1. Blocked prompts, with reasons such as permission, question, authentication,
   quota, or error.
2. Active work/spinners.
3. Idle input prompts.

Only near-tail evidence is eligible. A newer idle prompt invalidates stale
blocked text above it. Strong permission/question matches apply immediately;
ordinary changes are debounced, and idle requires stable evidence.

Screen evidence has priority. When it disappears, the runtime falls back to
the existing activity tracker:

- sustained output → `working` with `activity` authority;
- BEL/OSC notification → `blocked` with `osc` authority;
- a background working stretch becoming quiet → idle and unseen **Done**.

Blocked state is not cleared merely by viewing it. Viewing acknowledges and
dismisses its alert, while lifecycle remains blocked until newer terminal
evidence shows the prompt disappeared or work resumed.

## Seen and acknowledgement

A pane is considered watched when it is visible while the application is
foreground. Clicking/focusing it also acknowledges it. The important edges
are:

- working → visible idle: idle, already seen;
- working → hidden/background idle: unseen **Done**;
- unseen Done → viewed: idle and seen;
- hidden blocked → viewed: blocked and seen;
- agent process exits to shell: absent with lifecycle diagnostics cleared.

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

Pane badges add textual **Working**, **Needs Input**, or **Done**, so status is
not color-only. Tooltips contain agent kind, state, reason, authority,
transition time, and matched rule ID. Workspace tabs, workspace families,
global grouping tabs, and the hidden-panel indicator roll up with priority:

`blocked > done > working > idle/unknown/absent`

The titlebar also owns a global inbox over both docks. It preserves semantic
ordering, routes to the exact workspace/group/tab/session, and projects review
state beside (never into) lifecycle state. Task ownership, review evidence,
checks, and context-peek privacy are specified in
[`attention-review.md`](attention-review.md).

## Alerts

Notifications are opt-in per terminal. Global-tab toggles persist with global
tab metadata; project-tab toggles are ephemeral. One notification identifier
per terminal replaces repeated banners rather than stacking them.

Alerts fire once for a background transition into blocked and once when a
completed turn becomes unseen Done. They are dismissed on acknowledgement,
viewing Done, resumed work, agent exit, tab close, or notification disable.
Alert edge selection is pure and tested in `src/lib/agentState.test.ts`.
The retained macOS delegate also handles notification responses. The terminal
identifier is emitted through a typed activation event after focusing the main
window; one early click is queued until the frontend listener reports ready.
Stale identifiers open the inbox with a nonfatal explanation.

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

The current feature does not include plain-shell discovery, isolated worktree
ownership, apply/merge/discard actions, quick reply, full diff comments, ACP,
hooks, native session resume, custom launch profiles, persistent task history,
or persistent PTYs. Those remain separate roadmap items.
