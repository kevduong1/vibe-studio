# Isolated agent tasks

Vibe Studio can create agent-owned Git worktrees with **New Task** in the
Worktrees sidebar or titlebar **+** menu.
The checkout is an ordinary workspace, while `isolatedTasks.ts` retains the
task identity and cleanup provenance across workspace close and app restart.

## Identity and ownership

An `IsolatedTask` has a stable UUID and records its parent workspace, worktree
path, base commit, branch, primary agent terminal, preview port, setup inputs,
outcome, and checkout-removal time. Read-only review terminals are ordinary
session-owned terminals and are not duplicated in task metadata. The worktree
path remains the identity used by editors, LSP, checks, previews, and terminal
sessions. A semantic `AgentTask` captures the isolated-task UUID at launch so
review state is never inferred later from a mutable branch name.

Task metadata, editable plans, and an opaque native-session reference are
persisted, but semantic lifecycle, terminal text, prompt queues, review comment
drafts, and child-process rows are session-only. Archive closes the workspace
and retains the checkout and metadata. **Remove Worktree** removes the checkout
and retains lightweight metadata under **Removed tasks**. **Delete Task Record**
permanently removes only Vibe's metadata and review-comment drafts; the checkout
and branch remain, and parent-plan child references are pruned. Deletion is
refused while any terminal bound to the task is live, because its shell may
still own the task's reserved preview port. Closing a
workspace alone changes neither the task outcome nor the checkout.

Archive exposes separate **Restore Code**, **Restore Conversation**, **Fork**,
and **Compare Changes** actions. For Codex, Rust queries the newest local Codex
state database read-only and returns only opaque IDs/timestamps whose exact cwd,
branch, launch boundary, terminal, and live occupant generation match. Vibe
Studio stores a reference only when exactly one candidate exists. Restore validates exact cwd and unarchived state,
asks first, then launches `codex --yolo resume <id>` in a terminal shell. An
invalid, absent, or ambiguous reference opens a fresh shell with an explanation;
the app never scrapes output, guesses, or uses `--last`.

## Creation and setup

The default checkout root is `.vibe-worktrees` beside the parent repository.
The user can choose and persist another root from the creation dialog. A
repository may provide `.vibe/worktrees.json`:

```json
{
  "bootstrapCommand": "pnpm install",
  "includeIgnored": [".env.local"],
  "portStart": 4100
}
```

`includeIgnored` is an explicit repository-relative allowlist. Absolute paths,
`..`, and special files are rejected. Setup completes before the review
baseline and agent launch, so dependency installation is not attributed to the
agent. Active tasks receive a distinct `PORT` and `VIBE_TASK_ID` in their agent
shell. Control-plane cancellation is checked before Git creation and again
before workspace opening and agent launch. If cancellation arrives while Git is
creating the checkout, Vibe retains a recoverable task record and checkout but
does not launch the agent.

## Cleanup and merge safety

The backend lists, validates, creates, opens, removes, and merges worktrees.
Removal first calls normal `git worktree remove`, preserving Git's dirty
checkout refusal. Only a second call after explicit confirmation uses the two
force levels Git requires to override an explicit worktree lock. The primary
checkout is never removable. A live global terminal
bound to the checkout blocks removal; successful removal also prunes restored
non-live global terminal records that still point at the deleted path. It also
rebinds every global terminal grouping whose last-workspace navigation target
was deleted, preferring that grouping's active surviving terminal project, then
the current workspace, then no target. A grouping can therefore never try to
reopen a checkout removed through this flow. No task outcome deletes a branch,
and only `created-by-vibe` provenance may offer
automatic checkout removal. The Worktrees sidebar may also explicitly remove
any linked checkout after confirmation, regardless of where it was created;
listing the checkout alone still grants no automatic cleanup ownership.
Removal is also refused when the checkout is the persisted parent of another
retained task checkout, preventing child merge, fork, and cleanup operations
from being orphaned behind a deleted parent path.
Frontend create, merge, removal, Keep, Archive, and Restore flows are serialized as path-keyed
transactions across both the parent repository and linked checkout. A queued
operation counts as in flight immediately, so parent removal cannot slip
between child Git creation and task-record persistence. Permanent record
deletion is likewise refused while its path participates in one of these
transactions. Persisted outcome changes use a compare-and-set transition API;
a stale action can never overwrite the result of an earlier transition, and
ordinary task metadata patches cannot mutate `outcome`.

