//! Git commands backing the source-control panel, commit graph and diff
//! viewer. All repository access goes through git2 (libgit2); network
//! operations (fetch/pull/push) shell out to the `git` CLI so the user's
//! ssh-agent / credential helpers keep working.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, Delta, DiffFindOptions, ErrorCode, Oid, Repository, Sort, StashFlags, Status,
    StatusOptions,
};
use sha2::{Digest, Sha256};

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
    /// Presentation-only identity used to group equivalent repo tabs. The
    /// workspace itself remains keyed by `root` everywhere else.
    pub tab_group_id: String,
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

/// Privacy-bounded review evidence. File contents are folded into the
/// fingerprint in Rust and never cross IPC.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewSnapshot {
    pub head: Option<String>,
    /// same | ahead | diverged | unavailable
    pub base_ancestry: String,
    pub changed_files: Vec<String>,
    pub conflicted_files: Vec<String>,
    /// Per-path opaque hashes used to compare the latest agent turn without
    /// sending file contents across IPC.
    pub file_fingerprints: BTreeMap<String, String>,
    pub fingerprint: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointSnapshot {
    /// Unreachable tree containing the checkpointed worktree state.
    pub tree: String,
    /// Review evidence captured within the same repository-generation guard.
    pub snapshot: GitReviewSnapshot,
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    pub main: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateResult {
    pub worktree: GitWorktree,
    pub base_commit: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| e.to_string())
}

fn common_dir_id(repo: &Repository) -> String {
    let path = repo
        .commondir()
        .canonicalize()
        .unwrap_or_else(|_| repo.commondir().to_path_buf());
    format!("gitdir:{}", path.to_string_lossy())
}

fn trim_repo_suffix(path: &str) -> &str {
    path.trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| path.trim_matches('/'))
}

/** Normalize common HTTPS/SSH/scp remote forms to one credential-free key. */
fn hosted_remote_id(remote: &str) -> Option<String> {
    if let Ok(parsed) = url::Url::parse(remote) {
        if parsed.scheme() == "file" {
            return None;
        }
        let host = parsed.host_str()?.to_ascii_lowercase();
        let path = trim_repo_suffix(parsed.path());
        if path.is_empty() {
            return None;
        }
        let port = parsed.port().map(|value| format!(":{value}")).unwrap_or_default();
        return Some(format!("remote:{host}{port}/{path}"));
    }

    // Git's scp-like syntax: [user@]host:owner/repo.git.
    let (authority, path) = remote.split_once(':')?;
    if authority.contains('/') || authority.len() == 1 {
        return None;
    }
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let path = trim_repo_suffix(path);
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("remote:{}/{path}", host.to_ascii_lowercase()))
}

fn local_remote_path(repo: &Repository, remote: &str) -> Option<std::path::PathBuf> {
    if let Ok(parsed) = url::Url::parse(remote) {
        if parsed.scheme() == "file" {
            return parsed.to_file_path().ok();
        }
        return None;
    }
    let path = Path::new(remote);
    if path.is_absolute() {
        Some(path.to_path_buf())
    } else if remote.starts_with("./") || remote.starts_with("../") {
        Some(repo.workdir()?.join(path))
    } else {
        None
    }
}

fn remote_group_id(repo: &Repository, remote: &str) -> Option<String> {
    if let Some(path) = local_remote_path(repo, remote) {
        let target = Repository::open(&path).or_else(|_| Repository::discover(&path)).ok()?;
        return Some(common_dir_id(&target));
    }
    hosted_remote_id(remote)
}

fn preferred_remote_name(repo: &Repository) -> Option<String> {
    if let Ok(head) = repo.head() {
        if let Ok(branch) = head.shorthand() {
            if let Ok(config) = repo.config() {
                if let Ok(remote) = config.get_string(&format!("branch.{branch}.remote")) {
                    if remote != "." && repo.find_remote(&remote).is_ok() {
                        return Some(remote);
                    }
                }
            }
        }
    }
    if repo.find_remote("origin").is_ok() {
        return Some("origin".to_string());
    }
    let remotes = repo.remotes().ok()?;
    let names: Vec<_> = remotes.iter().filter_map(Result::ok).flatten().collect();
    (names.len() == 1).then(|| names[0].to_string())
}

fn repo_tab_group_id(repo: &Repository) -> String {
    preferred_remote_name(repo)
        .and_then(|name| {
            let remote = repo.find_remote(&name).ok()?;
            let url = remote.url().ok()?;
            remote_group_id(repo, url)
        })
        .unwrap_or_else(|| common_dir_id(repo))
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

fn parse_worktree_list(bytes: &[u8]) -> Result<Vec<GitWorktree>, String> {
    let mut records = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for raw in bytes.split(|byte| *byte == 0) {
        if raw.is_empty() {
            if let Some(value) = current.take() {
                records.push(value);
            }
            continue;
        }
        let value = String::from_utf8_lossy(raw);
        if let Some(path) = value.strip_prefix("worktree ") {
            if let Some(previous) = current.take() {
                records.push(previous);
            }
            current = Some(GitWorktree {
                path: path.to_string(),
                head: None,
                branch: None,
                detached: false,
                locked: false,
                prunable: false,
                main: records.is_empty(),
            });
        } else if let Some(worktree) = current.as_mut() {
            if let Some(head) = value.strip_prefix("HEAD ") {
                worktree.head =
                    (head != "0000000000000000000000000000000000000000").then(|| head.to_string());
            } else if let Some(branch) = value.strip_prefix("branch refs/heads/") {
                worktree.branch = Some(branch.to_string());
            } else if value == "detached" {
                worktree.detached = true;
            } else if value == "locked" || value.starts_with("locked ") {
                worktree.locked = true;
            } else if value == "prunable" || value.starts_with("prunable ") {
                worktree.prunable = true;
            }
        }
    }
    if let Some(value) = current {
        records.push(value);
    }
    if records.is_empty() {
        return Err("git returned no worktrees".to_string());
    }
    Ok(records)
}

fn worktree_list(repo_path: &str) -> Result<Vec<GitWorktree>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["worktree", "list", "--porcelain", "-z"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    parse_worktree_list(&output.stdout)
}

fn safe_include_path(value: &str) -> Result<&Path, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!(
            "ignored-file include must be a relative path: {value}"
        ));
    }
    Ok(path)
}

