import { createStore, type StoreApi } from "zustand/vanilla";
import {
  gitCheckout,
  gitCherryPick,
  gitCommit,
  gitCreateBranch,
  gitDiscard,
  gitFetch,
  gitInit,
  gitLog,
  gitPull,
  gitPush,
  gitRebase,
  gitReset,
  gitSquash,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashSave,
  gitStatus,
  gitUnstage,
  onRepoChanged,
  unwatchRepo,
  watchRepo,
  type CheckoutKind,
  type CommitInfo,
  type ResetMode,
  type RepoInfo,
  type StatusResult,
  type StashInfo,
} from "../lib/ipc";

const LOG_PAGE = 200;

/** Watcher echoes arriving this soon after an explicit refresh are skipped. */
const POST_MUTATION_QUIET_MS = 400;

export interface RepoState {
  /** Workdir root this store is bound to; fixed for the store's lifetime. */
  repoPath: string;
  repoName: string;
  /** False for an ordinary folder until Git is initialized in place. */
  isGitRepository: boolean;
  initializing: boolean;
  status: StatusResult | null;
  commits: CommitInfo[];
  hasMoreLog: boolean;
  /** When set, the log shows only commits reachable from this ref. */
  logFilter: string | null;
  stashes: StashInfo[];
  /** True while a network op (fetch/pull/push) is in flight. */
  syncing: boolean;
  /** Transient error string surfaced in the status bar; auto-clearable. */
  error: string | null;

  /** Wire the change watcher + first refresh. Called once per workspace. */
  init: () => Promise<void>;
  /** Initialize Git in an ordinary folder and enable repository features. */
  initialize: () => Promise<boolean>;
  /** Unhook the watcher; in-flight results are dropped. */
  dispose: () => void;
  /** Refresh status (+ log/stashes unless `statusOnly`). */
  refresh: (opts?: { statusOnly?: boolean }) => Promise<void>;
  loadMoreLog: () => Promise<void>;
  /** Set (or clear, with null) the branch filter and reload the log. */
  setLogFilter: (refName: string | null) => Promise<void>;

  /** Mutations return true on success (errors land in `error`). */
  stage: (paths: string[]) => Promise<boolean>;
  unstage: (paths: string[]) => Promise<boolean>;
  discard: (paths: string[]) => Promise<boolean>;
  commit: (message: string, amend?: boolean) => Promise<boolean>;
  checkout: (refName: string, kind: CheckoutKind) => Promise<boolean>;
  createBranch: (
    name: string,
    oid: string,
    checkout: boolean,
  ) => Promise<boolean>;
  /** Squash a contiguous run of current-branch commits. Rewrites history. */
  squash: (oids: string[]) => Promise<boolean>;
  /** Rebase the current branch onto a commit oid or branch name. */
  rebase: (onto: string) => Promise<boolean>;
  /** Move HEAD/branch to `oid`. Hard discards all uncommitted changes. */
  reset: (oid: string, mode: ResetMode) => Promise<boolean>;
  /** Apply commits onto HEAD; `oids` must be ordered oldest-first. */
  cherryPick: (oids: string[]) => Promise<boolean>;

  stashSave: (
    message: string | null,
    includeUntracked: boolean,
  ) => Promise<boolean>;
  /** Stash ops address by oid — indices shift when the list changes. */
  stashApply: (oid: string) => Promise<boolean>;
  stashPop: (oid: string) => Promise<boolean>;
  stashDrop: (oid: string) => Promise<boolean>;

  fetch: () => Promise<boolean>;
  pull: () => Promise<boolean>;
  push: () => Promise<boolean>;

  clearError: () => void;
}

export type RepoStore = StoreApi<RepoState>;

/**
 * Which store instance currently owns the Rust-side watch for a root.
 * unwatch_repo removes whatever watcher occupies the path slot, so a stale
 * store (closed, then the same repo reopened) must never fire an unwatch —
 * it would silently kill the NEW workspace's watcher. Every unwatch is
 * therefore gated on still owning the slot.
 */
const watchOwners = new Map<string, object>();

/**
 * Per-workspace optional repository store. One instance per open folder,
 * created (and `init`ed / `dispose`d) by the workspaces store — components
 * reach it via the workspace context hooks in stores/workspaces.ts.
 */
