# Agent sessions and owned review checks

This document defines Talos' session-only agent task, review, Agent Sessions,
and check-pipeline behavior. Semantic occupancy/lifecycle remains defined by
[`agent-runtime.md`](agent-runtime.md).

## Ownership and state boundaries

Every dedicated Claude/Codex occupant generation in either dock owns one
`AgentTask`, keyed by terminal ID and generation. An app launch captures HEAD
through the cheap `git_review_head` boundary before typing the agent command;
the expensive content snapshot continues asynchronously, so large untracked
files do not delay launch. A manually typed relaunch creates a new task at first
process detection and labels that necessarily-late boundary. Snapshot retries
retain a successfully captured launch HEAD. If even HEAD was unavailable, a
retry is explicitly late; late baselines can run checks but can never become
an authoritative launch boundary. The UI warns that their review scope may be
incomplete, but human review and acceptance remain available. Capture failures
never prevent launch. A later generation replaces prior review, check, and
acceptance evidence.

The semantic runtime store can survive a frontend hot reload that recreates the
session-only task store. On module initialization, every currently detected
agent generation without a matching task is reconciled as a late-baseline task;
the review detail shows an initializing message during capture instead of silently
hiding review and check controls.

Tasks contain workspace/scope, optional persistent isolated-task identity,
agent kind, base HEAD, timestamps, selected pipeline/autorun preference,
review metadata, whole/per-file fingerprints, latest-turn paths, and the last
20 structured check runs. Semantic task/check state resets with the app.
Isolated task/Git/cleanup metadata persists separately. Project approval for
automatic commands is also persisted.

Lifecycle, human review, conflicts, and checks are independent. Human review
states are `clean`, `unreviewed`, `reviewed`, `feedback`, `stale`, and
`accepted`. Review changes records which fingerprint was successfully opened;
the user explicitly marks that evidence reviewed after inspection. Accept is
then available for exactly that fingerprint and only records a session-local
decision. Navigation, review acknowledgement, and acceptance are all
generation/fingerprint-pinned, so an async refresh cannot acknowledge newer
evidence. **Needs changes** uses the same compare-and-set rule, including when
invoked from a stale rendered session row. Passing checks are visible evidence but never enable or disable
Accept. Needs changes and Accept neither send text nor mutate Git. A later
repository fingerprint turns an accepted decision into `stale`; reviewing the
new fingerprint enables acceptance again. Occupant generations replace all
prior evidence.

Shared working trees remain supported. Their scope is **all repository changes
since the base HEAD**, including committed `base..HEAD` changes plus staged,
working-tree, and untracked changes. Talos never claims per-agent file
attribution there. Isolated agents additionally own a stable task/worktree and
use the lifecycle in [`isolated-agent-tasks.md`](isolated-agent-tasks.md).

## Review snapshot and privacy

`git_review_snapshot` returns current HEAD, base ancestry, sorted changed and
conflicted paths, one deterministic whole-task SHA-256 fingerprint, and opaque
per-path fingerprints for latest-turn comparison. Rust hashes HEAD
plus sorted staged/worktree/untracked content, Git executable modes, every
conflict stage, and nested dirty submodule state. Worktree files are read in
64 KiB chunks; contents never cross IPC. Capture revalidates HEAD, status, index,
and worktree metadata afterward and retries a moving repository up to three
times. Only metadata and the digest enter the store.

Per-terminal request sequences prevent an older refresh from overwriting newer
evidence. Concurrent tasks with the same workspace and baseline share an
in-flight snapshot instead of re-reading the tree. `lastRefreshedAt` is separate
from `attentionSince`: a no-op refresh (including opening review detail) does not
reset elapsed age or oldest-first ordering.

Evidence refreshes at task creation, repo watcher events, working→idle turn
completion, review-detail opening, check start/completion, and acceptance.
For prompt-owned user turns, Enter waits for `git_checkpoint_snapshot`: a
private temporary index writes an unreachable tree without touching the real
index. The tree and opaque per-path fingerprints are captured under one shared
repository-generation guard, which retries a moving checkout up to three
times. A later semantic Working edge consumes that app-owned boundary rather
than overwriting it with a second snapshot. The tree backs read-only
latest-turn file diffs; it is inspection evidence, not a restore or rollback
facility.

Programmatic prompt paths first reserve their place in the terminal's shared
input queue. Inside that slot, Git prepares the snapshot without changing task
state; the frontend then publishes it synchronously at the final PTY delivery
commit point and resets the bounded screen-evidence boundary to the current
prompt line so older scrollback cannot satisfy the new turn. A prior user Enter keeps later automation
gated until generation-owned output beyond that boundary reaches a stable
non-unknown screen state, counted in landed classifications (one per
debounce-settled screen inspection, not per raw PTY write) — excluding the
dispatch echo itself: the first landed classification after the boundary
reset is the CLI echoing the submitted prompt back into its own composer, so
settlement requires at least one further landing before the turn counts as
gated open (`promptTurnSettledByScreen`, `DISPATCH_ECHO_LANDINGS`). This
explicitly releases fast idle-to-idle turns even
when no debounced Working frame was visible; the queue is awakened independently
of runtime-store transitions when the stable prompt is semantically unchanged.
Cancellation or
failed ownership checks while snapshotting/awaiting a dispatch guard leave the
prior turn boundary unchanged. After delivery begins a queued request is
non-cancellable, so its promise reflects PTY delivery instead of reporting
cancellation for text that may already have reached the process.

**Peek context** is a separate boundary: an explicit click reads at most 12
logical xterm lines and 4,096 characters. Plaintext exists only in the mounted detail
component, supports refresh/hide, and is never logged, persisted, or copied into
runtime/task/check stores.