fn copy_included_path(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("cannot include {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        let link = std::fs::read_link(source).map_err(|error| error.to_string())?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(link, target).map_err(|error| error.to_string())?;
        #[cfg(not(unix))]
        return Err("including symlinks is not supported on this platform".to_string());
    } else if metadata.is_dir() {
        std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_included_path(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::copy(source, target).map_err(|error| error.to_string())?;
    } else {
        return Err(format!("cannot include special file {}", source.display()));
    }
    Ok(())
}

fn cleanup_created_worktree(repo_path: &str, target: &Path) -> Result<(), String> {
    let target = target.to_string_lossy();
    let result = run_git(
        repo_path,
        &["worktree", "remove", "--force", target.as_ref()],
    );
    if result.ok {
        Ok(())
    } else if result.output.is_empty() {
        Err("git worktree remove --force failed".to_string())
    } else {
        Err(result.output)
    }
}

struct PrivateTempDirectory(PathBuf);

impl Drop for PrivateTempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn private_checkpoint_directory() -> Result<PrivateTempDirectory, String> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    use std::time::{SystemTime, UNIX_EPOCH};
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for _ in 0..1000 {
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "talos-checkpoint-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        match builder.create(&path) {
            Ok(()) => return Ok(PrivateTempDirectory(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "cannot create private checkpoint directory: {error}"
                ))
            }
        }
    }
    Err("cannot allocate a private checkpoint directory".to_string())
}

fn checkpoint_tree_once(repo_path: &str) -> Result<String, String> {
    let temporary = private_checkpoint_directory()?;
    let index_path = temporary.0.join("index");
    let run = |args: &[&str]| -> GitOpResult {
        match Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(args)
            .env("GIT_INDEX_FILE", &index_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
        {
            Ok(output) => GitOpResult {
                ok: output.status.success(),
                output: {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    if stderr.trim().is_empty() {
                        stdout.trim().to_string()
                    } else {
                        stderr.trim().to_string()
                    }
                },
            },
            Err(error) => GitOpResult {
                ok: false,
                output: error.to_string(),
            },
        }
    };
    let repo = open_repo(repo_path)?;
    let seed = if repo.head().is_ok() {
        run(&["read-tree", "HEAD"])
    } else {
        run(&["read-tree", "--empty"])
    };
    drop(repo);
    let result = if !seed.ok {
        Err(seed.output)
    } else {
        let add = run(&["add", "-A", "--", "."]);
        if !add.ok {
            Err(add.output)
        } else {
            let tree = run(&["write-tree"]);
            if tree.ok
                && tree.output.len() == 40
                && tree.output.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                Ok(tree.output)
            } else {
                Err(if tree.output.is_empty() {
                    "git write-tree failed".to_string()
                } else {
                    tree.output
                })
            }
        }
    };
    result
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
        let tab_group_id = repo_tab_group_id(&repo);
        Ok(RepoInfo { root, tab_group_id })
    })
    .await
}

/// List every checkout that shares this repository's common Git directory.
/// Paths are worktree identities; branch names are presentation/action data.
#[tauri::command]
pub async fn git_worktree_list(repo_path: String) -> Result<Vec<GitWorktree>, String> {
    blocking(move || worktree_list(&repo_path)).await
}