export const createRepoStore = (
  root: string,
  isGitRepository: boolean,
  onInitialized: (info: RepoInfo) => void,
): RepoStore => {
  /** Set by dispose(); async results arriving afterwards are dropped. */
  let disposed = false;
  /** This store's watch-ownership token (see watchOwners). */
  const token = {};
  let unlistenRepoChanged: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the last explicit (mutation-driven) refresh. */
  let lastExplicitRefresh = 0;

  return createStore<RepoState>((set, get) => {
    /** Wraps a git mutation: runs it, surfaces errors, refreshes state. */
    const mutate = async (fn: () => Promise<unknown>): Promise<boolean> => {
      let ok = true;
      try {
        await fn();
        set({ error: null });
      } catch (e) {
        set({ error: String(e) });
        ok = false;
      }
      lastExplicitRefresh = Date.now();
      await get().refresh();
      return ok;
    };

    const netOp = async (fn: () => Promise<{ ok: boolean; output: string }>) => {
      set({ syncing: true });
      const ok = await mutate(async () => {
        const r = await fn();
        if (!r.ok) throw r.output;
      });
      set({ syncing: false });
      return ok;
    };

    return {
      repoPath: root,
      repoName: root.split("/").filter(Boolean).pop() ?? root,
      isGitRepository,
      initializing: false,
      status: null,
      commits: [],
      hasMoreLog: false,
      logFilter: null,
      stashes: [],
      syncing: false,
      error: null,

      init: async () => {
        // Claim the watch slot synchronously, before any await: a reopen of
        // the same root replaces the claim, which neuters this store's
        // (possibly still pending) unwatch calls below.
        watchOwners.set(root, token);
        // The listener sees events for every watched repo — only ours matter.
        const unlisten = await onRepoChanged((change) => {
          if (disposed || change.repoPath !== root) return;
          // The shared workspace watcher still drives explorer/editor reloads
          // for ordinary folders; only repository refreshes are conditional.
          if (!get().isGitRepository) return;
          if (Date.now() - lastExplicitRefresh < POST_MUTATION_QUIET_MS) return;
          // Coalesce with any pending refresh; plain file edits skip the
          // log/stash round trip (statusOnly).
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(
            () => void get().refresh({ statusOnly: !change.gitChanged }),
            150,
          );
        });
        // listen() resolves after the await — the workspace may already be
        // closed (or StrictMode re-ran us); never leave an orphan listener.
        if (disposed || unlistenRepoChanged) {
          unlisten();
          if (disposed) return;
        } else {
          unlistenRepoChanged = unlisten;
        }

        await watchRepo(root).catch(() => {});
        // The workspace may have closed while the watch was being registered
        // — dispose()'s unwatch then ran before the Rust side inserted the
        // watcher, which would leak it for the rest of the session. Clean it
        // up here, unless the repo was reopened and owns the slot now.
        if (disposed) {
          if (watchOwners.get(root) === token) {
            watchOwners.delete(root);
            void unwatchRepo(root).catch(() => {});
          }
          return;
        }
        if (get().isGitRepository) await get().refresh();
      },

      initialize: async () => {
        if (get().isGitRepository) return true;
        if (get().initializing || disposed) return false;
        set({ initializing: true, error: null });
        try {
          const info = await gitInit(root);
          if (disposed) return false;
          set({ isGitRepository: true, error: null });
          onInitialized(info);
          await get().refresh();
          return true;
        } catch (error) {
          if (!disposed) set({ error: String(error) });
          return false;
        } finally {
          if (!disposed) set({ initializing: false });
        }
      },

      dispose: () => {
        disposed = true;
        if (refreshTimer) {
          clearTimeout(refreshTimer);
          refreshTimer = null;
        }
        unlistenRepoChanged?.();
        unlistenRepoChanged = null;
        // Ownership is kept (not deleted) so init()'s post-watch cleanup
        // above still recognizes this store if its watch is mid-registration;
        // a reopen overwrites the claim either way.
        if (watchOwners.get(root) === token) {
          void unwatchRepo(root).catch(() => {});
        }
      },

      refresh: async (opts) => {
        if (!get().isGitRepository) return;
        const { commits, logFilter } = get();
        try {
          if (opts?.statusOnly) {
            const status = await gitStatus(root);
            if (!disposed) set({ status });
            return;
          }
          // keep however many commits the user has paged in (min one page)
          const limit = Math.max(commits.length, LOG_PAGE);
          // Status + stashes must not be held hostage by a failing log fetch:
          // gitLog rejects BY DESIGN when the branch filter went stale (e.g.
          // the filtered branch was deleted in a terminal), so wrap it and
          // keep the other two flowing.
          const [status, stashes, logRes] = await Promise.all([
            gitStatus(root),
            gitStashList(root),
            gitLog(root, limit, 0, logFilter).then(
              (log) => ({ ok: true as const, log }),
              (err) => ({ ok: false as const, err }),
            ),
          ]);
          if (disposed) return;
          // a filter change while we were fetching owns the log now
          const filterChanged = get().logFilter !== logFilter;
          if (logRes.ok) {
            if (filterChanged) set({ status, stashes });
            else
              set({
                status,
                commits: logRes.log.commits,
                hasMoreLog: logRes.log.hasMore,
                stashes,
              });
            return;
          }
          // Log fetch failed. Apply status/stashes regardless so the panel
          // stays live, then recover: a stale filter is dropped and the log
          // reloaded unfiltered; an unfiltered failure is a real repo error.
          set({ status, stashes });
          if (filterChanged) return;
          if (logFilter !== null) {
            set({ logFilter: null, error: String(logRes.err) });
            try {
              const log = await gitLog(root, limit, 0, null);
              if (!disposed && get().logFilter === null) {
                set({ commits: log.commits, hasMoreLog: log.hasMore });
              }
            } catch (e) {
              if (!disposed) set({ error: String(e) });
            }
          } else {
            set({ error: String(logRes.err) });
          }
        } catch (e) {
          if (!disposed) set({ error: String(e) });
        }
      },

      loadMoreLog: async () => {
        const { commits, hasMoreLog, logFilter } = get();
        if (!hasMoreLog) return;
        const baseline = commits;
        try {
          const log = await gitLog(root, LOG_PAGE, commits.length, logFilter);
          // Drop the result if the workspace closed, a concurrent refresh
          // replaced the list we were appending to (avoids duplicates), or the
          // filter changed under us (a failed setLogFilter leaves commits
          // intact, so the identity check alone wouldn't catch it).
          if (disposed || get().commits !== baseline || get().logFilter !== logFilter)
            return;
          set({ commits: [...baseline, ...log.commits], hasMoreLog: log.hasMore });
        } catch (e) {
          if (!disposed) set({ error: String(e) });
        }
      },

      setLogFilter: async (refName) => {
        if (get().logFilter === refName) return;
        set({ logFilter: refName });
        try {
          // Fresh single page: the previous filter's paging depth is moot.
          const log = await gitLog(root, LOG_PAGE, 0, refName);
          // Drop stale results (workspace closed / filter changed again).
          if (disposed || get().logFilter !== refName) return;
          set({ commits: log.commits, hasMoreLog: log.hasMore });
        } catch (e) {
          if (!disposed && get().logFilter === refName) set({ error: String(e) });
        }
      },

      stage: (paths) => mutate(() => gitStage(root, paths)),
      unstage: (paths) => mutate(() => gitUnstage(root, paths)),
      discard: (paths) => mutate(() => gitDiscard(root, paths)),
      commit: (message, amend = false) =>
        mutate(() => gitCommit(root, message, amend)),
      checkout: (refName, kind) => mutate(() => gitCheckout(root, refName, kind)),
      createBranch: (name, oid, checkout) =>
        mutate(() => gitCreateBranch(root, name, oid, checkout)),
      squash: (oids) => mutate(() => gitSquash(root, oids)),
      rebase: (onto) => mutate(() => gitRebase(root, onto)),
      reset: (oid, mode) => mutate(() => gitReset(root, oid, mode)),
      cherryPick: (oids) => mutate(() => gitCherryPick(root, oids)),

      stashSave: (message, includeUntracked) =>
        mutate(() => gitStashSave(root, message, includeUntracked)),
      stashApply: (oid) => mutate(() => gitStashApply(root, oid)),
      stashPop: (oid) => mutate(() => gitStashPop(root, oid)),
      stashDrop: (oid) => mutate(() => gitStashDrop(root, oid)),

      fetch: () => netOp(() => gitFetch(root)),
      pull: () => netOp(() => gitPull(root)),
      push: () => netOp(() => gitPush(root)),

      clearError: () => set({ error: null }),
    };
  });
};
