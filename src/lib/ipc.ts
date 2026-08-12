/**
 * Typed IPC contract between the React frontend and the Rust (Tauri) backend.
 *
 * This file is the single source of truth for command names and payload
 * shapes. Rust structs use #[serde(rename_all = "camelCase")] so wire shapes
 * match these types exactly. Tauri converts snake_case Rust command args to
 * camelCase on the JS side (e.g. repo_path -> repoPath).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentRuntimeState } from "./agentState";

// ---------------------------------------------------------------------------
// Localhost preview types
// ---------------------------------------------------------------------------

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Page zoom that makes the fitted child view expose the requested CSS viewport. */
  pageZoom: number;
}

export interface PreviewServer {
  url: string;
  port: number;
  pid: number | null;
  process: string;
  cwd: string | null;
  framework: string | null;
  projectMatch: boolean;
}

export interface PreviewLoadEvent {
  id: string;
  url: string;
  phase: "started" | "finished";
}

export interface PreviewExternalEvent {
  id: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Localhost preview commands
// ---------------------------------------------------------------------------

// React StrictMode and repeated refresh gestures can overlap effect lifetimes.
// Share an in-flight scan per workspace so each one owns only one bounded
// native worker pool; a completed request is immediately refreshable.
const previewServerRequests = new Map<string, Promise<PreviewServer[]>>();

export const previewServers = (workspacePath: string): Promise<PreviewServer[]> => {
  const existing = previewServerRequests.get(workspacePath);
  if (existing) return existing;

  const request = invoke<PreviewServer[]>("preview_servers", { workspacePath });
  previewServerRequests.set(workspacePath, request);
  const clear = () => {
    if (previewServerRequests.get(workspacePath) === request) {
      previewServerRequests.delete(workspacePath);
    }
  };
  void request.then(clear, clear);
  return request;
};

export const previewCreate = (
  id: string,
  url: string,
  bounds: PreviewBounds,
): Promise<void> => invoke("preview_create", { id, url, bounds });

export const previewNavigate = (id: string, url: string): Promise<void> =>
  invoke("preview_navigate", { id, url });

export const previewBack = (id: string): Promise<void> =>
  invoke("preview_back", { id });

export const previewForward = (id: string): Promise<void> =>
  invoke("preview_forward", { id });

export const previewReload = (id: string): Promise<void> =>
  invoke("preview_reload", { id });

export const previewSetBounds = (
  id: string,
  bounds: PreviewBounds,
): Promise<void> => invoke("preview_set_bounds", { id, bounds });

export const previewSetVisible = (
  id: string,
  visible: boolean,
): Promise<void> => invoke("preview_set_visible", { id, visible });

export const previewFocus = (id: string): Promise<void> =>
  invoke("preview_focus", { id });

export const previewClose = (id: string): Promise<void> =>
  invoke("preview_close", { id });

export const previewCloseMany = (ids: string[]): Promise<void> =>
  invoke("preview_close_many", { ids });

export const onPreviewLoad = (
  cb: (value: PreviewLoadEvent) => void,
): Promise<UnlistenFn> =>
  listen<PreviewLoadEvent>("preview-load", (event) => cb(event.payload));

export const onPreviewExternal = (
  cb: (value: PreviewExternalEvent) => void,
): Promise<UnlistenFn> =>
  listen<PreviewExternalEvent>("preview-external", (event) => cb(event.payload));

// ---------------------------------------------------------------------------
// Git types
// ---------------------------------------------------------------------------

/** Single-letter status codes, VSCode-style. '?' = untracked. */
export type StatusCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

export interface FileStatus {
  path: string;
  /** Previous path when status is R (rename) or C (copy). */
  origPath?: string | null;
  status: StatusCode;
}

export interface BranchInfo {
  /** Branch name, or short oid when detached. */
  name: string;
  detached: boolean;
  ahead: number;
  behind: number;
}

export interface StatusResult {
  branch: BranchInfo;
  staged: FileStatus[];
  /** Includes untracked files with status '?'. */
  unstaged: FileStatus[];
}

export interface GitReviewSnapshot {
  head: string | null;
  baseAncestry: "same" | "ahead" | "diverged" | "unavailable";
  changedFiles: string[];
  conflictedFiles: string[];
  /** Opaque per-path hashes for latest-turn comparison; never file contents. */
  fileFingerprints: Record<string, string>;
  /** SHA-256 over HEAD plus sorted staged/worktree/untracked content. */
  fingerprint: string;
}

export interface GitCheckpointSnapshot {
  /** Unreachable tree containing the exact checkpointed worktree state. */
  tree: string;
  /** Review hashes captured under the same repository-generation guard. */
  snapshot: GitReviewSnapshot;
}

export interface RefLabel {
  /** Short name, e.g. "main", "origin/main", "v1.0.0". */
  name: string;
  kind: "local" | "remote" | "tag";
}

export interface CommitInfo {
  oid: string;
  /** First line of the commit message. */
  summary: string;
  author: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  parents: string[];
  refs: RefLabel[];
  isHead: boolean;
}

export interface LogResult {
  commits: CommitInfo[];
  hasMore: boolean;
}

export interface CommitFile {
  path: string;
  origPath?: string | null;
  status: StatusCode;
}

export type DiffKind = "worktree" | "staged" | "commit" | "checkpoint";

export interface DiffPayload {
  oldText: string;
  newText: string;
  /** e.g. "HEAD", "Index", "abc1234", "Working Tree" */
  oldLabel: string;
  newLabel: string;
  binary: boolean;
}

export interface StashInfo {
  index: number;
  message: string;
  oid: string;
}

export interface GitOpResult {
  ok: boolean;
  /** Combined stdout/stderr of the underlying `git` CLI call. */
  output: string;
}

export interface RepoInfo {
  /** Absolute path of the repository workdir root. */
  root: string;
  /** Opaque presentation identity for equivalent clone/worktree header tabs. */
  tabGroupId: string;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  /** The primary checkout, which is never removable through task cleanup. */
  main: boolean;
}

export interface GitWorktreeCreateResult {
  worktree: GitWorktree;
  baseCommit: string;
}

// ---------------------------------------------------------------------------
// FS types
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileContent {
  text: string;
  binary: boolean;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface WorkspaceFiles {
  /** Repo-root-relative POSIX paths, sorted. */
  files: string[];
  truncated: boolean;
}

export interface SearchMatch {
  /** 1-based. */
  lineNumber: number;
  /** 1-based UTF-16 column of the match start in the full line (for the cursor). */
  column: number;
  /** Display window around the match (long lines are trimmed server-side). */
  text: string;
  /** UTF-16 highlight range within `text`. */
  start: number;
  end: number;
}

export interface SearchFileResult {
  /** Repo-root-relative POSIX path. */
  file: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFileResult[];
  totalMatches: number;
  /** A result cap was hit: there may be more matches than returned. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Git commands
// ---------------------------------------------------------------------------

/** Validate + open a repository (any path inside it works). */
export const gitOpen = (path: string): Promise<RepoInfo> =>
  invoke("git_open", { path });

export const gitWorktreeList = (repoPath: string): Promise<GitWorktree[]> =>
  invoke("git_worktree_list", { repoPath });

export const gitWorktreeOpen = (repoPath: string, path: string): Promise<RepoInfo> =>
  invoke("git_worktree_open", { repoPath, path });

export const gitWorktreeCreate = (
  repoPath: string,
  path: string,
  branch: string | null,
  base: string,
  includeIgnored: string[],
): Promise<GitWorktreeCreateResult> =>
  invoke("git_worktree_create", { repoPath, path, branch, base, includeIgnored });

/** Remove the checkout only; its branch is intentionally retained. */
export const gitWorktreeRemove = (
  repoPath: string,
  path: string,
  force = false,
): Promise<void> => invoke("git_worktree_remove", { repoPath, path, force });

/** Merge a clean, committed task checkout into its clean parent checkout. */
export const gitWorktreeMerge = (
  parentPath: string,
  worktreePath: string,
): Promise<void> => invoke("git_worktree_merge", { parentPath, worktreePath });

export const gitReviewSnapshot = (
  repoPath: string,
  baseHead?: string | null,
  baseUnborn = false,
): Promise<GitReviewSnapshot> =>
  invoke("git_review_snapshot", { repoPath, baseHead: baseHead ?? null, baseUnborn });

/** Cheap launch boundary for review ownership; null is a successfully
 * captured unborn repository, while rejection means no boundary was proven. */
export const gitReviewHead = (repoPath: string): Promise<string | null> =>
  invoke("git_review_head", { repoPath });

/** One stable capture of the unreachable checkpoint tree and review hashes. */
export const gitCheckpointSnapshot = (
  repoPath: string,
  baseHead?: string | null,
  baseUnborn = false,
): Promise<GitCheckpointSnapshot> =>
  invoke("git_checkpoint_snapshot", { repoPath, baseHead: baseHead ?? null, baseUnborn });

export const gitStatus = (repoPath: string): Promise<StatusResult> =>
  invoke("git_status", { repoPath });

export const gitStage = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_stage", { repoPath, paths });

export const gitUnstage = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_unstage", { repoPath, paths });

/** Restore files to their HEAD/index state. Destructive; confirm in UI first. */
export const gitDiscard = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_discard", { repoPath, paths });

/** Returns the new commit oid. */
export const gitCommit = (
  repoPath: string,
  message: string,
  amend: boolean,
): Promise<string> => invoke("git_commit", { repoPath, message, amend });

/** `refName` (a short ref name) limits the log to commits reachable from it. */
export const gitLog = (
  repoPath: string,
  limit: number,
  skip: number,
  refName?: string | null,
): Promise<LogResult> =>
  invoke("git_log", { repoPath, limit, skip, refName: refName ?? null });

/** Files changed by a commit (vs its first parent). */
export const gitCommitFiles = (
  repoPath: string,
  oid: string,
): Promise<CommitFile[]> => invoke("git_commit_files", { repoPath, oid });

/**
 * Old/new file contents for a diff:
 *  - worktree: index (or HEAD if not in index) vs working tree
 *  - staged:   HEAD vs index
 *  - commit:   first parent of `oid` vs `oid` (oid required)
 *  - checkpoint: private checkpoint tree `oid` vs current worktree (read-only)
 * For renames pass `origPath` so the old side is read from the pre-rename
 * path instead of showing a whole-file add.
 */
export const gitDiffFile = (
  repoPath: string,
  path: string,
  kind: DiffKind,
  oid?: string,
  origPath?: string | null,
): Promise<DiffPayload> =>
  invoke("git_diff_file", {
    repoPath,
    path,
    kind,
    oid: oid ?? null,
    origPath: origPath ?? null,
  });

export const gitStashList = (repoPath: string): Promise<StashInfo[]> =>
  invoke("git_stash_list", { repoPath });

export const gitStashSave = (
  repoPath: string,
  message: string | null,
  includeUntracked: boolean,
): Promise<void> =>
  invoke("git_stash_save", { repoPath, message, includeUntracked });

/** Stash ops address by oid — indices shift when the list changes. */
export const gitStashApply = (repoPath: string, oid: string): Promise<void> =>
  invoke("git_stash_apply", { repoPath, oid });

export const gitStashPop = (repoPath: string, oid: string): Promise<void> =>
  invoke("git_stash_pop", { repoPath, oid });

export const gitStashDrop = (repoPath: string, oid: string): Promise<void> =>
  invoke("git_stash_drop", { repoPath, oid });

/** Network ops shell out to the `git` CLI so user auth (ssh/credhelper) works. */
export const gitFetch = (repoPath: string): Promise<GitOpResult> =>
  invoke("git_fetch", { repoPath });

export const gitPull = (repoPath: string): Promise<GitOpResult> =>
  invoke("git_pull", { repoPath });

export const gitPush = (repoPath: string): Promise<GitOpResult> =>
  invoke("git_push", { repoPath });

export type CheckoutKind = "local" | "remote" | "tag" | "commit";

/**
 * Checkout via the `git` CLI (keeps git's own dirty-worktree safety checks
 * and messages). kind:
 *  - local:  switch to the branch
 *  - remote: switch to a local branch tracking it (created when missing)
 *  - tag | commit: detached checkout
 */
export const gitCheckout = (
  repoPath: string,
  refName: string,
  kind: CheckoutKind,
): Promise<void> => invoke("git_checkout", { repoPath, refName, kind });

export const gitCreateBranch = (
  repoPath: string,
  name: string,
  oid: string,
  checkout: boolean,
): Promise<void> => invoke("git_create_branch", { repoPath, name, oid, checkout });

/**
 * Squash a contiguous run of commits on the current branch's first-parent
 * chain into one commit (descendants are rebased on top). Rewrites history;
 * confirm in UI first. The backend validates contiguity/reachability.
 */
export const gitSquash = (repoPath: string, oids: string[]): Promise<void> =>
  invoke("git_squash", { repoPath, oids });

/**
 * Rebase the current branch onto `onto` — a full commit oid or a branch
 * short name. Rewrites history; confirm in UI first. Conflicts auto-abort
 * and reject with the git error.
 */
export const gitRebase = (repoPath: string, onto: string): Promise<void> =>
  invoke("git_rebase", { repoPath, onto });

export type ResetMode = "soft" | "mixed" | "hard";

/** `git reset --<mode> <oid>`. Hard is destructive; confirm in UI first. */
export const gitReset = (
  repoPath: string,
  oid: string,
  mode: ResetMode,
): Promise<void> => invoke("git_reset", { repoPath, oid, mode });

/**
 * Cherry-pick `oids` onto HEAD, applied in array order — callers must pass
 * them OLDEST-FIRST (the graph displays newest-first; reverse before
 * calling). Conflicts auto-abort the whole sequence.
 */
export const gitCherryPick = (repoPath: string, oids: string[]): Promise<void> =>
  invoke("git_cherry_pick", { repoPath, oids });

/** All local + remote branches (locals first, alphabetical). */
export const gitListRefs = (repoPath: string): Promise<RefLabel[]> =>
  invoke("git_list_refs", { repoPath });

/**
 * Generate a commit message from the staged diff via the `claude` CLI
 * (print mode, Sonnet). Slow (an LLM round-trip) — show progress in the UI.
 * Rejects when nothing is staged or the CLI is unavailable/fails.
 */
export const gitGenerateCommitMessage = (repoPath: string): Promise<string> =>
  invoke("git_generate_commit_message", { repoPath });

// ---------------------------------------------------------------------------
// FS commands
// ---------------------------------------------------------------------------

/** Lists a directory, dirs first then files, both alphabetical. `.git` is omitted. */
export const fsReadDir = (path: string): Promise<DirEntry[]> =>
  invoke("fs_read_dir", { path });

/** Reads a UTF-8 text file. Files > 5 MB are truncated; binaries flagged. */
export const fsReadFile = (path: string): Promise<FileContent> =>
  invoke("fs_read_file", { path });

export const fsWriteFile = (path: string, text: string): Promise<void> =>
  invoke("fs_write_file", { path, text });

/** Creates an empty file; rejects when the path already exists. */
export const fsCreateFile = (path: string): Promise<void> =>
  invoke("fs_create_file", { path });

/** Creates a directory; rejects when the path already exists. */
export const fsCreateDir = (path: string): Promise<void> =>
  invoke("fs_create_dir", { path });

/** Rename/move; rejects instead of overwriting an existing target
 *  (case-only renames excepted). */
export const fsRename = (from: string, to: string): Promise<void> =>
  invoke("fs_rename", { from, to });

/** Move a file or directory to the macOS Trash (recoverable). */
export const fsTrash = (path: string): Promise<void> =>
  invoke("fs_trash", { path });

/** Copy `src` into `destDir` (recursive; symlinks kept as links), with
 *  Finder-style "name copy.ext" uniquifying on collision. Resolves with
 *  the created path. */
export const fsCopy = (src: string, destDir: string): Promise<string> =>
  invoke("fs_copy", { src, destDir });

/** Select the entry in a Finder window. */
export const fsReveal = (path: string): Promise<void> =>
  invoke("fs_reveal", { path });

/** Open an http(s)/mailto URL in the default app (other schemes reject). */
export const openUrl = (url: string): Promise<void> =>
  invoke("open_url", { url });

// ---------------------------------------------------------------------------
// Search commands
// ---------------------------------------------------------------------------

/**
 * All worktree files (gitignore-respected, `.git` excluded, dotfiles
 * included), capped at 50k. Cheap paths-only walk — fetched fresh per
 * quick-open, no caching/watcher involved.
 */
export const listWorkspaceFiles = (repoPath: string): Promise<WorkspaceFiles> =>
  invoke("list_workspace_files", { repoPath });

/**
 * Content search over the worktree (parallel walk; binary/oversized files
 * skipped with the editor's rules; 2000-match global cap). Rejects with the
 * regex error message when `regex` is set and the pattern is invalid.
 */
export const searchWorkspace = (
  repoPath: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  regex: boolean,
): Promise<SearchResult> =>
  invoke("search_workspace", { repoPath, query, caseSensitive, wholeWord, regex });

// ---------------------------------------------------------------------------
// Repo watcher
// ---------------------------------------------------------------------------

export interface RepoChanged {
  repoPath: string;
  /**
   * True when git metadata (HEAD / index / refs) changed — commit log and
   * stashes may be stale, not just file contents / status.
   */
  gitChanged: boolean;
}

/**
 * Starts a debounced recursive watcher over the repo workdir (+ the real git
 * dir, including linked worktrees). Emits "repo-changed" with a RepoChanged
 * payload. One watch per repo root; re-watching a root replaces its watcher.
 * Listeners receive events for EVERY watched repo — filter by `repoPath`.
 */
export const watchRepo = (repoPath: string): Promise<void> =>
  invoke("watch_repo", { repoPath });

export const unwatchRepo = (repoPath: string): Promise<void> =>
  invoke("unwatch_repo", { repoPath });

export const onRepoChanged = (
  cb: (change: RepoChanged) => void,
): Promise<UnlistenFn> =>
  listen<RepoChanged>("repo-changed", (e) => cb(e.payload));

// ---------------------------------------------------------------------------
// PTY commands
// ---------------------------------------------------------------------------

/**
 * Spawns the user's login shell ($SHELL -l, fallback /bin/zsh) in a new PTY.
 * The caller generates `id` (crypto.randomUUID()) and attaches the
 * `pty-data:<id>` / `pty-exit:<id>` listeners BEFORE calling this, so no
 * early output is lost. Output events carry a base64 payload; exit carries
 * the exit code. `agent` panes get the notification-capable TERM_PROGRAM
 * masquerade (so agent CLIs emit OSC 9/777 for the activity tracker); plain
 * panes get an unset TERM_PROGRAM.
 */
export const ptySpawn = (
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  agent: boolean,
): Promise<void> => invoke("pty_spawn", { id, cwd, cols, rows, agent });

/** Write user input (UTF-8 string from xterm onData). */
export const ptyWrite = (id: string, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

export const ptyResize = (
  id: string,
  cols: number,
  rows: number,
): Promise<void> => invoke("pty_resize", { id, cols, rows });

export const ptyKill = (id: string): Promise<void> => invoke("pty_kill", { id });

/** Bounded `<resolved executable> --version` health probe. */
export const executableVersion = (path: string): Promise<string> =>
  invoke("executable_version", { path });

export interface NativeSessionCandidate {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Opaque Codex thread ids created in an exact checkout after a launch
 * boundary. No prompt, title, preview, or transcript data crosses IPC. */
export const codexNativeSessionCandidates = (
  projectPath: string,
  branch: string | null,
  createdAfterMs: number,
): Promise<NativeSessionCandidate[]> =>
  invoke("codex_native_session_candidates", { projectPath, branch, createdAfterMs });

export const codexNativeSessionExists = (
  projectPath: string,
  id: string,
): Promise<boolean> => invoke("codex_native_session_exists", { projectPath, id });

export interface AgentControlRequest {
  requestId: string;
  /** Backend-generated identity for this exact delivery. Unlike the
   * caller-facing requestId, this value is never reused. */
  deliveryId: string;
  action: "focus" | "prompt" | "start";
  terminalId: string | null;
  generation: number | null;
  text: string | null;
  mode: "queue" | "steer" | null;
  workspacePath: string | null;
  kind: "claude" | "codex" | null;
  taskName: string | null;
  isolated: boolean;
  /** Backend-owned absolute deadline; frontend actions recheck it at every
   * asynchronous side-effect boundary so a delayed cancel event is safe. */
  deadlineAtMs: number;
}

export interface AgentControlInfo {
  socketPath: string;
  tokenPath: string;
  cliPath: string;
  skillPath: string;
}

export const agentControlSync = (agents: AgentRuntimeState[]): Promise<void> =>
  invoke("agent_control_sync", { agents });

export const agentControlRespond = (
  requestId: string,
  deliveryId: string,
  ok: boolean,
  result?: unknown,
  error?: string,
): Promise<void> => invoke("agent_control_respond", {
  requestId,
  deliveryId,
  ok,
  result: result ?? null,
  error: error ?? null,
});

export interface AgentControlPromptBoundary {
  seq: number;
  working: boolean;
}

/** Atomically capture the Rust event sequence and pinned occupant state
 * immediately before a prompt reaches its PTY. */
export const agentControlPromptBoundary = (
  requestId: string,
  deliveryId: string,
): Promise<AgentControlPromptBoundary> =>
  invoke("agent_control_prompt_boundary", { requestId, deliveryId });

export const agentControlInfo = (): Promise<AgentControlInfo> =>
  invoke("agent_control_info");

export const onAgentControlRequest = (
  callback: (request: AgentControlRequest) => void,
): Promise<UnlistenFn> => listen<AgentControlRequest>(
  "agent-control-request",
  (event) => callback(event.payload),
);

export interface AgentControlCancel {
  requestId: string;
  deliveryId: string;
}

export const onAgentControlCancel = (
  callback: (request: AgentControlCancel) => void,
): Promise<UnlistenFn> => listen<AgentControlCancel>(
  "agent-control-cancel",
  (event) => callback(event.payload),
);

/**
 * Flow control: acknowledge `bytes` of PTY output as consumed (xterm finished
 * parsing them). The Rust reader thread parks once too many bytes are in
 * flight unacknowledged, so a chatty child (`yes`, a huge `cat`) can't flood
 * the webview event queue and freeze the UI. Call from term.write's
 * completion callback with the decoded chunk length.
 */
export const ptyAck = (id: string, bytes: number): Promise<void> =>
  invoke("pty_ack", { id, bytes });

export interface AgentProcessTarget {
  terminalId: string;
  executableNames: string[];
}

export interface AgentProcessInfo {
  pid: number;
  parentPid: number;
  /** Nearest matching agent ancestor; helper processes are skipped. */
  parentAgentPid: number | null;
  /** First matching agent process below the PTY shell. */
  rootAgentPid: number;
  executable: string;
  foreground: boolean;
}

export interface AgentProcessSnapshot {
  terminalId: string;
  processes: AgentProcessInfo[];
}

/** One privacy-bounded process-table snapshot for every live agent PTY.
 * Executable basenames are returned; arguments and environments never are. */
export const agentProcessSnapshot = (
  targets: AgentProcessTarget[],
): Promise<AgentProcessSnapshot[]> =>
  invoke("pty_agent_process_snapshot", { targets });

/** Decoded PTY output bytes — feed directly to xterm.write(). */
export const onPtyData = (
  id: string,
  cb: (data: Uint8Array) => void,
): Promise<UnlistenFn> =>
  listen<string>(`pty-data:${id}`, (e) => cb(base64ToBytes(e.payload)));

export const onPtyExit = (
  id: string,
  cb: (code: number | null) => void,
): Promise<UnlistenFn> =>
  listen<number | null>(`pty-exit:${id}`, (e) => cb(e.payload));

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// LSP commands (used exclusively by src/lib/lsp/ — never by components)
// ---------------------------------------------------------------------------

export interface LspResolveResult {
  /** Absolute path of the executable, or null when not found. */
  path: string | null;
  /** Where it was found: workspace-local bin dir or the login-shell PATH. */
  source: "local" | "path" | null;
}

export interface LspExit {
  code: number | null;
  /** Last ~4 KiB of server stderr, for crash reporting. */
  stderrTail: string;
}

/**
 * Locate a language-server binary: `localCandidates` (absolute paths, e.g.
 * <root>/node_modules/.bin/...) first, then the user's login-shell PATH
 * (cached backend-side; `refresh` re-runs the shell). Also warms the PATH
 * cache that lsp_start injects into server children — always call this
 * before lspStart.
 */
export const lspResolve = (
  bin: string,
  localCandidates: string[],
  refresh: boolean,
): Promise<LspResolveResult> =>
  invoke("lsp_resolve", { bin, localCandidates, refresh });

/**
 * Spawns a language server speaking LSP over stdio. The caller generates
 * `id` (crypto.randomUUID()) and attaches the `lsp-message:<id>` /
 * `lsp-exit:<id>` listeners BEFORE calling this, so no early output is lost.
 * `cmd` must be an absolute path from lspResolve. Resolves with the host
 * app's pid — sent as initialize's processId so servers self-exit if the
 * app dies without running any teardown (the spec's parent-death watch).
 */
export const lspStart = (
  id: string,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<number> => invoke("lsp_start", { id, cmd, args, cwd });

/**
 * Send one complete JSON-RPC message (already serialized). Rust owns the
 * Content-Length framing — never frame on this side.
 */
export const lspSend = (id: string, payload: string): Promise<void> =>
  invoke("lsp_send", { id, payload });

/** SIGTERM → SIGKILL teardown; the protocol-level shutdown happens first. */
export const lspStop = (id: string): Promise<void> => invoke("lsp_stop", { id });

/** One event per complete LSP frame; payload is the raw JSON message body. */
export const onLspMessage = (
  id: string,
  cb: (raw: string) => void,
): Promise<UnlistenFn> =>
  listen<string>(`lsp-message:${id}`, (e) => cb(e.payload));

export const onLspExit = (
  id: string,
  cb: (exit: LspExit) => void,
): Promise<UnlistenFn> =>
  listen<LspExit>(`lsp-exit:${id}`, (e) => cb(e.payload));

// ---------------------------------------------------------------------------
// Attention alerts (notify.rs)
// ---------------------------------------------------------------------------

/** "unsupported" = no app bundle (bare `tauri dev`) — banners can't work
 *  there, but playSound still does. */
export type NotificationPermission =
  | "granted"
  | "denied"
  | "prompt"
  | "unsupported";

export const notificationState = (): Promise<NotificationPermission> =>
  invoke("notification_state");

/** Shows the OS authorization prompt when state is "prompt"; resolves only
 *  once the user answers it. */
export const notificationRequest = (): Promise<NotificationPermission> =>
  invoke("notification_request");

/** Fire-and-forget banner (soundless — the attention sound is app-played
 *  via playSound). id = stable identifier (terminal id): a repeat send
 *  REPLACES the delivered banner instead of stacking, and dismiss removes
 *  by it. presentForeground = also present while the app is frontmost
 *  (answered by notify.rs' willPresent delegate — without it the OS
 *  silently drops foreground banners). Unauthorized posts are dropped by
 *  the OS; dev is a no-op. */
export const notificationSend = (
  id: string,
  title: string,
  body: string,
  presentForeground: boolean,
): Promise<void> =>
  invoke("notification_send", { id, title, body, presentForeground });

/** Remove the delivered banner posted under this identifier (no-op when
 *  none exists, or in dev). */
export const notificationDismiss = (id: string): Promise<void> =>
  invoke("notification_dismiss", { id });

export interface NotificationActivation {
  terminalId: string;
}

/** Install the listener first, then mark it ready so a startup click cannot
 * be lost between native activation and frontend registration. */
export const listenNotificationActivations = async (
  cb: (activation: NotificationActivation) => void,
): Promise<UnlistenFn> => {
  const unlisten = await listen<NotificationActivation>(
    "notification-activation",
    (event) => cb(event.payload),
  );
  try {
    await invoke("notification_activation_ready");
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
};

/** Play an audio file through afplay (any format it handles). Rejects when
 *  afplay can't spawn or the file doesn't exist (so callers can fall back);
 *  a corrupt-but-present file still just plays nothing. */
export const playSound = (path: string): Promise<void> =>
  invoke("play_sound", { path });

// ---------------------------------------------------------------------------
// Claude usage (usage.rs)
// ---------------------------------------------------------------------------

export interface UsageLimit {
  /** 0–100, may be fractional. */
  utilization: number;
  /** ISO-8601 reset instant, or null when the window hasn't started. */
  resetsAt: string | null;
}

export interface ModelUsageLimit extends UsageLimit {
  /** Server-supplied model-bucket label (for example, "Fable"). */
  displayName: string;
}

/** Live subscription rate-limit windows (any may be null when the account
 *  lacks that window or it hasn't been touched this period). */
export interface ClaudeUsage {
  fiveHour: UsageLimit | null;
  sevenDay: UsageLimit | null;
  sevenDayOpus: UsageLimit | null;
  sevenDaySonnet: UsageLimit | null;
  /** Model-specific weekly windows from the endpoint's generic limits array. */
  modelScoped: ModelUsageLimit[];
}

/**
 * Discriminated usage result. `unauthenticated` = no Claude Code login on
 * this machine; `expired` = its access token lapsed (Claude Code refreshes it
 * on next use — we never do, to avoid desyncing its login).
 */
export type UsageState =
  | { status: "ok"; usage: ClaudeUsage }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | { status: "error"; message: string };

/**
 * Read Claude Code's existing OAuth access token and fetch the live
 * subscription rate-limit gauges (5-hour / weekly windows) from Anthropic.
 * Read-only: never refreshes or rewrites that token. The first keychain read
 * may prompt for access.
 */
export const claudeUsage = (): Promise<UsageState> => invoke("claude_usage");

export interface CodexUsageLimit {
  utilization: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
  windowMinutes: number | null;
}

export interface CodexUsage {
  fiveHour: CodexUsageLimit | null;
  sevenDay: CodexUsageLimit | null;
  planType: string | null;
  /** Expiry instants (unix seconds, ascending) of banked rate-limit reset
   * credits still available to redeem. */
  resetCreditExpiries: number[];
}

export type CodexUsageState =
  | { status: "ok"; usage: CodexUsage }
  | { status: "unauthenticated" }
  | { status: "error"; message: string };

/** Query the installed Codex CLI's app-server for the active account's
 * rolling usage windows. Codex owns all credential access and refresh. */
export const codexUsage = (): Promise<CodexUsageState> => invoke("codex_usage");

// ---------------------------------------------------------------------------
// Project memories (memories.rs)
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  /** Stable id for React keys (file path or Codex thread id). */
  id: string;
  title: string;
  description: string;
  /** Short source/type chip: memory type, "Auto-memory", or "AGENTS.md". */
  kind: string;
  /** Full markdown body (Claude frontmatter stripped). */
  content: string;
}

export interface ProjectMemories {
  /** Claude Code memories under ~/.claude/projects/<munged>/memory/. */
  claude: MemoryEntry[];
  /** Codex per-project auto-memories (sqlite) plus the repo's AGENTS.md. */
  codex: MemoryEntry[];
}

/**
 * Both agents' memories for the project at `projectPath` (a repo root). Read
 * fresh from disk / sqlite on every call — no watcher. Never rejects for a
 * missing store; absent sources come back as empty arrays.
 */
export const memoriesList = (projectPath: string): Promise<ProjectMemories> =>
  invoke("memories_list", { projectPath });