#[tauri::command]
pub async fn git_worktree_open(repo_path: String, path: String) -> Result<RepoInfo, String> {
    blocking(move || {
        let requested = PathBuf::from(&path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !worktree_list(&repo_path)?
            .into_iter()
            .any(|item| Path::new(&item.path).canonicalize().ok().as_ref() == Some(&requested))
        {
            return Err(format!("not a worktree of this repository: {path}"));
        }
        let repo = open_repo(&path)?;
        let workdir = repo
            .workdir()
            .ok_or_else(|| "bare repository".to_string())?;
        Ok(RepoInfo {
            root: workdir.to_string_lossy().trim_end_matches('/').to_string(),
            tab_group_id: repo_tab_group_id(&repo),
        })
    })
    .await
}

/// Create an isolated checkout and optionally copy an explicit allowlist of
/// ignored files from the parent checkout. The include list is deliberately
/// repository-relative and never inferred from ignored contents.
#[tauri::command]
pub async fn git_worktree_create(
    repo_path: String,
    path: String,
    branch: Option<String>,
    base: String,
    include_ignored: Vec<String>,
) -> Result<GitWorktreeCreateResult, String> {
    blocking(move || {
        let target = PathBuf::from(&path);
        if !target.is_absolute() {
            return Err("worktree path must be absolute".to_string());
        }
        if target.exists() {
            return Err(format!(
                "worktree path already exists: {}",
                target.display()
            ));
        }
        if base.starts_with('-') {
            return Err(format!("invalid base ref: {base}"));
        }
        if let Some(name) = branch.as_deref() {
            if name.trim().is_empty() || name.starts_with('-') {
                return Err(format!("invalid branch name: {name}"));
            }
        }
        // Validate the complete allowlist before creating anything. A bad
        // later entry must not leave a checkout behind.
        for value in &include_ignored {
            safe_include_path(value)?;
        }

        let repo = open_repo(&repo_path)?;
        let parent = repo
            .workdir()
            .ok_or_else(|| "bare repositories cannot create worktrees".to_string())?
            .to_path_buf();
        for value in &include_ignored {
            let relative = safe_include_path(value)?;
            if std::fs::symlink_metadata(parent.join(relative)).is_err() {
                return Err(format!("ignored-file include does not exist: {value}"));
            }
            let ignored = Command::new("git")
                .arg("-C")
                .arg(&parent)
                .args(["check-ignore", "-q", "--"])
                .arg(value)
                .status()
                .map_err(|error| format!("failed to validate ignored include: {error}"))?;
            if !ignored.success() {
                return Err(format!("include path is not ignored by Git: {value}"));
            }
        }
        let base_commit = repo
            .revparse_single(&base)
            .and_then(|object| object.peel_to_commit())
            .map_err(|error| format!("cannot resolve worktree base '{base}': {error}"))?
            .id()
            .to_string();
        drop(repo);

        let mut command = Command::new("git");
        command.arg("-C").arg(&repo_path).args(["worktree", "add"]);
        if let Some(name) = branch.as_deref() {
            command.arg("-b").arg(name);
        } else {
            command.arg("--detach");
        }
        command.arg(&target).arg(&base_commit);
        let output = command
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|error| format!("failed to run git: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            } else {
                stderr
            });
        }

        let finish_creation = (|| -> Result<GitWorktree, String> {
            for value in &include_ignored {
                let relative = safe_include_path(value)?;
                let source = parent.join(relative);
                let destination = target.join(relative);
                if std::fs::symlink_metadata(&destination).is_ok() {
                    return Err(format!("include destination already exists: {value}"));
                }
                copy_included_path(&source, &destination)?;
            }

            let target_canonical = target.canonicalize().unwrap_or(target.clone());
            worktree_list(&repo_path)?
                .into_iter()
                .find(|item| {
                    Path::new(&item.path)
                        .canonicalize()
                        .unwrap_or_else(|_| PathBuf::from(&item.path))
                        == target_canonical
                })
                .ok_or_else(|| "created worktree was not returned by git".to_string())
        })();
        let worktree = match finish_creation {
            Ok(worktree) => worktree,
            Err(error) => {
                // No caller-visible task exists yet, so cleanup cannot discard
                // user work. The newly created branch is intentionally kept.
                return Err(match cleanup_created_worktree(&repo_path, &target) {
                    Ok(()) => error,
                    Err(cleanup) => format!(
                        "{error}\nCleanup also failed; checkout remains at {}: {cleanup}",
                        target.display()
                    ),
                });
            }
        };
        Ok(GitWorktreeCreateResult {
            worktree,
            base_commit,
        })
    })
    .await
}

/// Remove only the checkout. Git's first refusal is preserved for dirty
/// worktrees; callers may retry with force after explicit confirmation.
/// Associated branches are never deleted here.
fn remove_worktree(repo_path: &str, path: &str, force: bool) -> Result<(), String> {
    let requested = PathBuf::from(path);
    let requested_key = requested.canonicalize().unwrap_or(requested.clone());
    let item = worktree_list(repo_path)?
        .into_iter()
        .find(|candidate| {
            Path::new(&candidate.path)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(&candidate.path))
                == requested_key
        })
        .ok_or_else(|| format!("not a worktree of this repository: {path}"))?;
    if item.main {
        return Err("the main worktree cannot be removed".to_string());
    }
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo_path)
        .args(["worktree", "remove"]);
    if force {
        // Git deliberately requires force twice to override an explicit
        // worktree lock. This path is reached only after the UI's second,
        // destructive confirmation and still never deletes the branch.
        command.args(["--force", "--force"]);
    }
    let output = command
        .arg(&item.path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("failed to run git: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        })
    }
}

#[tauri::command]
pub async fn git_worktree_remove(
    repo_path: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    blocking(move || remove_worktree(&repo_path, &path, force)).await
}