## Agent Sessions and navigation

The top, global activity-rail item opens a persistent Agent Sessions sidebar
that fills the resizable sidebar width and aggregates registered live sessions
from both docks, including while no workspace is open. The activity rail
separates this global item from workspace-scoped views with a divider. **All**
groups actionable, active, and quiet rows; active/quiet rows retain stable
registration order so normal
activity does not move the user's target. **Attention** contains only
actionable items and uses the strict queue order: Needs Input;
conflicts/current failed checks;
Done/Unreviewed/Reviewed/Approval Stale; Working/Starting; then
Feedback/Clean/Accepted/Idle/Unknown/No Agent. Ties use oldest stable attention
time, project, terminal title, and terminal ID. The activity icon carries the
actionable count without collapsing lifecycle and review into one state.

All entry points call `focusAgentTerminal(id)`. Workspace terminals activate
their open workspace, Project Terminals panel, dock group, and exact tab. Global
terminals reopen/switch projects as needed, activate the owning global grouping
and exact tab, then focus and acknowledge. Merely opening Agent Sessions never
acknowledges every row. A stale row leaves a nonfatal explanation in the view.
⌘⌥↓/↑ cycle actionable entries circularly.

Review changes calls `reviewAgentChanges(id)`: it opens or activates the owning
project, reveals Source Control, and opens the first current worktree/index diff
when available. Committed changes remain reachable from the commit graph. The
action records the exact opened fingerprint and closes the detailed review
overlay so the diff is visible. Returning to review detail exposes an explicit
**Mark reviewed** action only while that same generation and fingerprint remain
current.

The sidebar is ordinary persistent navigation and does not participate in the
native-overlay counter. Its review action opens the existing detailed overlay,
which does hide preview webviews and keeps dialog/listbox semantics, roving
selection, visible focus, text labels in addition to color, and Escape/outside
dismissal. The titlebar shortcut and ⌘⇧I reveal Agent Sessions. Each row's
accent-derived selection, focus, and state styling uses that terminal's
path-keyed project color rather than the currently active workspace's color;
the selected review detail inherits the same project scope.

Rows also show Claude's live background-task summary as an orthogonal chip.
Idle-with-background reads `Idle · 1 shell running`, stays in the normal quiet
section, and does not affect attention ordering, acknowledgement, review state,
or notifications.

## Check pipeline execution and trust

`.vscode/tasks.json` build/test tasks are selectable roots. Dependencies may
belong to any supported group. Compound tasks without commands are valid.
Validation rejects duplicate labels, missing dependencies, cycles, malformed
execution fields (`command`, `args`, options, environment, and dependency
metadata), referenced unsupported types, background/watch tasks, unavailable
active-file variables (including file-workspace/dirname/column variants), and
unknown substitutions. Diagnostics and duplicate labels outside the selected
reachable DAG do not block it. Repository `runOn: folderOpen` is ignored.
Workspace/environment variables remain supported.

Each DAG node runs once. `dependsOn` siblings run concurrently by default;
`dependsOrder: "sequence"` preserves list order. Failed/cancelled dependencies
skip dependents while already-running independent branches finish. Nodes run in
fresh app-reserved project terminals. Completed panes remain inspectable, but
are never reused because the user may have started another foreground process;
agent terminals are never interrupted.

`TermSession.runTrackedCommand` wraps a command on real physical lines inside a
subshell, followed by private OSC 6973 containing run ID, random 128-bit nonce,
and exit code. Trailing shell comments and heredocs therefore cannot swallow the
closure/marker. xterm consumes the marker. Only a
matching nonce resolves success/failure; prose is not parsed. Session close/exit
or absent marker evidence yields Cancelled, never a fabricated failure.

Every run fingerprints immediately before and after execution. When a passing
run changes the tree (for example, a formatter), the full DAG reruns once
against that result. A second mutation invalidates the run instead of certifying
untested content and surfaces as Checks Failed. Later mutations also make a pass stale. Runs retain node
status/timing, terminal IDs, and fingerprints—not raw output. Autorun requests
coalesce to the latest follow-up; a queued follow-up revalidates its occupant
generation, selected root, enabled flag, and project trust before it starts.
Repeated manual clicks never queue another run.
Current Passed/Failed/Running/Stale check evidence is presented beside, never
inside, the human review state and does not gate acceptance.

Manual clicks are their own authorization. Automatic checks require one-time
project-scoped local approval and run after every working→idle turn only when
changes exist. A repository cannot self-enable autorun, and review detail exposes
approval revocation. Malformed persisted trust JSON is treated as empty. Auto failures reuse the
owner terminal's notification ID, replacing the existing banner.

## Failure behavior and non-goals

Baseline/read errors are visible and retryable. Invalid pipelines do not start.
Closed terminals cancel their node. Missing agent targets remain stale instead
of being silently retargeted. No raw terminal output is retained.

Arbitrary terminal writes remain out of scope. The bounded programmatic paths
are isolated-task line feedback, task-plan queue/steer, editor context, and the
authenticated local control plane. Every path pins the live occupant generation
and checkpoints before sending; implicit routing additionally requires an idle
or question-owned prompt. Line-feedback drafts and batches are pinned to the
terminal generation and repository fingerprint they were authored against,
capped by comment count and total prompt characters, and revalidated against
the prepared checkpoint immediately before PTY delivery. Their post-delivery
review transition uses the same compare-and-set identity. Exact
native Codex conversation restore is available
only from an unambiguous persisted opaque reference. Persistent semantic/check
history and restorable filesystem checkpoints remain out of scope.
