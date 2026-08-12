//! Debounced repository watcher.
//!
//! Watches the repo workdir recursively (plus the real git dir for linked
//! worktrees) and emits a single "repo-changed" event per burst of activity.
//! The payload tells the frontend whether git metadata (HEAD / index / refs)
//! changed, so it can skip re-fetching the commit log for plain file edits.
//!
//! Debounce layering (documented once, here): this module waits for a 250 ms
//! quiet period (capped at 1 s) before emitting; the repo store adds a tiny
//! 150 ms timer to coalesce the emit with its own explicit refreshes; the
//! file explorer debounces its directory re-reads separately (300 ms) because
//! they are much cheaper than a git status+log round trip.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{recommended_watcher, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::Emitter;

/// Keeps the watcher alive; dropping it stops watching.
pub struct ActiveWatch {
    _watcher: RecommendedWatcher,
}

/// One watcher per open repository, keyed by workdir root.
#[derive(Default)]
pub struct WatcherState {
    active: Mutex<HashMap<String, ActiveWatch>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    repo_path: String,
    /// True when HEAD / index / refs changed (commit, branch switch, stage…),
    /// meaning the log and stashes may be stale — not just file contents.
    git_changed: bool,
}

/// What a batch of fs events means for the app.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Hit {
    Worktree,
    GitMeta,
}

fn classify(path: &Path, git_dir: &Path, common_dir: &Path) -> Option<Hit> {
    let s = path.to_string_lossy();
    if s.contains("/node_modules/") || s.contains("/target/") || s.contains("/.DS_Store") {
        return None;
    }
    // The shared worktree administration directory changes when any linked
    // checkout is added, removed, locked, unlocked, or pruned. Treat the
    // entire subtree as Git metadata so every open checkout refreshes its
    // repository-wide worktree list.
    if path.starts_with(common_dir.join("worktrees")) {
        return Some(Hit::GitMeta);
    }
    if path.starts_with(git_dir) || path.starts_with(common_dir) {
        // Only HEAD / FETCH_HEAD / ORIG_HEAD..., the index, and refs matter.
        if s.ends_with("HEAD") || s.ends_with("index") || s.contains("/refs/") {
            return Some(Hit::GitMeta);
        }
        return None;
    }
    Some(Hit::Worktree)
}

#[tauri::command]
pub async fn watch_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    repo_path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&repo_path);

    // Resolve the real git dir: for linked worktrees `.git` is a file pointing
    // elsewhere, and refs live in the shared commondir.
    let (git_dir, common_dir) = match git2::Repository::open(&root) {
        Ok(r) => (r.path().to_path_buf(), r.commondir().to_path_buf()),
        Err(_) => (root.join(".git"), root.join(".git")),
    };
    let common_refs = common_dir.join("refs");
    let common_worktrees = common_dir.join("worktrees");

    // Debouncer: the watcher callback pushes classified hits into this
    // channel; a dedicated thread waits for a 250 ms quiet period (max 1 s)
    // and emits one event carrying whether git metadata was touched. When the
    // watcher (and thus the sender) is dropped, recv() errors and the thread
    // exits.
    let (tx, rx) = mpsc::channel::<Hit>();
    {
        let app = app.clone();
        let repo_path = repo_path.clone();
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut git_changed = matches!(first, Hit::GitMeta);
                let started = std::time::Instant::now();
                while let Ok(hit) = rx.recv_timeout(Duration::from_millis(250)) {
                    git_changed |= matches!(hit, Hit::GitMeta);
                    if started.elapsed() > Duration::from_secs(1) {
                        break; // sustained storm: don't starve the UI
                    }
                }
                let _ = app.emit(
                    "repo-changed",
                    RepoChanged {
                        repo_path: repo_path.clone(),
                        git_changed,
                    },
                );
            }
        });
    }

    let filter_git_dir = git_dir.clone();
    let filter_common_dir = common_dir.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.need_rescan() || event.paths.is_empty() {
            // We may have missed anything — treat as a full (git too) change.
            let _ = tx.send(Hit::GitMeta);
            return;
        }
        for p in &event.paths {
            if let Some(hit) = classify(p, &filter_git_dir, &filter_common_dir) {
                let _ = tx.send(hit);
                return;
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Linked worktree: HEAD/index live outside the workdir — watch them too.
    if !git_dir.starts_with(&root) {
        let _ = watcher.watch(&git_dir, RecursiveMode::NonRecursive);
        let _ = watcher.watch(&common_refs, RecursiveMode::Recursive);
        // Sibling worktree records do not live under this checkout's git_dir.
        // Watch the shared parent for directory creation/removal and the
        // existing subtree for record contents.
        let _ = watcher.watch(&common_dir, RecursiveMode::NonRecursive);
        let _ = watcher.watch(&common_worktrees, RecursiveMode::Recursive);
    }

    // Re-watching the same root replaces (and thus drops) the previous
    // watcher, which stops it and shuts down its debounce thread.
    state
        .active
        .lock()
        .insert(repo_path, ActiveWatch { _watcher: watcher });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_worktree_administration_is_git_metadata() {
        let common = Path::new("/repo/.git");
        let linked_git = common.join("worktrees/task-one");
        assert_eq!(
            classify(
                &common.join("worktrees/task-two/gitdir"),
                &linked_git,
                common,
            ),
            Some(Hit::GitMeta),
        );
        assert_eq!(
            classify(&common.join("worktrees"), &linked_git, common),
            Some(Hit::GitMeta),
        );
    }

    #[test]
    fn irrelevant_shared_git_files_remain_filtered() {
        let common = Path::new("/repo/.git");
        assert_eq!(classify(&common.join("config"), common, common), None);
    }
}

#[tauri::command]
pub async fn unwatch_repo(
    state: tauri::State<'_, WatcherState>,
    repo_path: String,
) -> Result<(), String> {
    state.active.lock().remove(&repo_path);
    Ok(())
}
