//! Workspace file listing (Quick Open + Explorer filename search) and
//! Explorer content search (⌘⇧F).
//!
//! Both commands walk the workspace with the `ignore` crate (ripgrep's
//! walker), so .gitignore / global excludes are respected when present
//! without shelling out. Listing is a cheap serial walk (paths only); content
//! search uses the parallel walker because it reads file bodies, and quits
//! early once the global match cap is hit. All blocking work runs on the
//! blocking pool so it never stalls the async runtime that also serves terminal IPC.

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};

use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::Serialize;

use crate::fsops::{BINARY_SNIFF_BYTES, MAX_TEXT_BYTES};

/// Workspace file-list cap; plenty for fuzzy filtering, bounds IPC size.
const MAX_LIST_FILES: usize = 50_000;

/// Global match cap across all files: bounds IPC payload and DOM size.
const MAX_TOTAL_MATCHES: usize = 2000;

/// Per-file match cap (one degenerate file must not eat the global budget).
const MAX_FILE_MATCHES: usize = 200;

/// Display window for a match row: context chars kept before the match and
/// the total window length. Keeps minified one-liners from flooding the wire.
const WINDOW_BEFORE_CHARS: usize = 40;
const WINDOW_TOTAL_CHARS: usize = 240;

/// Shared walker config: dotfiles ARE listed (VS Code-style), so `.git` is
/// no longer auto-hidden and must be excluded explicitly. Symlinks are not
/// followed (walker default). Threads only affect `build_parallel`.
fn walker(root: &str) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(false)
        .filter_entry(|e| e.file_name() != ".git")
        .threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)));
    b
}

// ---------------------------------------------------------------------------
// File listing (Quick Open / Explorer search)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFiles {
    /// Workspace-root-relative POSIX paths, sorted.
    files: Vec<String>,
    truncated: bool,
}

#[tauri::command]
pub async fn list_workspace_files(repo_path: String) -> Result<WorkspaceFiles, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(list_impl(&repo_path)))
        .await
        .map_err(|e| e.to_string())?
}

fn list_impl(root: &str) -> WorkspaceFiles {
    let mut files: Vec<String> = Vec::new();
    let mut truncated = false;
    for entry in walker(root).build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() >= MAX_LIST_FILES {
            truncated = true;
            break;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            files.push(rel.to_string_lossy().into_owned());
        }
    }
    files.sort_unstable();
    WorkspaceFiles { files, truncated }
}

// ---------------------------------------------------------------------------
// Content search
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based.
    line_number: u32,
    /// 1-based UTF-16 column of the match start in the FULL line — for
    /// placing the editor cursor (CodeMirror positions are UTF-16).
    column: u32,
    /// Display window around the match (long lines are trimmed).
    text: String,
    /// UTF-16 highlight range within `text`.
    start: u32,
    end: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
    /// Workspace-root-relative POSIX path.
    file: String,
    matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    files: Vec<SearchFileResult>,
    total_matches: u32,
    /// A cap was hit (global or per-file): there may be more matches.
    truncated: bool,
}