Apply/Merge first proves both paths are distinct members of the same Git
worktree set, then requires clean parent and task checkouts and a task branch.
When a primary agent terminal exists, its agent must be proven idle or stopped;
starting, unknown, missing-but-live, blocked, and working states refuse the
merge. Merge conflicts are
aborted before the error reaches the UI, leaving the parent at its pre-merge
state. A branch/worktree that advances during a successful merge is rechecked
and remains Active with an explicit “review and merge again” error rather than
being falsely marked Applied. The frontend also rechecks the exact owner
terminal, occupant generation, lifecycle/occupancy state, and live-session
state after merge IPC. If any changed, it leaves the task Active and explicitly
warns that Git may already have merged the previously reviewed commits. Keep
Branch changes task outcome only. Archive,
worktree removal, and permanent task-record deletion remain separate operations.

## Repository worktree view

The activity-bar Worktrees sidebar is repository-scoped, not a census of only
Vibe-created tasks. On mount, manual refresh, and Git-metadata watcher events,
it calls `git_worktree_list` for the current workspace. Git remains the source
of truth for the live set: the main checkout and every linked worktree appear
even when they were created in another tool. Rows expose the checkout path,
branch or detached state, HEAD, main/linked identity, locked/prunable flags,
and whether that checkout is the current or another open workspace. A closed,
non-prunable row can be opened as an ordinary workspace after backend
membership validation. Presentation order is independent of the active
workspace: main checkout first, then branch and path. Switching changes the
Current badge without moving rows.

Persistent `IsolatedTask` metadata is joined onto that live list by exact
worktree path. A matching row retains the richer evidence, plans, agent
controls, and cleanup actions below; an unmatched row remains an unmanaged Git
worktree. Listing an external checkout does not adopt it, create task metadata,
or grant automatic cleanup ownership. Every non-main live row offers an
explicit, confirmed **Remove Worktree** action; the primary checkout never does.
Task rows separately offer **Delete Task Record**, which leaves any live Git
worktree visible as an ordinary row. Task records whose paths are no longer
members of the live worktree set are hidden by default under **Removed tasks**,
which is shown only when such records exist, and labeled as not linked. Removed
metadata therefore cannot be mistaken for a checkout Git still knows about.
Repository membership follows persisted parent links transitively, so a removed
child or grandchild remains in history even if an intermediate parent checkout
was removed by an external Git command.
Every live row resolves its accent from the worktree path, matching the workspace tab and
its Project Color picker; a removed row falls back to its parent project's
accent. The view is always for the current repository; it no longer mixes task
cards from unrelated projects.

A prunable record remains visible for Git administration, but actions requiring
a live checkout (open/compare, checkpoint diff, restore, merge, or launching a
reviewer) are disabled. Worktree list refreshes are driven by the shared Git
`worktrees` administration directory as well as each checkout's own
HEAD/index/refs, so sibling add/remove/lock/prune operations update every open
checkout's repository view.

**New Task** dispatches an app-level overlay request rather than mounting the
dialog inside a workspace sidebar. The stable app shell opens the existing
`WorktreeDialog` in `create-agent` mode, so creation both records the isolated
task and launches its chosen agent; activating the newly created workspace
cannot hide the dialog before its close transition completes.

## Review and prompt ownership

The Worktrees sidebar's Vibe-task rows are the combined evidence surface:
whole-task and latest-turn path counts, conflicts, check state, LSP diagnostics,
commits, preview servers, agent state, and privacy-bounded child-agent
processes. Each live task card scopes its accent to its persisted worktree
project color, so switching the active workspace does not recolor unrelated
tasks. Review Changes opens the first owned change in the normal SCM/diff UI.

