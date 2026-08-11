# Attention inbox and owned review checks

This document defines Vibe Studio's session-only agent task, review, inbox,
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
the inbox shows an initializing message during capture instead of silently
hiding review and check controls.

Tasks contain workspace/scope, optional persistent isolated-task identity,
agent kind, base HEAD, timestamps, selected pipeline/autorun preference,
review metadata, whole/per-file fingerprints, latest-turn paths, and the last
20 structured check runs. Semantic task/check state resets with the app.
Isolated task/Git/cleanup metadata persists separately. Project approval for
automatic commands is also persisted.

Lifecycle, human review, conflicts, and checks are independent. Human review
states are `clean`, `unreviewed`, `reviewed`, `feedback`, `stale`, and
`accepted`. Review changes records the current fingerprint as reviewed; Accept
is then available for exactly that fingerprint and only records a session-local
decision. Passing checks are visible evidence but never enable or disable
Accept. Needs changes and Accept neither send text nor mutate Git. A later
repository fingerprint turns an accepted decision into `stale`; reviewing the
new fingerprint enables acceptance again. Occupant generations replace all
prior evidence.

Shared working trees remain supported. Their scope is **all repository changes
since the base HEAD**, including committed `base..HEAD` changes plus staged,
working-tree, and untracked changes. Vibe Studio never claims per-agent file
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
from `attentionSince`: a no-op refresh (including opening the inbox) does not
reset elapsed age or oldest-first ordering.

Evidence refreshes at task creation, repo watcher events, working→idle turn
completion, inbox/detail opening, check start/completion, and acceptance.
For prompt-owned user turns, Enter waits for `git_checkpoint_create`: a private
temporary index writes an unreachable tree without touching the real index.
The capture revalidates repository generation and retries a moving checkout up
to three times. The tree backs read-only latest-turn file diffs; it is
inspection evidence, not a restore or rollback facility.

**Peek context** is a separate boundary: an explicit click reads at most 12
logical xterm lines and 4,096 characters. Plaintext exists only in the mounted detail
component, supports refresh/hide, and is never logged, persisted, or copied into
runtime/task/check stores.

## Inbox and navigation

The titlebar inbox aggregates registered agent sessions from both docks.
Attention contains actionable items; All includes the remainder. Blocked always
wins. Ordering is Needs Input; conflicts/current failed checks;
Done/Unreviewed/Reviewed/Approval Stale; Working/Starting; then
Feedback/Clean/Accepted/Idle/Unknown/No Agent. Ties use oldest stable attention
time, project, terminal title, and terminal ID.

All entry points call `focusAgentTerminal(id)`. Workspace terminals activate
their open workspace, Project Terminals panel, dock group, and exact tab. Global
terminals reopen/switch projects as needed, activate the owning global grouping
and exact tab, then focus and acknowledge. Stale IDs leave the inbox open with
an explanation. ⌘⌥↓/↑ cycle actionable entries circularly.

Review changes calls `reviewAgentChanges(id)`: it opens or activates the owning
project, reveals Source Control, and opens the first current worktree/index diff
when available. Committed changes remain reachable from the commit graph. The
action then records the current fingerprint as reviewed and closes the inbox so
the diff is visible.

The popover participates in the native-overlay counter so preview webviews hide.
It has dialog/listbox semantics, roving selection, visible focus, text labels in
addition to color, Escape/outside dismissal, and ⌘⇧I activation.

## Check pipeline execution and trust

`.vscode/tasks.json` build/test tasks are selectable roots. Dependencies may
belong to any supported group. Compound tasks without commands are valid.
Validation rejects duplicate labels, missing dependencies, cycles, malformed
`dependsOn`, referenced unsupported types, background/watch tasks, unavailable
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
coalesce to the latest follow-up; repeated manual clicks never queue another run.
Current Passed/Failed/Running/Stale check evidence is presented beside, never
inside, the human review state and does not gate acceptance.

Manual clicks are their own authorization. Automatic checks require one-time
project-scoped local approval and run after every working→idle turn only when
changes exist. A repository cannot self-enable autorun, and the inbox exposes
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
or question-owned prompt. Exact native Codex conversation restore is available
only from an unambiguous persisted opaque reference. Persistent semantic/check
history and restorable filesystem checkpoints remain out of scope.