/// Merge an isolated task branch into the currently checked-out parent.
/// Both checkouts must be clean; Git owns conflict handling and diagnostics.
fn merge_worktree(parent_path: &str, worktree_path: &str) -> Result<(), String> {
    let path_key = |value: &str| {
        Path::new(value)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(value))
    };
    let parent_key = path_key(parent_path);
    let child_key = path_key(worktree_path);
    if parent_key == child_key {
        return Err("the parent and task checkout must be different worktrees".to_string());
    }
    let worktrees = worktree_list(parent_path)?;
    let parent = worktrees
        .iter()
        .find(|item| path_key(&item.path) == parent_key)
        .ok_or_else(|| "the parent path is not a worktree of this repository".to_string())?;
    let child = worktrees
        .iter()
        .find(|item| path_key(&item.path) == child_key)
        .ok_or_else(|| "the task path is not a worktree of the parent repository".to_string())?;
    if child.main {
        return Err("the main worktree cannot be used as an isolated task checkout".to_string());
    }
    let branch = child
        .branch
        .clone()
        .ok_or_else(|| "the task checkout must be on a branch before merging".to_string())?;
    let parent_path = parent.path.clone();
    let child_path = child.path.clone();

    let parent_repo = open_repo(&parent_path)?;
    if parent_repo.head_detached().unwrap_or(false) {
        return Err("cannot merge into a detached parent checkout".to_string());
    }
    let parent_status = run_git(&parent_path, &["status", "--porcelain"]);
    if !parent_status.ok || !parent_status.output.is_empty() {
        return Err(if parent_status.output.is_empty() {
            "the parent checkout must be clean before merging".to_string()
        } else {
            format!(
                "the parent checkout must be clean before merging:\n{}",
                parent_status.output
            )
        });
    }
    let child_status = run_git(&child_path, &["status", "--porcelain"]);
    if !child_status.ok || !child_status.output.is_empty() {
        return Err(if child_status.output.is_empty() {
            "the task checkout must be clean and committed before merging".to_string()
        } else {
            format!(
                "the task checkout must be clean and committed before merging:\n{}",
                child_status.output
            )
        });
    }
    let child_head = run_git(&child_path, &["symbolic-ref", "--short", "HEAD"]);
    if !child_head.ok || child_head.output != branch {
        return Err("the task checkout branch changed while preparing the merge".to_string());
    }
    let full_ref = format!("refs/heads/{branch}");
    parent_repo
        .find_reference(&full_ref)
        .map_err(|error| format!("cannot find task branch '{branch}': {error}"))?;
    drop(parent_repo);
    let result = run_git(&parent_path, &["merge", "--no-ff", &full_ref]);
    if result.ok {
        let child_after = run_git(&child_path, &["status", "--porcelain"]);
        let child_head_after = run_git(&child_path, &["symbolic-ref", "--short", "HEAD"]);
        let includes_tip = run_git(
            &parent_path,
            &["merge-base", "--is-ancestor", &full_ref, "HEAD"],
        );
        if child_after.ok
            && child_after.output.is_empty()
            && child_head_after.ok
            && child_head_after.output == branch
            && includes_tip.ok
        {
            Ok(())
        } else {
            Err(
                "the task checkout changed while merging; earlier commits may be applied, but the task remains active so you can review and merge again"
                    .to_string(),
            )
        }
    } else {
        let _ = run_git(&parent_path, &["merge", "--abort"]);
        Err(if result.output.is_empty() {
            "git merge failed".to_string()
        } else {
            result.output
        })
    }
}

#[tauri::command]
pub async fn git_worktree_merge(parent_path: String, worktree_path: String) -> Result<(), String> {
    blocking(move || merge_worktree(&parent_path, &worktree_path)).await
}

fn hash_tag(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn hash_index_path(
    hasher: &mut Sha256,
    repo: &Repository,
    index: &git2::Index,
    relative: &str,
) -> Result<(), String> {
    let mut found = false;
    for stage in 0..=3 {
        if let Some(entry) = index.get_path(Path::new(relative), stage) {
            found = true;
            hash_tag(hasher, b"stage");
            hasher.update((stage as u32).to_le_bytes());
            hasher.update(entry.mode.to_le_bytes());
            if entry.mode == 0o160000 {
                // A gitlink points at a commit, not a blob. Its oid is the
                // complete staged submodule content boundary.
                hash_tag(hasher, b"gitlink");
                hash_tag(hasher, entry.id.to_string().as_bytes());
            } else {
                hash_index_blob(hasher, repo, entry.id)?;
            }
        }
    }
    if !found {
        hash_tag(hasher, b"deleted");
    }
    Ok(())
}

fn hash_dirty_repository(hasher: &mut Sha256, repo: &Repository) -> Result<(), String> {
    let root = repo
        .workdir()
        .ok_or_else(|| "submodule has no working directory".to_string())?;
    let head = repo.head().ok().and_then(|value| value.target());
    hash_tag(
        hasher,
        head.map(|oid| oid.to_string())
            .as_deref()
            .unwrap_or("unborn")
            .as_bytes(),
    );
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| e.to_string())?;
    let index = repo.index().map_err(|e| e.to_string())?;
    let mut entries = statuses
        .iter()
        .map(|entry| (lossy(entry.path_bytes()), entry.status()))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (path, status) in entries {
        hash_tag(hasher, path.as_bytes());
        hasher.update(status.bits().to_le_bytes());
        if status.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE
                | Status::CONFLICTED,
        ) {
            hash_index_path(hasher, repo, &index, &path)?;
        }
        if status.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE
                | Status::CONFLICTED,
        ) {
            hash_worktree_path(hasher, root, &path)?;
        }
    }
    Ok(())
}

fn hash_worktree_path(hasher: &mut Sha256, root: &Path, relative: &str) -> Result<(), String> {
    let path = root.join(relative);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            hash_tag(hasher, b"deleted");
            return Ok(());
        }
        Err(error) => return Err(format!("read {relative}: {error}")),
    };
    if metadata.file_type().is_symlink() {
        hash_tag(hasher, b"symlink");
        let target = std::fs::read_link(&path).map_err(|e| format!("read {relative}: {e}"))?;
        hash_tag(hasher, target.to_string_lossy().as_bytes());
        return Ok(());
    }
    if metadata.is_dir() {
        // Git reports a changed submodule as its directory. Fold both its
        // checked-out commit and nested dirty/index/untracked state into the
        // parent fingerprint. Ordinary untracked directories are expanded by
        // recurse_untracked_dirs and do not reach this branch.
        hash_tag(hasher, b"submodule");
        if let Ok(repo) = Repository::open(&path) {
            hash_dirty_repository(hasher, &repo)?;
        }
        return Ok(());
    }
    hash_tag(hasher, b"file");
    #[cfg(unix)]
    hasher.update((metadata.mode() & 0o111).to_le_bytes());
    hasher.update(metadata.len().to_le_bytes());
    let mut file = File::open(&path).map_err(|e| format!("read {relative}: {e}"))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("read {relative}: {e}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(())
}

