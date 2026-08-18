# Folder workspaces and optional Git

Talos treats a workspace as a canonical folder root. Git is a capability of a
workspace, not a prerequisite for creating one. Explorer, search, editor, LSP,
tasks, previews, memories, and terminals therefore work for ordinary folders.
Source-control, diff, review-evidence, and worktree operations remain guarded by
repository availability.

## Opening and identity

The frontend calls Rust `workspace_open` before adding a workspace. Rust first
canonicalizes and validates the selected directory. If `git2` discovers a
non-bare repository, opening keeps the historical behavior: any selected path
inside it resolves to its workdir root and receives the repository's
presentation-only tab-group identity. Otherwise the selected directory itself
is the workspace root and receives a unique `folder:<root>` tab-group identity.

Workspace identity is always the canonical root path. Session persistence stores
paths, not a cached Git classification, so restore probes the folder again. A
folder that gained or lost `.git` while Talos was closed reopens with its current
capability. Missing paths are dropped during restore as before.

## Stores and watching

Every workspace owns the same editor, terminal, search, and optional-repository
stores. The repo store starts the existing `watch_repo` backend even when Git is
unavailable. `watcher.rs` already falls back to `<root>/.git` metadata paths when
repository discovery fails, so ordinary filesystem events continue to drive
File Explorer, editor, image, and Markdown reloads through the legacy-named
`repo-changed` event. The repo store ignores those events for Git refreshes
until `isGitRepository` is true.

## Terminal placement and workspace switching

Project terminals are workspace-owned and render in a resizable lower dock in
the left sidebar. The dock has one session-only visibility/height choice for
the app, not a separate remembered open state per workspace. Switching
workspaces swaps the visible project dock while every workspace terminal tree
stays mounted and its PTYs keep running; opening/restoring a workspace never
creates a shell or reveals the dock.

Persistent global terminal groups remain in the center-bottom panel. A group
stores project bindings on its terminal tabs for cwd, color, and explicit
terminal navigation, but stores no last-active workspace. Selecting or
returning to a group therefore never switches or reopens a workspace/editor;
selecting an individual terminal is the explicit navigation action.

## Initializing Git

For an ordinary folder, Source Control renders only **Initialize Repository**.
The action calls Rust `git_init`, which runs `Repository::init` at the exact
workspace root and returns normal repository metadata. The repo store then
performs a one-way session transition from unavailable to available, refreshes
status/log/stashes, and updates the workspace's tab-group identity. The existing
watcher remains valid because the new `.git` directory is inside the watched
root.

Git-only UI is hidden or disabled before this transition: source-control tabs,
titlebar fetch/branch controls, worktree creation/opening, and isolated-worktree
agent launch choices. A failed initialization leaves the folder workspace open
and reports the error in Source Control; no non-Git workspace state is discarded.
