# Agent control-plane roadmap

Origin: research into [Herdr](https://github.com/herdrdev/herdr), reviewed
2026-08-09 and updated for Vibe Studio on 2026-08-10.

This is an implementation roadmap, not a complete Herdr feature comparison.
The operational contract for shipped terminal-agent state lives in
[`docs/architecture/agent-runtime.md`](../architecture/agent-runtime.md).

## Product direction

Herdr's useful idea is an agent-aware control plane around real terminals:
semantic state, task isolation, review, restoration, and automation. Vibe
Studio should add that control plane to its existing IDE rather than become a
terminal multiplexer or copy Herdr's TUI.

The target workflow is:

1. See which agents are working, blocked, or ready for review.
2. Open the exact terminal, workspace, diff, checks, and preview for a task.
3. Give feedback or approve the result.
4. Apply, keep, or discard isolated work safely.

Vibe Studio already owns the useful editor-facing pieces: workspaces, source
control, editable diffs, LSP diagnostics, tasks, previews, and two terminal
docks. The remaining work is to connect those pieces around an agent-owned
task.

## Shipped foundation

- [x] Track occupancy separately from lifecycle and seen/unseen presentation.
- [x] Support dedicated Claude and Codex tabs in both terminal docks.
- [x] Detect macOS agent occupancy from privacy-bounded PTY descendant process
  snapshots; query failures become unknown, not false absence.
- [x] Classify the bounded live xterm tail with independent Claude and Codex
  screen profiles.
- [x] Prioritize screen evidence over OSC and generic activity fallback.
- [x] Detect Working, Needs Input, Done, Idle/Unknown, and No Agent.
- [x] Preserve unseen Done until the background result is viewed.
- [x] Keep a viewed blocked prompt blocked until new terminal evidence clears
  it.
- [x] Roll state up across panes, workspace families, global groupings, and the
  hidden-panel indicator using blocked > done > working > idle.
- [x] Show semantic icons, text, tooltips, reasons, authority, transition time,
  and matched rule IDs without retaining terminal text.
- [x] Support opt-in blocked/completion alerts in both docks with one
  replaceable notification per terminal.
- [x] Return exited agents to No Agent and detect a relaunch in the same tab.
- [x] Keep runtime/seen state ephemeral and restore global tabs as fresh
  shells.
- [x] Preserve the intentional `codex --yolo` launch default in both docks.
- [x] Keep the existing related-repository/worktree titlebar grouping.
- [x] Add frontend state/detection tests and Rust process-snapshot tests.

Current limits:

- Only dedicated Claude/Codex tabs are recognized; agents started in plain
  shell tabs are not discovered.
- Occupancy detection is macOS-first.
- Screen profiles may need updates when agent CLIs change their interfaces.
- There is no isolated worktree lifecycle, launch-profile UI, native session
  identity, ACP integration, persistent task history, or external API.
- PTYs still belong to the app process and do not survive application exit.

## Next: attention and review inbox

This is the smallest feature that turns semantic state into a workflow.

- [x] Add a global inbox ordered by Needs Input, checks failed, Done/ready for
  review, Working, then idle.
- [x] Include both terminal docks and related-workspace families.
- [x] Show agent, project, current topic, reason, elapsed time, and current
  task/review state without exposing raw terminal output by default.
- [x] Click an item to switch workspace, reveal the correct dock/group, and
  focus the exact terminal.
- [x] Add next-attention and previous-attention shortcuts.
- [x] Route macOS notification clicks to the exact terminal using the existing
  terminal notification identifier.
- [x] Add a bounded, explicit terminal-tail peek for quick context.
- [ ] Allow a quick reply only after prompt ownership and stale-occupant checks
  are defined.
- [x] Keep lifecycle state separate from review state: Done means unseen idle,
  not tests passed or changes approved.

## Next: isolated worktree task loop

Each substantial agent task should be able to own an isolated checkout and
finish in Vibe Studio's native review UI.

- [ ] Add Git worktree list/create/open/remove backend commands.
- [ ] Add **New Worktree...**, **Open Worktree...**, and **New Worktree +
  Agent...** actions.
- [ ] Create worktrees under a configurable root and open them as ordinary Vibe
  Studio workspaces.
- [ ] Record task ID, parent workspace, worktree path, base commit, branch,
  agent terminal, and cleanup provenance.
- [x] Reuse the shipped related-workspace titlebar grouping.
- [ ] Support repository-defined bootstrap/setup, an explicit ignored-file
  include list, and distinct preview ports.
- [ ] Bind agent sessions, diffs, checks, commits, diagnostics, task terminals,
  and preview servers to the owning task.
- [ ] Add **Apply/Merge**, **Keep Branch**, **Archive**, and **Discard Task**
  outcomes.
- [ ] Keep closing a workspace, archiving a task, and deleting a checkout as
  distinct operations.
- [ ] Let Git reject dirty removal first, then require explicit confirmation
  before forcing it.
- [ ] Refuse worktree removal while a live global terminal is bound to that
  checkout, or require the user to stop/rebind it first.
- [ ] Never delete the associated branch implicitly.

## Next: agent-owned review and checks

Terminal completion is only a signal. The real result is the task's changes
and evidence.

- [x] Add a session-only `AgentTask` model with independent clean, unreviewed,
  reviewed, feedback, stale approval, and accepted human-review state, with
  conflicts and check results surfaced independently.
  Discard remains deferred until isolated worktrees.
- [x] Record a base commit so task evidence has a stable shared-tree scope.
- [x] Report check exit codes through a nonce-bound private terminal marker.
- [x] Add task/check pipelines with parallel/sequential `dependsOn`; do not enable
  repository-controlled folder-open autorun without a trust model.
- [ ] Combine whole-task diff, latest checkpoint/turn diff, checks, LSP
  diagnostics, conflicts, commits, and preview status in one review surface.
- [ ] Add line comments that can be batched into an agent follow-up.
- [x] Make merge readiness explicit; never infer approval from agent idleness.
- [ ] Add a read-only review-agent action after launch profiles exist.

## Next: launch profiles and agent definitions

The current Claude and `codex --yolo` commands are intentional fixed defaults.
Keep them until a visible configuration flow replaces the fixed map.

- [ ] Define typed agent metadata: executable, default arguments, transport,
  detection profile, resume support, and structured capabilities.
- [ ] Define launch profiles: model, reasoning, permission mode, sandbox,
  environment, extra arguments, folder/worktree choice, and restore policy.
- [ ] Add a launch sheet to the existing Claude/Codex buttons; keep
  `codex --yolo` as the initial default.
- [ ] Add executable discovery through the user's login-shell environment and
  clear unavailable-agent guidance.
- [ ] Support custom commands and a small preset set without hard-coding every
  possible agent into core UI.
- [ ] Persist definition IDs without silently coercing missing definitions to a
  different agent.
- [ ] Add an Integrations settings page with version, capability, and health
  reporting.

## Then: conversation continuity and checkpoints

Prefer restoring the agent's native conversation over persisting arbitrary
terminal processes.

- [ ] Integrate one ACP-capable agent while retaining terminal/screen detection
  as the universal fallback.
- [ ] Capture native session references through ACP or narrowly scoped
  agent-specific hooks; never scrape session IDs from terminal output.
- [ ] Offer restore automatically, ask before restoring, and restore as shell.
- [ ] Fall back to a fresh shell when a session reference is invalid or absent.
- [ ] Add a searchable archive grouped by project, worktree, and task.
- [ ] Distinguish archive from delete and retain lightweight task/Git metadata
  after disposable worktrees are removed.
- [ ] For task-owned worktrees, snapshot before each user turn.
- [ ] Keep restore code, restore conversation, fork, and compare as separate
  actions.
- [ ] Clearly state that filesystem checkpoints cannot undo network calls,
  database mutations, or other external effects.

## Then: local automation and orchestration

Only expose external control after IDs, ownership, and transitions are stable.

- [ ] Define stable workspace, task, pane, occupant-generation, and native
  session identifiers.
- [ ] Move or synchronize authoritative semantic state into Rust.
- [ ] Add a local authenticated CLI/socket API for list, start, prompt, focus,
  and state waits.
- [ ] Use snapshot-then-ordered-events, explicit timeouts/cancellation, and
  resnapshot on reconnect.
- [ ] Make prompt-and-wait atomic and pin waits to the occupant generation that
  existed when the wait began.
- [ ] Add project-scoped, short-lived capabilities instead of injecting a
  global terminal-control credential into repository processes.
- [ ] Provide a bundled agent skill documenting the command surface.
- [ ] Add editable plans, dependencies, queue versus steer, and read-only
  native subagent rows.
- [ ] Run independent approved steps in separate task worktrees.
- [ ] Add Best-of-N only after task isolation, checks, comparison, and cleanup
  are dependable.

## Later: durable terminal runtime

Do this only if native conversation restoration does not cover real demand.

- [ ] Measure whether users need arbitrary shells and servers to survive app
  exit.
- [ ] Prototype an optional private tmux backend on Unix as a demand test.
- [ ] If justified, move PTY ownership into a background service with stable
  IDs, authenticated local transport, replay, reconnection, flow control,
  migration, and crash recovery.
- [ ] Consider remote attachment only after local reconnection is robust.
- [ ] Keep persisted terminal history opt-in, bounded, and separate from normal
  layout metadata because scrollback can contain secrets.

## Opportunistic improvements

These are useful seams that can ship independently when they support the main
roadmap:

- [ ] Open localhost terminal links directly in Preview.
- [ ] Add explicit copy/open-last-N-lines actions.
- [ ] Persist workspace terminal recipes with an explicit run-on-restore
  policy.
- [ ] Send an editor selection, file, or diff to an agent.
- [ ] Discover Claude/Codex launched inside tabs created as plain shells.
- [ ] Add versioned screen-profile updates and an internal explain/debug view.

## Not priorities

- A Herdr-style TUI, prefix navigation, or copy mode.
- A plugin marketplace before a small internal action/automation contract.
- A proprietary model/runtime; Vibe Studio should coordinate existing agents.
- Remote/phone clients before a durable local runtime exists.
- Cloud runners, schedules, or webhooks before local task ownership, review,
  cancellation, and cleanup are trustworthy.
- Broad terminal-emulator parity such as Kitty graphics.

## Implementation anchors

- [`agentState.ts`](../../src/lib/agentState.ts),
  [`agentProfiles.ts`](../../src/lib/agentProfiles.ts), and
  [`agentRuntime.ts`](../../src/stores/agentRuntime.ts): semantic model,
  detection, transitions, and rollups.
- [`agentSessions.ts`](../../src/lib/agentSessions.ts) and
  [`workspaceSessions.ts`](../../src/lib/workspaceSessions.ts): current launch
  and restore behavior in both docks.
- [`terminalActivity.ts`](../../src/lib/terminalActivity.ts) and
  [`termSession.ts`](../../src/lib/termSession.ts): activity/OSC fallback and
  bounded xterm-tail inspection.
- [`agentNotifications.ts`](../../src/lib/agentNotifications.ts) and
  [`notify.rs`](../../src-tauri/src/notify.rs): semantic alerts and terminal
  notification identity.
- [`agentTerminals.ts`](../../src/stores/agentTerminals.ts),
  [`workspaces.ts`](../../src/stores/workspaces.ts), and
  [`Titlebar.tsx`](../../src/components/Titlebar.tsx): terminal persistence,
  workspace identity, and related-repository grouping.
- [`git.rs`](../../src-tauri/src/git.rs),
  [`taskRunner.ts`](../../src/lib/taskRunner.ts), and
  [`DiffViewer.tsx`](../../src/components/DiffViewer.tsx): seams for worktrees,
  checks, and review.
- [`pty.rs`](../../src-tauri/src/pty.rs): PTY ownership, process snapshots,
  backpressure, and child-environment isolation.

## References

- [Herdr overview](https://github.com/herdrdev/herdr)
- [Herdr concepts](https://herdr.dev/docs/concepts/)
- [Agents and semantic state](https://herdr.dev/docs/agents/)
- [Agent automation](https://herdr.dev/docs/agent-automation/)
- [Session state and restore](https://herdr.dev/docs/session-state/)
- [Persistence and remote access](https://herdr.dev/docs/persistence-remote/)
- [Configuration and worktrees](https://herdr.dev/docs/configuration/)
- [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)
- [tmux control mode](https://github.com/tmux/tmux/wiki/Control-Mode)