fn hash_index_blob(hasher: &mut Sha256, repo: &Repository, oid: Oid) -> Result<(), String> {
    if let Ok(odb) = repo.odb() {
        if let Ok((mut reader, size, _kind)) = odb.reader(oid) {
            hasher.update((size as u64).to_le_bytes());
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    return Ok(());
                }
                hasher.update(&buffer[..count]);
            }
        }
    }
    // Some packed/delta ODB backends do not expose a stream. The libgit2
    // slice is the compatibility fallback; it is still hashed in Rust and is
    // never cloned or returned over IPC.
    let blob = repo.find_blob(oid).map_err(|e| e.to_string())?;
    hasher.update((blob.size() as u64).to_le_bytes());
    hasher.update(blob.content());
    Ok(())
}

fn review_snapshot_once(
    repo_path: &str,
    base_head: Option<&str>,
    base_unborn: bool,
) -> Result<GitReviewSnapshot, String> {
    let repo = open_repo(repo_path)?;
    let root = repo
        .workdir()
        .ok_or_else(|| "repository has no working directory (bare repo)".to_string())?;
    let head_oid = repo.head().ok().and_then(|head| head.target());
    let head = head_oid.map(|oid| oid.to_string());
    let base_ancestry = match (base_head, head_oid) {
        (Some(base), Some(current)) => match Oid::from_str(base) {
            Ok(base_oid) if base_oid == current => "same",
            Ok(base_oid) => match repo.graph_descendant_of(current, base_oid) {
                Ok(true) => "ahead",
                Ok(false) => "diverged",
                Err(_) => "unavailable",
            },
            Err(_) => "unavailable",
        },
        (None, None) if base_unborn => "same",
        (None, Some(_)) if base_unborn => "ahead",
        _ => "unavailable",
    }
    .to_string();

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| e.to_string())?;
    let mut changed = BTreeSet::new();
    let mut conflicted = BTreeSet::new();
    // A path can have independent staged and worktree content. Preserve
    // both namespaces in sorted order so the digest is deterministic.
    let mut sources: BTreeMap<(String, String), ()> = BTreeMap::new();
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
        let path = lossy(entry.path_bytes());
        let status = entry.status();
        changed.insert(path.clone());
        if status.contains(Status::CONFLICTED) {
            conflicted.insert(path.clone());
        }
        if status.intersects(INDEX_BITS) || status.contains(Status::CONFLICTED) {
            sources.insert((path.clone(), "index".to_string()), ());
        }
        if status.intersects(WT_BITS)
            || status.contains(Status::WT_NEW)
            || status.contains(Status::CONFLICTED)
        {
            sources.insert((path, "worktree".to_string()), ());
        }
    }

    // Changes may have been committed by the agent, leaving a clean
    // worktree. Review scope is base..current plus local changes, not
    // merely `git status` at the moment of inspection.
    if let (Some(base), Some(current)) = (base_head, head_oid) {
        if let Ok(base_oid) = Oid::from_str(base) {
            if let (Ok(base_commit), Ok(current_commit)) =
                (repo.find_commit(base_oid), repo.find_commit(current))
            {
                if let (Ok(base_tree), Ok(current_tree)) =
                    (base_commit.tree(), current_commit.tree())
                {
                    if let Ok(diff) =
                        repo.diff_tree_to_tree(Some(&base_tree), Some(&current_tree), None)
                    {
                        for delta in diff.deltas() {
                            if let Some(path) = diff_file_path(delta.new_file())
                                .or_else(|| diff_file_path(delta.old_file()))
                            {
                                changed.insert(path);
                            }
                        }
                    }
                }
            }
        }
    }

    let index = repo.index().map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hash_tag(&mut hasher, b"talos-review-v1");
    hash_tag(&mut hasher, head.as_deref().unwrap_or("unborn").as_bytes());
    for ((path, source), ()) in &sources {
        hash_tag(&mut hasher, source.as_bytes());
        hash_tag(&mut hasher, path.as_bytes());
        if source == "index" {
            hash_index_path(&mut hasher, &repo, &index, path)?;
        } else {
            hash_worktree_path(&mut hasher, root, path)?;
        }
    }
    let head_tree = repo.head().ok().and_then(|value| value.peel_to_tree().ok());
    let mut file_fingerprints = BTreeMap::new();
    for path in &changed {
        let mut file_hasher = Sha256::new();
        hash_tag(&mut file_hasher, b"talos-review-file-v1");
        hash_tag(&mut file_hasher, path.as_bytes());
        if let Some(entry) = head_tree
            .as_ref()
            .and_then(|tree| tree.get_path(Path::new(path)).ok())
        {
            hash_tag(&mut file_hasher, b"head");
            file_hasher.update(entry.filemode().to_le_bytes());
            hash_tag(&mut file_hasher, entry.id().to_string().as_bytes());
        } else {
            hash_tag(&mut file_hasher, b"no-head");
        }
        hash_tag(&mut file_hasher, b"index");
        hash_index_path(&mut file_hasher, &repo, &index, path)?;
        hash_tag(&mut file_hasher, b"worktree");
        hash_worktree_path(&mut file_hasher, root, path)?;
        file_fingerprints.insert(path.clone(), format!("{:x}", file_hasher.finalize()));
    }
    Ok(GitReviewSnapshot {
        head,
        base_ancestry,
        changed_files: changed.into_iter().collect(),
        conflicted_files: conflicted.into_iter().collect(),
        file_fingerprints,
        fingerprint: format!("{:x}", hasher.finalize()),
    })
}

