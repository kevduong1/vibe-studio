//! Git commands backing the source-control panel, commit graph and diff
//! viewer. All repository access goes through git2 (libgit2); network
//! operations (fetch/pull/push) shell out to the `git` CLI so the user's
//! ssh-agent / credential helpers keep working.

use std::collections::HashMap;
use std::path::{Component, Path};
use std::process::{Command, Stdio};

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, Delta, DiffFindOptions, ErrorCode, Oid, Repository, Sort, StashFlags, Status,
    StatusOptions,
};

// ---------------------------------------------------------------------------
// Payload types (wire shapes match src/lib/ipc.ts exactly)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub detached: bool,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub branch: BranchInfo,
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    pub kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub refs: Vec<RefLabel>,
    pub is_head: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogResult {
    pub commits: Vec<CommitInfo>,
    pub has_more: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub old_text: String,
    pub new_text: String,
    pub old_label: String,
    pub new_label: String,
    pub binary: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    pub ok: bool,
    pub output: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| e.to_string())
}

/// Run sync libgit2 / git-CLI work on the blocking pool so slow repos and
/// network ops never stall the async runtime (which also serves terminal IPC).
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Escape fnmatch metacharacters so libgit2 pathspec APIs (reset_default)
/// match the path literally. Includes '!' — a leading '!' would otherwise be
/// parsed as pathspec negation, turning the operation into a no-op.
fn escape_pathspec(p: &str) -> String {
    let mut out = String::with_capacity(p.len() + 2);
    for c in p.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\' | '!') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn short_oid(oid: Oid) -> String {
    let s = oid.to_string();
    s[..7.min(s.len())].to_string()
}

fn is_unborn(e: &git2::Error) -> bool {
    matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound)
}

