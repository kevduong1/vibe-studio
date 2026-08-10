# Current changes review

I would not ship this unchanged yet. The overall design is coherent, but I found four evidence-integrity problems and several functional and maintenance issues that the current tests do not cover.

## High-priority findings

### 1. A passing pipeline can certify changes that were never tested

[`checkPipelines.ts`](../src/lib/checkPipelines.ts#L173) captures the fingerprint only after the commands complete. If a file changes during the run—after its relevant test already executed—the final snapshot includes that new content and the run becomes Merge Ready for it.

Capture a fingerprint immediately before execution and again afterward. If they differ, either invalidate the run or automatically rerun the full pipeline once against the resulting tree. The latter preserves the intended formatter-change workflow.

### 2. Concurrent refreshes can restore stale review evidence

[`agentTasks.ts`](../src/stores/agentTasks.ts#L186) applies every completed snapshot without a request sequence. Refreshes can overlap from watcher events, inbox opening, selection changes, turn completion, check start, and check completion. An older, slower snapshot can finish last and replace newer evidence.

Add a per-task request nonce or, preferably, a coalescing per-workspace snapshot scheduler. The Rust snapshot is also multi-step—status, index, file reads, and HEAD—so it should revalidate HEAD/status afterward and retry if the repository changed during capture.

### 3. Retrying a failed baseline can silently exclude work already completed by the agent

A failed initial capture still launches the agent via `.finally()` in [`agentSessions.ts`](../src/lib/agentSessions.ts#L89). Later, [`retryAgentTaskBaseline`](../src/stores/agentTasks.ts#L179) captures the then-current HEAD as the base without marking it late. Commits made between launch and retry disappear from review scope.

Capture HEAD through a cheap, failure-resistant operation before launching, independently of expensive content hashing. A retry must retain that original HEAD; otherwise mark it as a late baseline and prevent unqualified acceptance.

### 4. Reusable check terminals are not proven idle before commands are injected

[`checkPipelines.ts`](../src/lib/checkPipelines.ts#L27) considers a terminal reusable when it exists, has not exited, and is not leased. Users can interact with these terminals after a run. If they start another command, the next check line may be delivered to that process's stdin instead of a shell prompt, potentially interfering with it or hanging forever.

Make check terminals app-reserved, or only reuse a terminal after verified OSC prompt evidence. Otherwise allocate a fresh terminal.

### 5. Some valid shell task commands cannot produce completion evidence

[`termSession.ts`](../src/lib/termSession.ts#L523) puts the command, closing parenthesis, and marker on one physical line. Commands ending in a shell comment cause the closure and marker to be commented out. Heredoc terminators also break because `)` is appended to the delimiter line. Both forms fail parsing in zsh and bash.

Wrap the command with real newlines:

```sh
(
<command>
)
__vibe_status=$?
printf ...
```

## Other functional issues

### 6. Inbox age and ordering reset merely by opening the inbox

Opening refreshes every task in [`AttentionInbox.tsx`](../src/components/AttentionInbox.tsx#L108), while every successful refresh unconditionally changes `updatedAt` in [`agentTasks.ts`](../src/stores/agentTasks.ts#L193). Consequently, unreviewed and failed items show approximately `0s` and lose their “oldest waiting first” ordering whenever the inbox opens.

Separate `lastRefreshedAt` from `reviewChangedAt`/`attentionSince`, and only reset the latter when the fingerprint or meaningful review state changes.

### 7. Working agents can appear actionable for review before their turn is finished

[`inboxTier`](../src/stores/agentTasks.ts#L313) prioritizes `unreviewed` and `merge_ready` before checking `working`/`starting`. A watcher refresh after the first file edit can therefore put an actively working agent in Attention.

Gate review tiers on a reviewable lifecycle—usually idle/done/absent—while still letting Blocked override everything.

### 8. Unborn repositories can never become Merge Ready

[`git.rs`](../src-tauri/src/git.rs#L546) reports ancestry as `unavailable` whenever the base HEAD is `None`, while [`reviewStateFor`](../src/stores/agentTasks.ts#L111) only accepts `same` or `ahead`. A repository launched before its first commit remains permanently unreviewed even after checks pass.

Represent an unborn baseline explicitly and define unborn-to-unborn as `same` and unborn-to-first-commit as `ahead`.

### 9. The fingerprint does not cover all Git-relevant state

[`hash_worktree_path`](../src-tauri/src/git.rs#L480) hashes file content but not executable mode. Index hashing uses only the blob, not `IndexEntry.mode`. Dirty submodules hash their checked-out HEAD but not dirty contents. Changes between such states can leave the fingerprint unchanged, contrary to the documentation's “later mutations make it stale” guarantee.

Include index/worktree mode, submodule status, and an explicit representation of conflict stages.

### 10. Task validation can silently omit dependencies and miss active-file variables

[`tasks.ts`](../src/lib/tasks.ts#L87) filters non-string `dependsOn` values instead of reporting them, which can run an incomplete pipeline. [`pipelineModel.ts`](../src/lib/pipelineModel.ts#L9) misses active-file variables including `${fileWorkspaceFolder}`, `${relativeFileDirname}`, `${fileDirnameBasename}`, and `${columnNumber}`. These are documented in the [official VS Code variables reference](https://code.visualstudio.com/docs/reference/variables-reference).

Validate the entire `dependsOn` shape and reject all unsupported or unavailable variables. Also consider restricting parse and duplicate-label errors to the selected reachable DAG; currently one unrelated malformed task blocks every otherwise-valid pipeline.

## Optimization and maintenance

- [`refreshTasksForWorkspace`](../src/stores/agentTasks.ts#L208) launches one full repository hash per agent task. Multiple agents in one large dirty repository cause redundant concurrent reads. Share the expensive current-tree digest per workspace, then compute base-specific changed paths separately.

- Initial agent launch waits for a full snapshot hash before typing the agent command. Large untracked files can noticeably delay launch. Capturing HEAD synchronously and hashing asynchronously would preserve the baseline guarantee without blocking startup.

- [`useInboxItems`](../src/components/AttentionInbox.tsx#L55) subscribes to every workspace terminal store, but its `useMemo` dependencies do not contain the bumped version. Terminal title/layout changes trigger a render while the memo returns stale rows. It also pays for broad subscriptions while the inbox is closed. Use a real aggregate version dependency or narrower external-store selectors.

- Double-clicking Run Checks queues a follow-up because [`runAgentTaskPipeline`](../src/lib/checkPipelines.ts#L192) treats every call during a run as a follow-up. The queued run also inherits the original run's `source`, not the latest request. Disable the button while running and distinguish autorun coalescing from manual clicks.

- The persisted autorun trust parser accepts structurally invalid JSON such as `null`; [`setAutoCheckTrusted`](../src/lib/checkPipelines.ts#L56) can then throw. Validate that the parsed value is a plain object. There should also be a user-visible way to revoke persisted project trust.

- The production build reports a 963 kB main chunk. Lazily loading the inbox detail/check-pipeline UI on first open would keep much of this feature out of startup, although the warning predates or extends beyond this change.

- The new Rust blocks are not rustfmt-clean. The repository-wide `cargo fmt -- --check` also reports older unrelated formatting, so format the touched hunks carefully rather than producing broad churn.

## Verification

Passed:

- `pnpm test`: 39 tests
- `pnpm build`
- `cargo test`: 30 tests
- `cargo check`
- `git diff --cached --check`

Coverage is the bigger concern: [`checkPipelines.test.ts`](../src/lib/checkPipelines.test.ts#L1) only tests DAG validation. There are no tests for pipeline execution, terminal reuse/cancellation, pre/post fingerprint stability, refresh ordering, shell-wrapper edge cases, task parsing, notification activation routing, or the inbox component.

No repository implementation changes were made during this review.