fn repository_generation(repo_path: &str) -> Result<Vec<u8>, String> {
    let repo = open_repo(repo_path)?;
    let root = repo
        .workdir()
        .ok_or_else(|| "repository has no working directory (bare repo)".to_string())?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hash_tag(
        &mut hasher,
        repo.head()
            .ok()
            .and_then(|head| head.target())
            .map(|oid| oid.to_string())
            .as_deref()
            .unwrap_or("unborn")
            .as_bytes(),
    );
    let mut entries = statuses
        .iter()
        .map(|entry| (lossy(entry.path_bytes()), entry.status()))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (path, status) in entries {
        hash_tag(&mut hasher, path.as_bytes());
        hasher.update(status.bits().to_le_bytes());
        if let Ok(metadata) = std::fs::symlink_metadata(root.join(&path)) {
            hasher.update(metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified() {
                if let Ok(value) = modified.duration_since(std::time::UNIX_EPOCH) {
                    hasher.update(value.as_nanos().to_le_bytes());
                }
            }
            #[cfg(unix)]
            hasher.update(metadata.mode().to_le_bytes());
        }
    }
    if let Ok(metadata) = std::fs::metadata(repo.path().join("index")) {
        hasher.update(metadata.len().to_le_bytes());
        if let Ok(modified) = metadata.modified() {
            if let Ok(value) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(value.as_nanos().to_le_bytes());
            }
        }
    }
    Ok(hasher.finalize().to_vec())
}

fn review_snapshot(
    repo_path: &str,
    base_head: Option<&str>,
    base_unborn: bool,
) -> Result<GitReviewSnapshot, String> {
    for _ in 0..3 {
        let before = repository_generation(repo_path)?;
        let snapshot = review_snapshot_once(repo_path, base_head, base_unborn)?;
        if before == repository_generation(repo_path)? {
            return Ok(snapshot);
        }
    }
    Err("repository kept changing while review evidence was captured".to_string())
}

fn checkpoint_snapshot(
    repo_path: &str,
    base_head: Option<&str>,
    base_unborn: bool,
) -> Result<GitCheckpointSnapshot, String> {
    for _ in 0..3 {
        let before = repository_generation(repo_path)?;
        let tree = checkpoint_tree_once(repo_path)?;
        let snapshot = review_snapshot_once(repo_path, base_head, base_unborn)?;
        if before == repository_generation(repo_path)? {
            return Ok(GitCheckpointSnapshot { tree, snapshot });
        }
    }
    Err("repository kept changing while checkpoint evidence was captured".to_string())
}

#[tauri::command]
pub async fn git_review_head(repo_path: String) -> Result<Option<String>, String> {
    blocking(move || {
        let repo = open_repo(&repo_path)?;
        Ok(repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .map(|oid| oid.to_string()))
    })
    .await
}

/// Capture current repository evidence for an owned agent task. The base is
/// optional because the first capture also obtains it. Contents are hashed in
/// Rust and never returned to the frontend.
#[tauri::command]
pub async fn git_review_snapshot(
    repo_path: String,
    base_head: Option<String>,
    base_unborn: bool,
) -> Result<GitReviewSnapshot, String> {
    blocking(move || review_snapshot(&repo_path, base_head.as_deref(), base_unborn)).await
}