#[tauri::command]
pub async fn search_workspace(
    repo_path: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_impl(&repo_path, &query, case_sensitive, whole_word, regex)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search_impl(
    root: &str,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult { files: Vec::new(), total_matches: 0, truncated: false });
    }
    let pat = if regex { query.to_string() } else { regex::escape(query) };
    let pat = if whole_word { format!(r"\b(?:{pat})\b") } else { pat };
    // Invalid regex (incl. transient states while typing) -> Err, shown inline.
    let re = RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;

    let total = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<SearchFileResult>();

    walker(root).build_parallel().run(|| {
        let tx = tx.clone();
        let re = re.clone();
        let total = Arc::clone(&total);
        let truncated = Arc::clone(&truncated);
        let root = root.to_string();
        Box::new(move |entry| {
            if total.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&root) else {
                return WalkState::Continue;
            };
            let rel = rel.to_string_lossy().into_owned();
            if let Some(mut res) = search_file(entry.path(), rel, &re, &truncated) {
                // Claim budget atomically; trim to whatever room is left so
                // concurrent workers can't blow past the global cap.
                let n = res.matches.len();
                let prev = total.fetch_add(n, Ordering::Relaxed);
                if prev >= MAX_TOTAL_MATCHES {
                    truncated.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                if n > MAX_TOTAL_MATCHES - prev {
                    res.matches.truncate(MAX_TOTAL_MATCHES - prev);
                    truncated.store(true, Ordering::Relaxed);
                }
                let _ = tx.send(res);
            }
            WalkState::Continue
        })
    });
    drop(tx);

    let mut files: Vec<SearchFileResult> = rx.into_iter().collect();
    files.sort_unstable_by(|a, b| a.file.cmp(&b.file));
    let total_matches = files.iter().map(|f| f.matches.len()).sum::<usize>() as u32;
    Ok(SearchResult {
        files,
        total_matches,
        truncated: truncated.load(Ordering::Relaxed),
    })
}

/// Search one file. Skips (returns None) oversized, binary, and non-UTF-8
/// files using the same rules as fsops::fs_read_file, so "searchable" always
/// matches what the editor can open — and we never lossy-decode.
fn search_file(
    path: &Path,
    rel: String,
    re: &Regex,
    truncated: &AtomicBool,
) -> Option<SearchFileResult> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes: Vec<u8> = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > MAX_TEXT_BYTES {
        return None;
    }
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;

    let mut matches: Vec<SearchMatch> = Vec::new();
    'lines: for (i, line) in text.lines().enumerate() {
        for m in re.find_iter(line) {
            if matches.len() >= MAX_FILE_MATCHES {
                truncated.store(true, Ordering::Relaxed);
                break 'lines;
            }
            matches.push(make_match(line, (i + 1) as u32, m.start(), m.end()));
        }
    }
    if matches.is_empty() {
        None
    } else {
        Some(SearchFileResult { file: rel, matches })
    }
}

/// UTF-16 code-unit length of `s` — what JS string indexing uses. ASCII fast
/// path: one code unit per byte.
fn utf16_len(s: &str) -> usize {
    if s.is_ascii() {
        s.len()
    } else {
        s.chars().map(char::len_utf16).sum()
    }
}

/// Build a match row: trim the line to a display window around the match
/// (byte-range `mb_start..mb_end`) and report UTF-16 highlight offsets.
fn make_match(line: &str, line_number: u32, mb_start: usize, mb_end: usize) -> SearchMatch {
    // The cursor column reflects the FULL line, before any display trimming.
    let column = utf16_len(&line[..mb_start]) as u32 + 1;

    // Drop leading indentation from the display text (VS Code-style) —
    // unless the match itself starts inside it (someone searching whitespace).
    let trim = line.len() - line.trim_start().len();
    let (line, mb_start, mb_end) = if mb_start >= trim {
        (&line[trim..], mb_start - trim, mb_end - trim)
    } else {
        (line, mb_start, mb_end)
    };

    // Window start: up to WINDOW_BEFORE_CHARS chars of context before the
    // match; end: WINDOW_TOTAL_CHARS chars after the window start.
    let w_start = line[..mb_start]
        .char_indices()
        .rev()
        .take(WINDOW_BEFORE_CHARS)
        .last()
        .map_or(mb_start, |(i, _)| i);
    let w_end = line[w_start..]
        .char_indices()
        .nth(WINDOW_TOTAL_CHARS)
        .map_or(line.len(), |(i, _)| w_start + i);

    let start = utf16_len(&line[w_start..mb_start]);
    // A match longer than the window highlights up to the window's edge.
    let end = start + utf16_len(&line[mb_start..mb_end.min(w_end)]);
    SearchMatch {
        line_number,
        column,
        text: line[w_start..w_end].to_string(),
        start: start as u32,
        end: end as u32,
    }
}