Before an Enter reaches an idle/question-owned agent prompt, the backend writes
tracked and untracked non-ignored content into an unreachable Git tree through
a private temporary index. The real index/worktree do not change. The
Worktrees task surface opens read-only checkpoint-to-current file diffs, while
per-file hashes derive the latest-turn path set without sending contents across
IPC. The tree and hashes are captured under one revalidated repository
generation, so they cannot describe different filesystem states. Line comments
are session-only and batch into follow-ups bounded by both 50 comments and the
8,192-character prompt limit. Each draft records the terminal generation and
repository fingerprint it was authored against; mixed or outdated drafts stay
visible but cannot be sent. The batch is revalidated against the prepared Git
checkpoint in its reserved terminal-input slot. Only comments in a successfully
delivered batch are removed, leaving overflow for the next send. If evidence
changes after delivery, the UI reports that the prompt was sent but does not
mark the newer evidence as needing changes. A write is
allowed only when the same terminal and occupant generation still own the task
and the agent is idle or screen-classified as waiting on a question. Permission,
authentication, unknown, replaced, and exited occupants reject the write.

If checkpoint creation fails, Vibe Studio withholds that Enter and shows the
error. The already-typed prompt remains at the agent input so the user can fix
the problem and retry; the app never silently submits an uncheckpointed turn.
Programmatic queue/steer paths prepare the Git snapshot without publishing it,
then commit it synchronously only after their final cancellation/state guard and
immediately before PTY delivery. Cancellation while snapshotting or awaiting a
guard therefore cannot move the latest-turn boundary. Once PTY delivery starts,
the request is no longer cancellable and reports the delivery result rather
than a false “cancelled” result for text that may already have been sent.

The read-only review action launches Codex with explicit `read-only` sandbox
and `never` approval settings. It is a separate terminal and semantic task.

These Git-tree checkpoints are inspection evidence, not a restore action. They
cannot undo
network calls, database mutations, or any external side effect.

## Plans and dispatch

Each task can persist editable plan steps with draft, approved, running,
completed, or blocked state and explicit dependencies. Only approved steps
whose dependencies are completed can dispatch.

- **Queue for agent** holds a bounded session-only prompt until the exact live
  occupant generation is idle or waiting on a question, then commits its
  prepared checkpoint at delivery.
- **Steer now** prepares a checkpoint and commits it immediately before sending
  to that generation.
- **New worktree** creates an independent child task from the parent task
  branch. Best-of-N serializes creation of two to four sibling worktrees to
  avoid Git lock contention, while already-launched candidates run
  concurrently. Each remains an ordinary task card with independent evidence,
  comparison, outcome, and cleanup.

Queued prompts are never persisted. Replacing or exiting the occupant rejects
its queue instead of delivering text to a new process. Programmatic multiline
prompts use sanitized bracketed paste followed by exactly one Enter; terminals
without bracketed-paste mode receive a flattened single line.

## Launch definitions

`agentDefinitions.ts` owns typed definitions and launch profiles. Definitions
include executable, arguments, terminal transport, detection profile, resume
support, and capabilities. Profiles include model, reasoning, permissions,
sandbox, environment, extra arguments, and folder choice. Conversation restore
is an explicit isolated-task action, not an unused launch-profile promise.

The built-in Codex definition visibly retains `codex --yolo` as its initial
default. Choosing explicit permission or sandbox controls replaces `--yolo`.
The launch sheet resolves executables through the login-shell PATH; Integrations
shows a bounded version probe, health, and capabilities. Custom commands get
stable IDs, and their exact executable basenames participate in runtime
detection under the selected Claude/Codex screen profile. Duplicate names for
one profile coalesce; conflicting profile assignments are shown as errors and
cannot launch. A profile whose definition is missing is disabled rather than
coerced to another agent.
