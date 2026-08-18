# Agent control-plane roadmap

Origin: research into [Herdr](https://github.com/herdrdev/herdr), reviewed
2026-08-09 and updated for Talos on 2026-08-10.

This is an implementation roadmap, not a complete Herdr feature comparison.
The operational contract for shipped terminal-agent state lives in
[`docs/architecture/agent-runtime.md`](../architecture/agent-runtime.md).

## Product direction

Herdr's useful idea is an agent-aware control plane around real terminals:
semantic state, task isolation, review, restoration, and automation. Talos
should add that control plane to its existing IDE rather than become a
terminal multiplexer or copy Herdr's TUI.

The target workflow is:

1. See which agents are working, blocked, or ready for review.
2. Open the exact terminal, workspace, diff, checks, and preview for a task.
3. Give feedback or approve the result.
4. Apply, keep, or discard isolated work safely.

Talos already owns the useful editor-facing pieces: workspaces, source
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
- [x] Annotate Claude's input-ready state with live footer-derived background
  shell/monitor/team/local-agent counts without changing lifecycle or rollups.
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
- [x] Keep runtime/seen state and terminal layouts ephemeral; start every app
  session with both docks closed and empty.
- [x] Preserve the intentional `codex --yolo` launch default in both docks.
- [x] Keep the existing related-repository/worktree titlebar grouping.
- [x] Add frontend state/detection tests and Rust process-snapshot tests.

Current limits:

- Occupancy detection is macOS-first. Dedicated tabs and exact Claude/Codex
  executables launched inside plain shell tabs are discovered.
- Screen profiles are versioned and diagnosable, but still require fixture
  updates when agent CLIs change their interfaces.
- Native conversation identity is implemented only for unambiguous local Codex
  threads. ACP and native subagent identity remain proposals.
- Semantic/check history remains session-only. Isolated task/Git metadata,
  plans, terminal recipes, and opaque native-session references persist.
- PTYs still belong to the app process and do not survive application exit.

## Shipped: Agent Sessions and review

This is the smallest feature that turns semantic state into a workflow.

- [x] Add a persistent global Agent Sessions activity item above a divider from
  workspace tools, with attention / active / quiet live-session sections.
- [x] Keep strict Needs Input, checks failed, and Done/ready-for-review ordering
  inside Attention while active and quiet sessions retain stable list order.
- [x] Include both terminal docks and related-workspace families.
- [x] Show agent, project, current topic, reason, elapsed time, and current
  task/review state without exposing raw terminal output by default.
- [x] Click an item to switch workspace, reveal the correct dock/group, and
  focus the exact terminal.
- [x] Add next-attention and previous-attention shortcuts.
- [x] Route macOS notification clicks to the exact terminal using the existing
  terminal notification identifier.
- [x] Add a bounded, explicit terminal-tail peek for quick context.
- [x] Allow batched line-feedback reply only when the same live occupant
  generation owns an idle or question-classified prompt.
- [x] Keep lifecycle state separate from review state: Done means unseen idle,
  not tests passed or changes approved.

## Next: isolated worktree task loop

Each substantial agent task should be able to own an isolated checkout and
finish in Talos' native review UI.

- [x] Add Git worktree list/create/open/remove backend commands.
- [x] Add **New Worktree...**, **Open Worktree...**, and **New Worktree +
  Agent...** actions.
- [x] Create worktrees under a configurable root and open them as ordinary Talos
  workspaces.
- [x] Record task ID, parent workspace, worktree path, base commit, branch,
  agent terminal, and cleanup provenance.
- [x] Reuse the shipped related-workspace titlebar grouping.
- [x] Support repository-defined bootstrap/setup, an explicit ignored-file
  include list, and distinct preview ports.
- [x] Bind agent sessions, diffs, checks, commits, diagnostics, task terminals,
  and preview servers to the owning task.
- [x] Add **Apply/Merge**, **Keep Branch**, **Archive**, and **Discard Task**
  outcomes.
- [x] Keep closing a workspace, archiving a task, and deleting a checkout as
  distinct operations.
- [x] Let Git reject dirty removal first, then require explicit confirmation
  before forcing it.
- [x] Refuse worktree removal while a live global terminal is bound to that
  checkout, or require the user to stop/rebind it first.
- [x] Never delete the associated branch implicitly.

## Next: agent-owned review and checks

Terminal completion is only a signal. The real result is the task's changes
and evidence.

- [x] Add a session-only `AgentTask` model with independent clean, unreviewed,
  reviewed, feedback, stale approval, and accepted human-review state, with
  conflicts and check results surfaced independently. Discard is implemented
  through the isolated-worktree outcome flow.
- [x] Record a base commit so task evidence has a stable shared-tree scope.
- [x] Report check exit codes through a nonce-bound private terminal marker.
- [x] Add task/check pipelines with parallel/sequential `dependsOn`; do not enable
  repository-controlled folder-open autorun without a trust model.
- [x] Combine whole-task diff, latest checkpoint/turn diff, checks, LSP
  diagnostics, conflicts, commits, and preview status in one review surface.
- [x] Add line comments that can be batched into an agent follow-up.
- [x] Make merge readiness explicit; never infer approval from agent idleness.
- [x] Add a read-only review-agent action after launch profiles exist.

## Next: launch profiles and agent definitions

The built-in Claude and `codex --yolo` commands remain intentional defaults;
the visible launch/configuration flow extends them without silently changing
the initial Codex product decision.

- [x] Define typed agent metadata: executable, default arguments, transport,
  detection profile, resume support, and structured capabilities.
- [x] Define launch profiles: model, reasoning, permission mode, sandbox,
  environment, extra arguments, and folder/worktree choice.
- [x] Add a launch sheet to the existing Claude/Codex buttons; keep
  `codex --yolo` as the initial default.
- [x] Add executable discovery through the user's login-shell environment and
  clear unavailable-agent guidance.
- [x] Support custom commands and a small preset set without hard-coding every
  possible agent into core UI; custom executable basenames participate in the
  selected semantic detection profile and ambiguous assignments fail closed.
- [x] Persist definition IDs without silently coercing missing definitions to a
  different agent.
- [x] Add an Integrations settings page with version, capability, and health
  reporting.

## Then: conversation continuity and checkpoints

Prefer restoring the agent's native conversation over persisting arbitrary
terminal processes.

The shipped Codex hook satisfies continuity without changing the universal
terminal transport. ACP remains an explicit future interoperability item; none
of the built-in definitions currently declares an ACP transport, so the app
must not pretend process rows are native sessions or subagents.

- [ ] Integrate one ACP-capable agent while retaining terminal/screen detection
  as the universal fallback.
- [x] Capture native session references through ACP or narrowly scoped
  agent-specific hooks; never scrape session IDs from terminal output.
- [x] Offer restore automatically, ask before restoring, and restore as shell.
- [x] Fall back to a fresh shell when a session reference is invalid or absent.
- [x] Add a searchable archive grouped by project, worktree, and task.
- [x] Distinguish archive from delete and retain lightweight task/Git metadata
  after disposable worktrees are removed.
- [x] For task-owned worktrees, snapshot through a private Git index before
  each prompt-owned user turn reaches the PTY.
- [x] Keep restore code, restore conversation, fork, and compare as separate
  actions.
- [x] Clearly state that filesystem checkpoints cannot undo network calls,
  database mutations, or other external effects.

## Then: local automation and orchestration

Only expose external control after IDs, ownership, and transitions are stable.

- [x] Define stable workspace, task, pane, occupant-generation, and native
  session identifiers.
- [x] Move or synchronize authoritative semantic state into Rust.
- [x] Add a local authenticated CLI/socket API for list, start, prompt, focus,
  and state waits.
- [x] Use snapshot-then-ordered-events, explicit timeouts/cancellation, and
  resnapshot on reconnect.
- [x] Make prompt-and-wait atomic and pin waits to the occupant generation that
  existed when the wait began.
- [x] Add project-scoped, short-lived capabilities instead of injecting a
  global terminal-control credential into repository processes.
- [x] Provide a bundled agent skill documenting the command surface.
- [x] Add privacy-bounded, read-only child-agent process rows owned by the
  terminal occupant generation.
- [ ] Upgrade child rows to native subagent identity after ACP support exists.
- [x] Add editable plans, dependencies, and explicit queue versus steer.
- [x] Run independent approved steps in separate task worktrees.
- [x] Add Best-of-N after task isolation, checks, comparison, and cleanup
  are dependable.

## Later: durable terminal runtime

Do this only if native conversation restoration does not cover real demand.
These items remain deliberately gated research, not missing work in the
isolated-task/control-plane implementation.

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

- [x] Open localhost terminal links directly in Preview.
- [x] Add explicit copy/open-last-N-lines actions.
- [x] Persist manual-only workspace terminal recipes; opening or restoring a
  project never runs them.
- [x] Send an editor selection, file, or diff to an agent.
- [x] Discover Claude/Codex launched inside tabs created as plain shells.
- [x] Add versioned screen-profile updates and an internal explain/debug view.

## Not priorities

- A Herdr-style TUI, prefix navigation, or copy mode.
- A plugin marketplace before a small internal action/automation contract.
- A proprietary model/runtime; Talos should coordinate existing agents.
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
  [`workspaceSessions.ts`](../../src/lib/workspaceSessions.ts): explicit launch
  behavior in both docks.
- [`terminalActivity.ts`](../../src/lib/terminalActivity.ts) and
  [`termSession.ts`](../../src/lib/termSession.ts): activity/OSC fallback and
  bounded xterm-tail inspection.
- [`agentNotifications.ts`](../../src/lib/agentNotifications.ts) and
  [`notify.rs`](../../src-tauri/src/notify.rs): semantic alerts and terminal
  notification identity.
- [`agentTerminals.ts`](../../src/stores/agentTerminals.ts),
  [`workspaces.ts`](../../src/stores/workspaces.ts), and
  [`Titlebar.tsx`](../../src/components/Titlebar.tsx): session-only terminal
  grouping, workspace identity, and related-repository navigation.
- [`git.rs`](../../src-tauri/src/git.rs),
  [`taskRunner.ts`](../../src/lib/taskRunner.ts), and
  [`DiffViewer.tsx`](../../src/components/DiffViewer.tsx): seams for worktrees,
  checks, and review.
- [`pty.rs`](../../src-tauri/src/pty.rs): PTY ownership, process snapshots,
  backpressure, and child-environment isolation.
- [`control.rs`](../../src-tauri/src/control.rs) and
  [`agentControlPlane.ts`](../../src/lib/agentControlPlane.ts): authenticated
  local automation, Rust snapshots/events/waits, and generation-checked
  frontend actions. The complete contract is in
  [`agent-control.md`](../architecture/agent-control.md).
- [`agent_sessions.rs`](../../src-tauri/src/agent_sessions.rs) and
  [`nativeAgentSessions.ts`](../../src/lib/nativeAgentSessions.ts):
  privacy-bounded Codex conversation reference capture and validation.

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