/// Capture the checkpoint tree and its per-file review hashes under one
/// repository-generation guard, so latest-turn evidence cannot combine two
/// different filesystem states.
#[tauri::command]
pub async fn git_checkpoint_snapshot(
    repo_path: String,
    base_head: Option<String>,
    base_unborn: bool,
) -> Result<GitCheckpointSnapshot, String> {
    blocking(move || checkpoint_snapshot(&repo_path, base_head.as_deref(), base_unborn)).await
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
            "checkpoint" => {
                let tree_oid =
                    oid.ok_or_else(|| "tree oid is required for checkpoint diffs".to_string())?;
                let tid = Oid::from_str(&tree_oid).map_err(|error| error.to_string())?;
                let tree = repo.find_tree(tid).map_err(|error| error.to_string())?;
                let old = blob_from_tree(&repo, Some(&tree), old_rel);
                let new = worktree_text(&repo, rel);
                (
                    old,
                    format!("Checkpoint {}", short_oid(tid)),
                    new,
                    "Current".to_string(),
                )
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

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_repo() -> (std::path::PathBuf, Repository) {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "talos-review-{}-{stamp}-{sequence}",
            std::process::id(),
        ));
        let repo = Repository::init(&path).unwrap();
        (path, repo)
    }

    fn commit_file(repo: &Repository, path: &Path, content: &[u8], message: &str) -> Oid {
        std::fs::write(repo.workdir().unwrap().join(path), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(path).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = git2::Signature::now("Talos Test", "talos@example.test").unwrap();
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
        repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents).unwrap()
    }

    #[test]
    fn review_snapshot_tracks_clean_dirty_staged_untracked_and_large_content() {
        let (path, repo) = temp_repo();
        let base = commit_file(&repo, Path::new("tracked.txt"), b"base\n", "base");
        let base = base.to_string();
        let clean = review_snapshot(path.to_str().unwrap(), Some(&base), false).unwrap();
        assert!(clean.changed_files.is_empty());
        assert_eq!(clean.base_ancestry, "same");
        assert_eq!(
            clean.fingerprint,
            review_snapshot(path.to_str().unwrap(), Some(&base), false)
                .unwrap()
                .fingerprint
        );

        std::fs::write(path.join("tracked.txt"), b"dirty\n").unwrap();
        let dirty = review_snapshot(path.to_str().unwrap(), Some(&base), false).unwrap();
        assert_eq!(dirty.changed_files, vec!["tracked.txt"]);
        assert_ne!(clean.fingerprint, dirty.fingerprint);

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let staged = review_snapshot(path.to_str().unwrap(), Some(&base), false).unwrap();
        assert_eq!(staged.changed_files, vec!["tracked.txt"]);
        assert_ne!(dirty.fingerprint, staged.fingerprint);

        std::fs::write(path.join("large.bin"), vec![7_u8; 2 * 1024 * 1024]).unwrap();
        let untracked = review_snapshot(path.to_str().unwrap(), Some(&base), false).unwrap();
        assert_eq!(untracked.changed_files, vec!["large.bin", "tracked.txt"]);
        assert_eq!(
            untracked.fingerprint,
            review_snapshot(path.to_str().unwrap(), Some(&base), false)
                .unwrap()
                .fingerprint
        );
        drop(repo);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn review_snapshot_keeps_committed_changes_and_detects_conflicts() {
        let (path, repo) = temp_repo();
        let base = commit_file(&repo, Path::new("file.txt"), b"base\n", "base");
        let main_ref = repo.head().unwrap().name().unwrap().to_string();
        let base_commit = repo.find_commit(base).unwrap();
        repo.branch("other", &base_commit, false).unwrap();
        drop(base_commit);
        repo.set_head("refs/heads/other").unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force())).unwrap();
        commit_file(&repo, Path::new("file.txt"), b"other\n", "other");
        repo.set_head(&main_ref).unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force())).unwrap();
        commit_file(&repo, Path::new("file.txt"), b"ours\n", "ours");

        let committed =
            review_snapshot(path.to_str().unwrap(), Some(&base.to_string()), false).unwrap();
        assert_eq!(committed.base_ancestry, "ahead");
        assert_eq!(committed.changed_files, vec!["file.txt"]);

        let merge = run_git(path.to_str().unwrap(), &["merge", "other"]);
        assert!(!merge.ok);
        let conflict =
            review_snapshot(path.to_str().unwrap(), Some(&base.to_string()), false).unwrap();
        assert_eq!(conflict.conflicted_files, vec!["file.txt"]);
        let _ = run_git(path.to_str().unwrap(), &["merge", "--abort"]);
        drop(repo);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn review_snapshot_models_unborn_ancestry_and_executable_mode() {
        let (path, repo) = temp_repo();
        let unborn = review_snapshot(path.to_str().unwrap(), None, true).unwrap();
        assert_eq!(unborn.base_ancestry, "same");

        std::fs::write(path.join("script.sh"), b"#!/bin/sh\nexit 0\n").unwrap();
        let first = commit_file(
            &repo,
            Path::new("script.sh"),
            b"#!/bin/sh\nexit 0\n",
            "first",
        );
        let after_first = review_snapshot(path.to_str().unwrap(), None, true).unwrap();
        assert_eq!(after_first.base_ancestry, "ahead");

        #[cfg(unix)]
        {
            let script = path.join("script.sh");
            let before_mode =
                review_snapshot(path.to_str().unwrap(), Some(&first.to_string()), false).unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(permissions.mode() | 0o111);
            std::fs::set_permissions(&script, permissions).unwrap();
            let executable =
                review_snapshot(path.to_str().unwrap(), Some(&first.to_string()), false).unwrap();
            assert_ne!(before_mode.fingerprint, executable.fingerprint);
        }

        drop(repo);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn normalizes_hosted_clone_urls_without_credentials() {
        let expected = "remote:github.com/OpenAI/codex";
        for remote in [
            "https://token@GitHub.com/OpenAI/codex.git",
            "ssh://git@github.com/OpenAI/codex.git/",
            "git@github.com:OpenAI/codex.git",
        ] {
            assert_eq!(hosted_remote_id(remote).as_deref(), Some(expected));
        }
    }

    #[test]
    fn keeps_explicit_hosts_and_ports_distinct() {
        assert_eq!(
            hosted_remote_id("https://git.example.test:8443/team/app.git").as_deref(),
            Some("remote:git.example.test:8443/team/app")
        );
        assert_ne!(
            hosted_remote_id("https://one.example/team/app.git"),
            hosted_remote_id("https://two.example/team/app.git")
        );
    }

    #[test]
    fn rejects_local_paths_as_hosted_remotes() {
        for remote in ["/tmp/repo.git", "../repo.git", "file:///tmp/repo.git"] {
            assert_eq!(hosted_remote_id(remote), None);
        }
    }

    #[test]
    fn parses_porcelain_worktree_records_without_losing_flags() {
        let raw = b"worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /repo-task\0HEAD 2222222222222222222222222222222222222222\0detached\0locked user reason\0prunable stale\0\0";
        let items = parse_worktree_list(raw).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0].main);
        assert_eq!(items[0].branch.as_deref(), Some("main"));
        assert!(!items[0].detached);
        assert!(!items[1].main);
        assert!(items[1].detached);
        assert!(items[1].locked);
        assert!(items[1].prunable);
    }

    #[test]
    fn ignored_file_includes_reject_absolute_and_parent_paths() {
        assert!(safe_include_path(".env").is_ok());
        assert!(safe_include_path("config/local.json").is_ok());
        assert!(safe_include_path("/tmp/secret").is_err());
        assert!(safe_include_path("../secret").is_err());
        assert!(safe_include_path("config/../secret").is_err());
    }

    #[test]
    fn worktree_helpers_follow_git_safety_and_keep_the_branch() {
        let (path, repo) = temp_repo();
        commit_file(&repo, Path::new("tracked.txt"), b"base\n", "base");
        drop(repo);
        let checkout = path.with_file_name(format!(
            "{}-isolated",
            path.file_name().unwrap().to_string_lossy()
        ));
        let checkout_text = checkout.to_string_lossy().into_owned();
        let created = run_git(
            path.to_str().unwrap(),
            &[
                "worktree",
                "add",
                "-b",
                "talos/test-task",
                &checkout_text,
                "HEAD",
            ],
        );
        assert!(created.ok, "{}", created.output);
        let listed = worktree_list(path.to_str().unwrap()).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1].branch.as_deref(), Some("talos/test-task"));

        std::fs::write(checkout.join("tracked.txt"), b"dirty\n").unwrap();
        let refused = remove_worktree(path.to_str().unwrap(), &checkout_text, false);
        assert!(refused.is_err());
        let locked = run_git(
            path.to_str().unwrap(),
            &["worktree", "lock", &checkout_text],
        );
        assert!(locked.ok, "{}", locked.output);
        remove_worktree(path.to_str().unwrap(), &checkout_text, true).unwrap();
        let repository = open_repo(path.to_str().unwrap()).unwrap();
        assert!(repository
            .find_branch("talos/test-task", BranchType::Local)
            .is_ok());
        drop(repository);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn checkpoint_snapshot_returns_tree_and_matching_review_evidence() {
        let (path, repo) = temp_repo();
        let base = commit_file(&repo, Path::new("tracked.txt"), b"base\n", "base");
        std::fs::write(path.join("tracked.txt"), b"edited\n").unwrap();
        std::fs::write(path.join("new.txt"), b"new\n").unwrap();

        let captured =
            checkpoint_snapshot(path.to_str().unwrap(), Some(&base.to_string()), false).unwrap();
        assert_eq!(
            captured.snapshot.changed_files,
            vec!["new.txt".to_string(), "tracked.txt".to_string()]
        );
        assert_eq!(captured.snapshot.file_fingerprints.len(), 2);
        let tree = repo
            .find_tree(Oid::from_str(&captured.tree).unwrap())
            .unwrap();
        assert!(tree.get_path(Path::new("new.txt")).is_ok());
        let tracked = tree.get_path(Path::new("tracked.txt")).unwrap();
        assert_eq!(repo.find_blob(tracked.id()).unwrap().content(), b"edited\n");
        let index = repo.index().unwrap();
        assert!(index.get_path(Path::new("new.txt"), 0).is_none());

        drop(tree);
        drop(repo);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn checkpoint_directory_is_private() {
        let directory = private_checkpoint_directory().unwrap();
        let metadata = std::fs::metadata(&directory.0).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o700);
    }

    #[test]
    fn merge_rejects_a_checkout_from_an_unrelated_repository() {
        let (parent_path, parent_repo) = temp_repo();
        commit_file(&parent_repo, Path::new("parent.txt"), b"parent\n", "parent");
        let (other_path, other_repo) = temp_repo();
        commit_file(&other_repo, Path::new("other.txt"), b"other\n", "other");
        drop(parent_repo);
        drop(other_repo);

        let error = merge_worktree(parent_path.to_str().unwrap(), other_path.to_str().unwrap())
            .unwrap_err();
        assert!(error.contains("not a worktree of the parent repository"));

        std::fs::remove_dir_all(parent_path).unwrap();
        std::fs::remove_dir_all(other_path).unwrap();
    }

    #[test]
    fn merge_accepts_a_clean_branch_from_the_same_worktree_set() {
        let (parent_path, parent_repo) = temp_repo();
        commit_file(&parent_repo, Path::new("base.txt"), b"base\n", "base");
        let mut config = parent_repo.config().unwrap();
        config.set_str("user.name", "Talos Test").unwrap();
        config.set_str("user.email", "talos@example.test").unwrap();
        drop(config);
        drop(parent_repo);

        let checkout = parent_path.with_extension("merge-worktree");
        let checkout_text = checkout.to_string_lossy().into_owned();
        let created = run_git(
            parent_path.to_str().unwrap(),
            &[
                "worktree",
                "add",
                "-b",
                "talos/merge-test",
                &checkout_text,
                "HEAD",
            ],
        );
        assert!(created.ok, "{}", created.output);
        let child_repo = open_repo(checkout.to_str().unwrap()).unwrap();
        commit_file(&child_repo, Path::new("child.txt"), b"child\n", "child");
        drop(child_repo);

        merge_worktree(parent_path.to_str().unwrap(), checkout.to_str().unwrap()).unwrap();
        assert_eq!(
            std::fs::read(parent_path.join("child.txt")).unwrap(),
            b"child\n"
        );

        let removed = run_git(
            parent_path.to_str().unwrap(),
            &["worktree", "remove", &checkout_text],
        );
        assert!(removed.ok, "{}", removed.output);
        std::fs::remove_dir_all(parent_path).unwrap();
    }
}