/// Current-branch info; handles detached HEAD and unborn (no-commit) repos.
fn branch_info(repo: &Repository) -> Result<BranchInfo, String> {
    match repo.head() {
        Ok(head) => {
            let head_oid = head.target();
            let detached = repo.head_detached().unwrap_or(false);
            if detached {
                let name = head_oid.map(short_oid).unwrap_or_else(|| "HEAD".to_string());
                return Ok(BranchInfo {
                    name,
                    detached: true,
                    ahead: 0,
                    behind: 0,
                });
            }
            let name = lossy(head.shorthand_bytes());
            let mut ahead = 0;
            let mut behind = 0;
            if let Ok(branch) = repo.find_branch(&name, BranchType::Local) {
                if let Ok(up) = branch.upstream() {
                    if let (Some(local), Some(remote)) = (head_oid, up.get().target()) {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local, remote) {
                            ahead = a;
                            behind = b;
                        }
                    }
                }
            }
            Ok(BranchInfo {
                name,
                detached: false,
                ahead,
                behind,
            })
        }
        Err(e) if is_unborn(&e) => {
            // Unborn repo: HEAD is a symbolic ref to a branch with no commits.
            let name = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|r| {
                    r.symbolic_target()
                        .ok()
                        .flatten()
                        .map(|s| s.trim_start_matches("refs/heads/").to_string())
                })
                .unwrap_or_else(|| "main".to_string());
            Ok(BranchInfo {
                name,
                detached: false,
                ahead: 0,
                behind: 0,
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

fn head_tree(repo: &Repository) -> Option<git2::Tree<'_>> {
    repo.head().ok()?.peel_to_tree().ok()
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// Diff sides larger than this are not sent to the webview (treated like
/// binary): a multi-hundred-MB blob would otherwise be allocated 2-3 times
/// on its way through JSON into CodeMirror.
const MAX_DIFF_BYTES: usize = 5 * 1024 * 1024;

/// (text, binary-or-too-large) for a blob.
fn blob_text(blob: &git2::Blob<'_>) -> (String, bool) {
    if blob.size() > MAX_DIFF_BYTES {
        return (String::new(), true);
    }
    let content = blob.content();
    let binary = blob.is_binary() || looks_binary(content);
    if binary {
        return (String::new(), true);
    }
    (lossy(content), false)
}

/// Blob contents at `path` inside `tree`; empty string when absent.
fn blob_from_tree(repo: &Repository, tree: Option<&git2::Tree<'_>>, path: &Path) -> (String, bool) {
    let Some(tree) = tree else {
        return (String::new(), false);
    };
    let Ok(entry) = tree.get_path(path) else {
        return (String::new(), false);
    };
    let Ok(blob) = repo.find_blob(entry.id()) else {
        return (String::new(), false);
    };
    blob_text(&blob)
}

/// Blob contents for `path` from the index, when staged.
fn blob_from_index(repo: &Repository, path: &Path) -> Option<(String, bool)> {
    let index = repo.index().ok()?;
    let entry = index.get_path(path, 0)?;
    let blob = repo.find_blob(entry.id).ok()?;
    Some(blob_text(&blob))
}

/// Working-tree file contents (lossy UTF-8); missing file -> empty.
fn worktree_text(repo: &Repository, path: &Path) -> (String, bool) {
    let Some(wd) = repo.workdir() else {
        return (String::new(), false);
    };
    let full = wd.join(path);
    if let Ok(meta) = std::fs::metadata(&full) {
        if meta.len() as usize > MAX_DIFF_BYTES {
            return (String::new(), true);
        }
    }
    match std::fs::read(&full) {
        Ok(bytes) => {
            if looks_binary(&bytes) {
                (String::new(), true)
            } else {
                (lossy(&bytes), false)
            }
        }
        Err(_) => (String::new(), false),
    }
}

fn diff_file_path(file: git2::DiffFile<'_>) -> Option<String> {
    file.path_bytes().map(lossy)
}

fn map_delta_status(status: Delta) -> &'static str {
    match status {
        Delta::Added => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        Delta::Typechange => "T",
        _ => "M",
    }
}

fn run_git(repo_path: &str, args: &[&str]) -> GitOpResult {
    match Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        // Fail fast instead of hanging forever on an interactive credential
        // prompt no one can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
    {
        Ok(out) => {
            let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stderr.trim().is_empty() {
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push_str(&stderr);
            }
            GitOpResult {
                ok: out.status.success(),
                output: output.trim_end().to_string(),
            }
        }
        Err(e) => GitOpResult {
            ok: false,
            output: format!("failed to run git: {e}"),
        },
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_open(path: String) -> Result<RepoInfo, String> {
    blocking(move || {
        let repo = open_repo(&path)?;
        let wd = repo
            .workdir()
            .ok_or_else(|| "repository has no working directory (bare repo)".to_string())?;
        let mut root = wd.to_string_lossy().into_owned();
        while root.len() > 1 && root.ends_with('/') {
            root.pop();
        }
        Ok(RepoInfo { root })
    })
    .await
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<StatusResult, String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let branch = branch_info(&repo)?;

        // Submodules are NOT excluded: a staged submodule pointer update would
        // otherwise be invisible here yet still included by git_commit.
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);

        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        let mut staged = Vec::new();
        let mut unstaged = Vec::new();

        const INDEX_BITS: Status = Status::INDEX_NEW
            .union(Status::INDEX_MODIFIED)
            .union(Status::INDEX_DELETED)
            .union(Status::INDEX_RENAMED)
            .union(Status::INDEX_TYPECHANGE);
        const WT_BITS: Status = Status::WT_NEW
            .union(Status::WT_MODIFIED)
            .union(Status::WT_DELETED)
            .union(Status::WT_RENAMED)
            .union(Status::WT_TYPECHANGE);

        for entry in statuses.iter() {
            let s = entry.status();
            let entry_path = lossy(entry.path_bytes());

            if s.intersects(INDEX_BITS) {
                let delta = entry.head_to_index();
                let path = delta
                    .as_ref()
                    .and_then(|d| diff_file_path(d.new_file()))
                    .unwrap_or_else(|| entry_path.clone());
                let (status, orig_path) = if s.contains(Status::INDEX_RENAMED) {
                    let orig = delta.as_ref().and_then(|d| diff_file_path(d.old_file()));
                    ("R", orig)
                } else if s.contains(Status::INDEX_NEW) {
                    ("A", None)
                } else if s.contains(Status::INDEX_DELETED) {
                    ("D", None)
                } else if s.contains(Status::INDEX_TYPECHANGE) {
                    ("T", None)
                } else {
                    ("M", None)
                };
                staged.push(FileStatus {
                    path,
                    orig_path,
                    status: status.to_string(),
                });
            }

            if s.contains(Status::CONFLICTED) {
                unstaged.push(FileStatus {
                    path: entry_path.clone(),
                    orig_path: None,
                    status: "U".to_string(),
                });
            } else if s.intersects(WT_BITS) {
                let delta = entry.index_to_workdir();
                let path = delta
                    .as_ref()
                    .and_then(|d| diff_file_path(d.new_file()))
                    .unwrap_or_else(|| entry_path.clone());
                let (status, orig_path) = if s.contains(Status::WT_RENAMED) {
                    let orig = delta.as_ref().and_then(|d| diff_file_path(d.old_file()));
                    ("R", orig)
                } else if s.contains(Status::WT_NEW) {
                    ("?", None)
                } else if s.contains(Status::WT_DELETED) {
                    ("D", None)
                } else if s.contains(Status::WT_TYPECHANGE) {
                    ("T", None)
                } else {
                    ("M", None)
                };
                unstaged.push(FileStatus {
                    path,
                    orig_path,
                    status: status.to_string(),
                });
            }
        }

        Ok(StatusResult {
            branch,
            staged,
            unstaged,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_stage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let wd = repo
            .workdir()
            .ok_or_else(|| "repository has no working directory".to_string())?
            .to_path_buf();
        let mut index = repo.index().map_err(|e| e.to_string())?;
        for p in &paths {
            let rel = Path::new(p);
            // symlink_metadata so broken symlinks still count as "exists on disk"
            if std::fs::symlink_metadata(wd.join(rel)).is_ok() {
                index.add_path(rel).map_err(|e| e.to_string())?;
            } else {
                index.remove_path(rel).map_err(|e| e.to_string())?;
            }
        }
        index.write().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let head_obj = match repo.head() {
            Ok(head) => Some(
                head.peel_to_commit()
                    .map_err(|e| e.to_string())?
                    .into_object(),
            ),
            // No HEAD yet: unstaging means removing the entries from the index.
            Err(e) if is_unborn(&e) => None,
            Err(e) => return Err(e.to_string()),
        };
        // reset_default treats paths as fnmatch pathspecs; escape them so
        // bracket-style filenames (app/[slug]/page.tsx) can't unstage siblings.
        let escaped: Vec<String> = paths.iter().map(|p| escape_pathspec(p)).collect();
        repo.reset_default(head_obj.as_ref(), escaped.iter())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_discard(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let wd = repo
            .workdir()
            .ok_or_else(|| "repository has no working directory".to_string())?
            .to_path_buf();
        let canon_wd = wd
            .canonicalize()
            .map_err(|e| format!("cannot resolve workdir: {e}"))?;
        let index = repo.index().map_err(|e| e.to_string())?;
        let head = head_tree(&repo);

        let mut tracked: Vec<&str> = Vec::new();
        let mut untracked: Vec<&str> = Vec::new();
        for p in &paths {
            let rel = Path::new(p);
            if rel
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::RootDir))
            {
                return Err(format!("refusing to discard suspicious path: {p}"));
            }
            let in_index = index.get_path(rel, 0).is_some();
            let in_head = head
                .as_ref()
                .map(|t| t.get_path(rel).is_ok())
                .unwrap_or(false);
            if in_index || in_head {
                tracked.push(p);
            } else {
                untracked.push(p);
            }
        }

        if !tracked.is_empty() {
            // Checkout from the index so staged content survives the discard.
            let mut cb = CheckoutBuilder::new();
            cb.force();
            // Match paths literally: with pathspec matching on, a force-checkout
            // of app/[slug]/page.tsx would also clobber app/s/page.tsx.
            cb.disable_pathspec_match(true);
            for p in &tracked {
                cb.path(*p);
            }
            repo.checkout_index(None, Some(&mut cb))
                .map_err(|e| e.to_string())?;
        }

        for p in &untracked {
            let full = wd.join(p);
            let meta = match std::fs::symlink_metadata(&full) {
                Ok(m) => m,
                Err(_) => continue, // already gone
            };
            // Canonicalize the parent (not the entry itself, so symlinks pointing
            // outside the repo are still deleted as links) and verify containment.
            let parent = full
                .parent()
                .ok_or_else(|| format!("invalid path: {p}"))?;
            let canon_parent = parent
                .canonicalize()
                .map_err(|e| format!("cannot resolve {p}: {e}"))?;
            if !canon_parent.starts_with(&canon_wd) {
                return Err(format!("refusing to delete outside the repository: {p}"));
            }
            if meta.is_dir() {
                std::fs::remove_dir_all(&full).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(&full).map_err(|e| e.to_string())?;
            }
        }

        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(repo_path: String, message: String, amend: bool) -> Result<String, String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let sig = repo.signature().map_err(|e| e.to_string())?;
        let mut index = repo.index().map_err(|e| e.to_string())?;
        let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
        let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

        if amend {
            let head_commit = repo
                .head()
                .and_then(|h| h.peel_to_commit())
                .map_err(|e| e.to_string())?;
            // Empty message keeps the prior commit message (libgit2 semantics).
            // Author + date are preserved; the committer is refreshed.
            let msg = (!message.is_empty()).then_some(message.as_str());
            let oid = head_commit
                .amend(Some("HEAD"), None, Some(&sig), None, msg, Some(&tree))
                .map_err(|e| e.to_string())?;
            return Ok(oid.to_string());
        }

        let parent = match repo.head() {
            Ok(head) => Some(head.peel_to_commit().map_err(|e| e.to_string())?),
            Err(e) if is_unborn(&e) => None,
            Err(e) => return Err(e.to_string()),
        };
        let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
            .map_err(|e| e.to_string())?;
        Ok(oid.to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_log(
    repo_path: String,
    limit: usize,
    skip: usize,
    ref_name: Option<String>,
) -> Result<LogResult, String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;

        // oid -> labels, pre-built from all references.
        let mut ref_map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
        if let Ok(refs) = repo.references() {
            for r in refs.flatten() {
                let name = lossy(r.shorthand_bytes());
                let (kind, target) = if r.is_branch() {
                    ("local", r.target())
                } else if r.is_remote() {
                    // Skip the symbolic "origin/HEAD"-style entries.
                    if r.symbolic_target_bytes().is_some() || name.ends_with("/HEAD") {
                        continue;
                    }
                    ("remote", r.target())
                } else if r.is_tag() {
                    // Peel annotated tags through to their target commit.
                    ("tag", r.peel_to_commit().ok().map(|c| c.id()))
                } else {
                    continue;
                };
                if let Some(oid) = target {
                    ref_map.entry(oid).or_default().push(RefLabel {
                        name,
                        kind: kind.to_string(),
                    });
                }
            }
        }

        let head_oid = repo.head().ok().and_then(|h| h.target());

        let mut walk = match repo.revwalk() {
            Ok(w) => w,
            Err(e) => return Err(e.to_string()),
        };
        match &ref_name {
            // Filtered: only commits reachable from this ref. The filter
            // dropdown only offers branches, so prefer refs/heads then
            // refs/remotes before libgit2's dwim (which tries refs/tags FIRST
            // and would let a same-named tag shadow the chosen branch).
            // Resolution failures are real errors — the UI should learn its
            // filter went stale (branch deleted) instead of silently seeing
            // everything.
            Some(name) => {
                let resolved = repo
                    .find_reference(&format!("refs/heads/{name}"))
                    .or_else(|_| repo.find_reference(&format!("refs/remotes/{name}")))
                    .or_else(|_| repo.resolve_reference_from_short_name(name));
                let oid = resolved
                    .and_then(|r| r.peel_to_commit())
                    .map_err(|e| format!("cannot resolve '{name}': {}", e.message()))?
                    .id();
                walk.push(oid).map_err(|e| e.to_string())?;
            }
            None => {
                // All of these can fail on an empty/unborn repo; that's fine.
                let _ = walk.push_head();
                let _ = walk.push_glob("refs/heads/*");
                let _ = walk.push_glob("refs/remotes/*");
                let _ = walk.push_glob("refs/tags/*");
            }
        }
        let _ = walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME);

        let mut commits = Vec::new();
        let mut skipped = 0usize;
        let mut has_more = false;
        for res in walk {
            let oid = match res {
                Ok(o) => o,
                Err(_) => continue,
            };
            if skipped < skip {
                skipped += 1;
                continue;
            }
            if commits.len() == limit {
                has_more = true;
                break;
            }
            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let author = commit.author();
            commits.push(CommitInfo {
                oid: oid.to_string(),
                summary: commit.summary_bytes().map(lossy).unwrap_or_default(),
                author: lossy(author.name_bytes()),
                email: lossy(author.email_bytes()),
                timestamp: commit.time().seconds(),
                parents: commit.parent_ids().map(|p| p.to_string()).collect(),
                refs: ref_map.get(&oid).cloned().unwrap_or_default(),
                is_head: Some(oid) == head_oid,
            });
        }

        Ok(LogResult { commits, has_more })
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(repo_path: String, oid: String) -> Result<Vec<CommitFile>, String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let cid = Oid::from_str(&oid).map_err(|e| e.to_string())?;
        let commit = repo.find_commit(cid).map_err(|e| e.to_string())?;
        let new_tree = commit.tree().map_err(|e| e.to_string())?;
        // First-parent tree, or empty (None) for a root commit.
        let old_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

        let mut diff = repo
            .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), None)
            .map_err(|e| e.to_string())?;
        let mut find = DiffFindOptions::new();
        find.renames(true);
        let _ = diff.find_similar(Some(&mut find));

        let mut files = Vec::new();
        for delta in diff.deltas() {
            let path = diff_file_path(delta.new_file())
                .or_else(|| diff_file_path(delta.old_file()))
                .unwrap_or_default();
            let status = map_delta_status(delta.status());
            let orig_path = if delta.status() == Delta::Renamed {
                diff_file_path(delta.old_file())
            } else {
                None
            };
            files.push(CommitFile {
                path,
                orig_path,
                status: status.to_string(),
            });
        }
        Ok(files)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_file(
    repo_path: String,
    path: String,
    kind: String,
    oid: Option<String>,
    orig_path: Option<String>,
) -> Result<DiffPayload, String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let rel = Path::new(&path);
        // For renames the old side lives at the pre-rename path; without it the
        // diff degenerates into a whole-file add.
        let old_rel = orig_path.as_deref().map(Path::new).unwrap_or(rel);

        let (old, old_label, new, new_label) = match kind.as_str() {
            "worktree" => {
                let head = head_tree(&repo);
                let old = blob_from_index(&repo, old_rel)
                    .unwrap_or_else(|| blob_from_tree(&repo, head.as_ref(), old_rel));
                let new = worktree_text(&repo, rel);
                (old, "Index".to_string(), new, "Working Tree".to_string())
            }
            "staged" => {
                let head = head_tree(&repo);
                let old = blob_from_tree(&repo, head.as_ref(), old_rel);
                let new = blob_from_index(&repo, rel).unwrap_or((String::new(), false));
                (old, "HEAD".to_string(), new, "Index".to_string())
            }
            "commit" => {
                let oid_str = oid.ok_or_else(|| "oid is required for commit diffs".to_string())?;
                let cid = Oid::from_str(&oid_str).map_err(|e| e.to_string())?;
                let commit = repo.find_commit(cid).map_err(|e| e.to_string())?;
                let new_tree = commit.tree().map_err(|e| e.to_string())?;
                let parent = commit.parent(0).ok();
                let old_tree = parent.as_ref().and_then(|p| p.tree().ok());
                let old = blob_from_tree(&repo, old_tree.as_ref(), old_rel);
                let new = blob_from_tree(&repo, Some(&new_tree), rel);
                let old_label = parent
                    .map(|p| short_oid(p.id()))
                    .unwrap_or_else(|| "(none)".to_string());
                (old, old_label, new, short_oid(cid))
            }
            other => return Err(format!("unknown diff kind: {other}")),
        };

        let binary = old.1 || new.1;
        Ok(DiffPayload {
            old_text: if binary { String::new() } else { old.0 },
            new_text: if binary { String::new() } else { new.0 },
            old_label,
            new_label,
            binary,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_stash_list(repo_path: String) -> Result<Vec<StashInfo>, String> {
    blocking(move || {
        let mut repo = open_repo(&repo_path)?;
        let mut entries: Vec<(usize, String, Oid)> = Vec::new();
        repo.stash_foreach(|index, message, oid| {
            entries.push((index, message.to_string(), *oid));
            true
        })
        .map_err(|e| e.to_string())?;

        Ok(entries
            .into_iter()
            .map(|(index, message, oid)| StashInfo {
                index,
                message,
                oid: oid.to_string(),
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn git_stash_save(
    repo_path: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), String> {
    blocking(move || {
        let mut repo = open_repo(&repo_path)?;
        let sig = repo.signature().map_err(|e| e.to_string())?;
        let flags = if include_untracked {
            Some(StashFlags::INCLUDE_UNTRACKED)
        } else {
            None
        };
        // stash_save2 accepts Option<&str>; None lets git2 generate a message.
        repo.stash_save2(&sig, message.as_deref(), flags)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
}

/// Stashes are addressed by oid, not index: indices shift whenever the list
/// changes (e.g. a `git stash pop` in the integrated terminal), so an index
/// captured by the UI could target the wrong stash. Resolving the oid and
/// running the operation on the same repo handle closes that race.
fn resolve_stash_index(repo: &mut Repository, oid: &str) -> Result<usize, String> {
    let mut found = None;
    repo.stash_foreach(|i, _msg, o| {
        if o.to_string() == oid {
            found = Some(i);
            false
        } else {
            true
        }
    })
    .map_err(|e| e.to_string())?;
    found.ok_or_else(|| "stash no longer exists".to_string())
}

#[tauri::command]
pub async fn git_stash_apply(repo_path: String, oid: String) -> Result<(), String> {
    blocking(move || {
        let mut repo = open_repo(&repo_path)?;
        let index = resolve_stash_index(&mut repo, &oid)?;
        repo.stash_apply(index, None).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_stash_pop(repo_path: String, oid: String) -> Result<(), String> {
    blocking(move || {
        let mut repo = open_repo(&repo_path)?;
        let index = resolve_stash_index(&mut repo, &oid)?;
        repo.stash_pop(index, None).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_stash_drop(repo_path: String, oid: String) -> Result<(), String> {
    blocking(move || {
        let mut repo = open_repo(&repo_path)?;
        let index = resolve_stash_index(&mut repo, &oid)?;
        repo.stash_drop(index).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(repo_path: String) -> Result<GitOpResult, String> {
    blocking(move || {
        Ok(run_git(&repo_path, &["fetch", "--all", "--prune"]))
    })
    .await
}

#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<GitOpResult, String> {
    blocking(move || {
        Ok(run_git(&repo_path, &["pull"]))
    })
    .await
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<GitOpResult, String> {
    blocking(move || {
        Ok(run_git(&repo_path, &["push"]))
    })
    .await
}

/// Diffs larger than this are truncated before being sent to the model — a
/// multi-MB staged diff would blow the prompt budget without improving the
/// message.
const MAX_PROMPT_DIFF_BYTES: usize = 100 * 1024;

/// Generate a commit message from the staged diff by piping it to the
/// `claude` CLI in print mode (Sonnet). Invoked through the user's login
/// shell so `claude` resolves on PATH even when the app was launched from
/// Finder, and with cwd at the repo root so the CLI picks up project context
/// (CLAUDE.md). Returns the message text.
#[tauri::command]
pub async fn git_generate_commit_message(repo_path: String) -> Result<String, String> {
    blocking(move || {
        let diff = run_git(&repo_path, &["diff", "--cached", "--no-color"]);
        if !diff.ok {
            return Err(diff.output);
        }
        if diff.output.trim().is_empty() {
            return Err("No staged changes to generate a message from.".to_string());
        }

        // Recent subjects nudge the model toward this repo's commit style.
        let log = run_git(&repo_path, &["log", "--format=%s", "-n", "10"]);

        let mut prompt = String::from(
            "Generate a Git commit message for the staged changes below.\n\n\
             Use the recent commit subjects as the style guide — unless they are too \
             terse or uninformative to be worth imitating, in which case prefer the \
             format below. Capture the intent of the change first, then summarize the \
             main updates as quick bullets when useful.\n\n\
             Output format:\n\
             <imperative subject line>\n\n\
             - <feature, behavior change, or important implementation detail>\n\
             - <feature, behavior change, or important implementation detail>\n\
             - <feature, behavior change, or important implementation detail>\n\n\
             Rules:\n\
             - Subject should describe the purpose of the change, not the files touched\n\
             - Use bullets only if there are multiple meaningful updates\n\
             - Keep the body to 2-5 bullets\n\
             - Avoid vague subjects like \"Update code\" or \"Fix changes\"\n\
             - Avoid implementation noise unless it matters\n\
             - No markdown fences, headings, labels, or explanations\n\n\
             Return ONLY the commit message text.\n\n",
        );
        if log.ok && !log.output.is_empty() {
            prompt.push_str("Recent commit subjects:\n");
            prompt.push_str(&log.output);
            prompt.push_str("\n\n");
        }
        prompt.push_str("Staged diff:\n");
        if diff.output.len() > MAX_PROMPT_DIFF_BYTES {
            let mut end = MAX_PROMPT_DIFF_BYTES;
            while !diff.output.is_char_boundary(end) {
                end -= 1;
            }
            prompt.push_str(&diff.output[..end]);
            prompt.push_str("\n... (diff truncated)");
        } else {
            prompt.push_str(&diff.output);
        }

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut child = Command::new(shell)
            .args(["-lc", "claude -p --model claude-sonnet-4-6"])
            .current_dir(&repo_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to run claude: {e}"))?;

        // Feed the prompt from a thread: claude reads all of stdin before
        // writing output, but writing + waiting from one thread could still
        // deadlock if the child ever fills its stderr pipe mid-read.
        let mut stdin = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(prompt.as_bytes());
        });

        let out = child
            .wait_with_output()
            .map_err(|e| format!("failed to run claude: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let detail = if stderr.trim().is_empty() { stdout } else { stderr };
            return Err(format!("claude failed: {}", detail.trim()));
        }
        let message = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if message.is_empty() {
            return Err("claude returned an empty message".to_string());
        }
        Ok(message)
    })
    .await
}

/// Checkout shells out to the `git` CLI so its safety checks and messages
/// ("Your local changes ... would be overwritten") reach the user verbatim.
/// kind: "local" | "remote" | "tag" | "commit" — remote checks out a local
/// tracking branch (created when missing); tag/commit detach HEAD.
#[tauri::command]
pub async fn git_checkout(repo_path: String, ref_name: String, kind: String) -> Result<(), String> {
    blocking(move || {
        // A ref shorthand beginning with '-' lands in an option position on the
        // CLI: a ref named "-f" would turn `git checkout -f` into a force-
        // checkout that silently discards the worktree. Reject it (a bare `--`
        // can't be used — it flips checkout into pathspec mode). The "commit"
        // kind always carries a hex oid, so it's never option-shaped.
        if ref_name.starts_with('-') {
            return Err(format!("invalid ref name: {ref_name}"));
        }
        let res = match kind.as_str() {
            "local" => run_git(&repo_path, &["checkout", &ref_name]),
            "remote" => {
                // "origin/foo" -> local "foo": strip the longest matching
                // remote prefix (branch names may themselves contain '/').
                let repo = open_repo(&repo_path)?;
                let mut local: Option<String> = None;
                let mut best = 0usize;
                if let Ok(remotes) = repo.remotes() {
                    // iter() items are Result<Option<&str>> — flatten both
                    for r in remotes.iter().flatten().flatten() {
                        let prefix = format!("{r}/");
                        if r.len() > best && ref_name.starts_with(&prefix) {
                            best = r.len();
                            local = Some(ref_name[prefix.len()..].to_string());
                        }
                    }
                }
                let local = local
                    .ok_or_else(|| format!("cannot derive a local branch name from {ref_name}"))?;
                // The derived name ("origin/-f" -> "-f") also lands in an
                // option position — apply the same guard.
                if local.starts_with('-') {
                    return Err(format!("invalid ref name: {local}"));
                }
                if repo.find_branch(&local, BranchType::Local).is_ok() {
                    run_git(&repo_path, &["checkout", &local])
                } else {
                    // Explicit --track sidesteps checkout's DWIM ambiguity
                    // when several remotes have a branch of the same name.
                    run_git(&repo_path, &["checkout", "--track", &ref_name])
                }
            }
            "tag" | "commit" => run_git(&repo_path, &["checkout", "--detach", &ref_name]),
            other => return Err(format!("unknown checkout kind: {other}")),
        };
        if res.ok {
            Ok(())
        } else {
            Err(res.output)
        }
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    repo_path: String,
    name: String,
    oid: String,
    checkout: bool,
) -> Result<(), String> {
    blocking(move || {
        // git validates branch-name syntax itself; only reject what it would
        // parse as a command-line option instead of a name.
        if name.starts_with('-') {
            return Err(format!("invalid branch name: {name}"));
        }
        let res = if checkout {
            run_git(&repo_path, &["checkout", "-b", &name, &oid])
        } else {
            run_git(&repo_path, &["branch", &name, &oid])
        };
        if res.ok {
            Ok(())
        } else {
            Err(res.output)
        }
    })
    .await
}

/// How far down the first-parent chain of HEAD we search for the commits
/// being squashed before giving up.
const SQUASH_MAX_WALK: usize = 10_000;

/// Squash a contiguous run of commits on the current branch's first-parent
/// chain into a single commit; descendants are replayed on top via
/// `git rebase --onto`. Validation lives here (not the UI) because only the
/// repository knows the true chain: the commits must form one gap-free run —
/// a gap would silently fold unselected commits into the squash.
#[tauri::command]
pub async fn git_squash(repo_path: String, oids: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let mut wanted = std::collections::HashSet::new();
        for s in &oids {
            wanted.insert(Oid::from_str(s).map_err(|e| e.to_string())?);
        }
        if wanted.len() < 2 {
            return Err("select at least two commits to squash".to_string());
        }

        // Detached HEAD: `git rebase --onto` would move only HEAD and leave
        // every branch on the old history, so the "rewrite the branch" the UI
        // promises silently doesn't happen and the result is easily orphaned.
        if repo.head_detached().unwrap_or(false) {
            return Err("cannot squash on a detached HEAD — check out a branch first".to_string());
        }

        // Walk HEAD's first-parent chain; the wanted commits must appear as
        // one contiguous run (newest first).
        let head = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| e.to_string())?;
        let head_oid = head.id();
        let mut range: Vec<Oid> = Vec::new();
        let mut cur = head;
        let mut steps = 0usize;
        loop {
            if wanted.contains(&cur.id()) {
                range.push(cur.id());
                if range.len() == wanted.len() {
                    break;
                }
            } else if !range.is_empty() {
                return Err("selected commits must be contiguous".to_string());
            }
            steps += 1;
            if steps > SQUASH_MAX_WALK {
                return Err("selected commits are not on the current branch".to_string());
            }
            cur = match cur.parent(0) {
                Ok(p) => p,
                Err(_) => {
                    return Err("selected commits are not on the current branch".to_string());
                }
            };
        }
        for oid in &range {
            let c = repo.find_commit(*oid).map_err(|e| e.to_string())?;
            if c.parent_count() != 1 {
                return Err("merge commits and the root commit cannot be squashed".to_string());
            }
        }

        // Leak guard: a merge ABOVE the range whose two sides fork from INSIDE
        // the squashed run leaves the original commits reachable after
        // `git rebase --rebase-merges` (cousins keep their original base), so
        // the squash silently half-applies. Walk base..HEAD; refuse if any
        // merge's parents converge on a range member.
        {
            let range_set: std::collections::HashSet<Oid> = range.iter().copied().collect();
            let oldest_base = range
                .last()
                .and_then(|o| repo.find_commit(*o).ok())
                .and_then(|c| c.parent(0).ok())
                .map(|p| p.id());
            let mut leak_walk = repo.revwalk().map_err(|e| e.to_string())?;
            leak_walk.push(head_oid).map_err(|e| e.to_string())?;
            if let Some(b) = oldest_base {
                let _ = leak_walk.hide(b);
            }
            for res in leak_walk {
                let oid = res.map_err(|e| e.to_string())?;
                let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
                if c.parent_count() < 2 {
                    continue;
                }
                let first = c.parent_id(0).map_err(|e| e.to_string())?;
                for i in 1..c.parent_count() {
                    let side = c.parent_id(i).map_err(|e| e.to_string())?;
                    if let Ok(mb) = repo.merge_base(first, side) {
                        if range_set.contains(&mb) {
                            return Err(
                                "a later merge branches from the selected commits — \
                                 squashing would leave them in history"
                                    .to_string(),
                            );
                        }
                    }
                }
            }
        }

        // The squash commit reuses the newest tree (= the combined content),
        // parents onto the oldest's parent, keeps the oldest commit's author
        // and concatenates messages oldest-first (`git rebase` conventions).
        let newest = repo.find_commit(range[0]).map_err(|e| e.to_string())?;
        let oldest = repo
            .find_commit(*range.last().unwrap())
            .map_err(|e| e.to_string())?;
        let base = oldest.parent(0).map_err(|e| e.to_string())?;
        let mut message = String::new();
        for oid in range.iter().rev() {
            let c = repo.find_commit(*oid).map_err(|e| e.to_string())?;
            let m = lossy(c.message_bytes());
            if !message.is_empty() {
                message.push_str("\n\n");
            }
            message.push_str(m.trim_end());
        }
        message.push('\n');
        let committer = repo.signature().map_err(|e| e.to_string())?;
        let a = oldest.author();
        let author = git2::Signature::new(
            &lossy(a.name_bytes()),
            &lossy(a.email_bytes()),
            &a.when(),
        )
        .map_err(|e| e.to_string())?;
        let tree = newest.tree().map_err(|e| e.to_string())?;
        let squash = repo
            .commit(None, &author, &committer, &message, &tree, &[&base])
            .map_err(|e| e.to_string())?;

        // Replay everything above the squashed range onto the new commit and
        // move the branch. The CLI brings rebase's own safety net: it refuses
        // to start on a dirty worktree, and --rebase-merges preserves any
        // descendant merge topology. A no-op replay (newest == HEAD) simply
        // moves the branch to the squash commit.
        let res = run_git(
            &repo_path,
            &[
                "rebase",
                "--rebase-merges",
                "--onto",
                &squash.to_string(),
                &newest.id().to_string(),
            ],
        );
        if res.ok {
            Ok(())
        } else {
            let _ = run_git(&repo_path, &["rebase", "--abort"]);
            Err(if res.output.is_empty() {
                "git rebase failed".to_string()
            } else {
                res.output
            })
        }
    })
    .await
}

/// Rebase the current branch onto `onto` — a full commit oid (from the
/// graph's "onto this commit") or a branch short name (from the picker).
/// Always resolved to a commit oid before reaching the CLI, so option
/// injection is structurally impossible. On failure the rebase is aborted
/// and the git error returned (same policy as git_squash); dirty-worktree
/// and in-progress-rebase refusals surface verbatim from the CLI.
#[tauri::command]
pub async fn git_rebase(repo_path: String, onto: String) -> Result<(), String> {
    blocking(move || {
        if onto.starts_with('-') {
            return Err(format!("invalid rebase target: {onto}"));
        }
        let repo = open_repo(&repo_path)?;
        if repo.head_detached().unwrap_or(false) {
            return Err("cannot rebase a detached HEAD — check out a branch first".to_string());
        }
        // Full hex first (the graph always sends 40 chars) — the length gate
        // matters because Oid::from_str zero-pads short hex, which would
        // misparse a hex-looking branch name like "beef". Otherwise resolve
        // as a ref, heads before remotes before dwim (same anti-tag-shadowing
        // order as git_log's filter).
        let target = if onto.len() == 40 && Oid::from_str(&onto).is_ok() {
            repo.find_commit(Oid::from_str(&onto).unwrap())
                .map_err(|e| e.to_string())?
                .id()
        } else {
            repo.find_reference(&format!("refs/heads/{onto}"))
                .or_else(|_| repo.find_reference(&format!("refs/remotes/{onto}")))
                .or_else(|_| repo.resolve_reference_from_short_name(&onto))
                .and_then(|r| r.peel_to_commit())
                .map_err(|e| format!("cannot resolve '{onto}': {}", e.message()))?
                .id()
        };
        let res = run_git(&repo_path, &["rebase", &target.to_string()]);
        if res.ok {
            Ok(())
        } else {
            let _ = run_git(&repo_path, &["rebase", "--abort"]);
            Err(if res.output.is_empty() {
                "git rebase failed".to_string()
            } else {
                res.output
            })
        }
    })
    .await
}

/// `git reset --<mode> <oid>`; mode is "soft" | "mixed" | "hard". The UI
/// confirms hard resets before calling. No abort path — reset either
/// succeeds or refuses atomically. Works detached too (moves HEAD; the
/// reflog protects the old position).
#[tauri::command]
pub async fn git_reset(repo_path: String, oid: String, mode: String) -> Result<(), String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let target = Oid::from_str(&oid).map_err(|e| e.to_string())?;
        repo.find_commit(target).map_err(|e| e.to_string())?;
        let flag = match mode.as_str() {
            "soft" => "--soft",
            "mixed" => "--mixed",
            "hard" => "--hard",
            other => return Err(format!("unknown reset mode: {other}")),
        };
        let res = run_git(&repo_path, &["reset", flag, &target.to_string()]);
        if res.ok {
            Ok(())
        } else {
            Err(res.output)
        }
    })
    .await
}

/// Apply `oids` onto HEAD in the given order — the frontend sends them
/// OLDEST-FIRST (it owns the display/topo order). All-or-nothing: any
/// failure aborts the whole sequence (rolling back picks already applied)
/// and returns the git error.
#[tauri::command]
pub async fn git_cherry_pick(repo_path: String, oids: Vec<String>) -> Result<(), String> {
    blocking(move || {
        if oids.is_empty() {
            return Err("no commits to cherry-pick".to_string());
        }
        let repo = open_repo(&repo_path)?;
        let mut args: Vec<String> = vec!["cherry-pick".to_string()];
        for s in &oids {
            let oid = Oid::from_str(s).map_err(|e| e.to_string())?;
            repo.find_commit(oid).map_err(|e| e.to_string())?;
            args.push(oid.to_string());
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let res = run_git(&repo_path, &arg_refs);
        if res.ok {
            Ok(())
        } else {
            let _ = run_git(&repo_path, &["cherry-pick", "--abort"]);
            Err(if res.output.is_empty() {
                "git cherry-pick failed".to_string()
            } else {
                res.output
            })
        }
    })
    .await
}

/// All local + remote branches (locals first, each alphabetical) for the
/// commit-graph branch filter.
#[tauri::command]
pub async fn git_list_refs(repo_path: String) -> Result<Vec<RefLabel>, String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        let mut out: Vec<RefLabel> = Vec::new();
        if let Ok(refs) = repo.references() {
            for r in refs.flatten() {
                let name = lossy(r.shorthand_bytes());
                if r.is_branch() {
                    out.push(RefLabel {
                        name,
                        kind: "local".to_string(),
                    });
                } else if r.is_remote() {
                    // Skip the symbolic "origin/HEAD"-style entries.
                    if r.symbolic_target_bytes().is_some() || name.ends_with("/HEAD") {
                        continue;
                    }
                    out.push(RefLabel {
                        name,
                        kind: "remote".to_string(),
                    });
                }
            }
        }
        out.sort_by_key(|r| (r.kind != "local", r.name.to_lowercase()));
        Ok(out)
    })
    .await
}
