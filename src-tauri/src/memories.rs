//! Project memory browsing: surfaces the per-project auto-memories the two
//! coding agents keep, so they're viewable from the status bar.
//!
//! Claude Code writes one markdown file per memory under
//! `~/.claude/projects/<munged>/memory/` where `<munged>` is the absolute
//! project path with every '/' turned into '-' (e.g.
//! `/Users/kevin/repos/minimal-ide` -> `-Users-kevin-repos-minimal-ide`).
//! `MEMORY.md` there is the human index; the rest are individual memories with
//! a YAML frontmatter block (name / description / metadata.type).
//!
//! Codex keeps auto-memories in a versioned sqlite store
//! (`~/.codex/memories_<n>.sqlite`, table `stage1_outputs.raw_memory`) keyed by
//! `thread_id`; the project a thread ran in lives in a SEPARATE versioned db
//! (`~/.codex/state_<n>.sqlite`, table `threads.cwd`), so we ATTACH the state
//! db and join on `thread_id`, filtering by the project path. Both open
//! read-only through `file:` URIs (`?mode=ro`) — the stores run in WAL mode, so
//! `immutable=1` would hide the uncommitted -wal tail. No rusqlite dependency:
//! we shell out to the system `/usr/bin/sqlite3` exactly as usage.rs shells out
//! to `codex` / `curl`. The repo's own `AGENTS.md` (Codex's durable per-project
//! instructions) is surfaced alongside when present.
//!
//! All I/O runs on the blocking pool so it never stalls the async runtime that
//! also serves terminal IPC.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Per-memory read cap. Agent memories are tiny; this only guards against a
/// pathological file, well under fsops' 5 MB editor cap.
const MAX_MEMORY_BYTES: u64 = 512 * 1024;

/// Row cap on the Codex sqlite join — a project with a long history could
/// accumulate many thread memories; the popover only needs a browsable slice.
const CODEX_ROW_LIMIT: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    /// Stable id for React keys — the file path (Claude / AGENTS.md) or the
    /// Codex thread id.
    id: String,
    title: String,
    description: String,
    /// Short source/type tag shown as a chip (memory type, "Auto-memory",
    /// "AGENTS.md").
    kind: String,
    /// Full markdown body (frontmatter stripped for Claude files).
    content: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemories {
    claude: Vec<MemoryEntry>,
    codex: Vec<MemoryEntry>,
}

#[tauri::command]
pub async fn memories_list(project_path: String) -> Result<ProjectMemories, String> {
    tauri::async_runtime::spawn_blocking(move || ProjectMemories {
        claude: claude_memories(&project_path),
        codex: codex_memories(&project_path),
    })
    .await
    .map_err(|e| e.to_string())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Read a UTF-8 text file, capped and dropping non-UTF-8 content (we only ever
/// render these as markdown text).
fn read_text(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(MAX_MEMORY_BYTES).read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

// ---------------------------------------------------------------------------
// Claude memories
// ---------------------------------------------------------------------------

fn claude_memories(project_path: &str) -> Vec<MemoryEntry> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let munged = project_path.replace('/', "-");
    let dir = home.join(".claude/projects").join(munged).join("memory");
    let Ok(read) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut files: Vec<PathBuf> = read
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().and_then(|x| x.to_str()) == Some("md")
                // MEMORY.md is the index, not a memory.
                && p.file_name().and_then(|n| n.to_str()) != Some("MEMORY.md")
        })
        .collect();
    files.sort();

    let mut entries = Vec::new();
    for path in files {
        let Some(text) = read_text(&path) else {
            continue;
        };
        let (front, body) = split_frontmatter(&text);
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        entries.push(MemoryEntry {
            id: path.to_string_lossy().into_owned(),
            title: front_field(front, "name").unwrap_or(stem),
            description: front_field(front, "description").unwrap_or_default(),
            kind: front_type(front).unwrap_or_default(),
            content: body.trim().to_string(),
        });
    }
    entries
}

/// Split a leading `---\n … \n---` YAML frontmatter block off the top of a
/// markdown file. Returns (frontmatter, body); no block → ("", whole text).
fn split_frontmatter(text: &str) -> (&str, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return ("", text);
    };
    match rest.find("\n---\n") {
        Some(i) => (&rest[..i], &rest[i + 5..]),
        None => ("", text),
    }
}

/// Value of a top-level `key: value` line in a frontmatter block (surrounding
/// quotes stripped). Indented lines (nested under `metadata:` etc.) are skipped.
fn front_field(front: &str, key: &str) -> Option<String> {
    for line in front.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if k.trim() == key {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// The `type:` under the frontmatter's `metadata:` map (user / feedback /
/// project / reference). Matched anywhere indented — only metadata carries it.
fn front_type(front: &str) -> Option<String> {
    for line in front.lines() {
        if let Some(v) = line.trim().strip_prefix("type:") {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Codex memories
// ---------------------------------------------------------------------------

fn codex_memories(project_path: &str) -> Vec<MemoryEntry> {
    let mut entries = Vec::new();
    if let Some(home) = home() {
        entries.extend(codex_sqlite_memories(&home, project_path));
    }
    // Codex's durable per-project instructions, read on every run.
    let agents = Path::new(project_path).join("AGENTS.md");
    if let Some(text) = read_text(&agents) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            entries.push(MemoryEntry {
                id: agents.to_string_lossy().into_owned(),
                title: "AGENTS.md".to_string(),
                description: "Project instructions Codex loads each run".to_string(),
                kind: "AGENTS.md".to_string(),
                content: trimmed.to_string(),
            });
        }
    }
    entries
}

/// Newest `<stem>_<n>.sqlite` in `dir` (the store filenames carry a schema
/// version suffix that bumps over time — never hardcode the number).
fn latest_versioned(dir: &Path, stem: &str) -> Option<PathBuf> {
    let prefix = format!("{stem}_");
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n = name
                .strip_prefix(&prefix)?
                .strip_suffix(".sqlite")?
                .parse::<u64>()
                .ok()?;
            Some((n, e.path()))
        })
        .max_by_key(|(n, _)| *n)
        .map(|(_, p)| p)
}

fn codex_sqlite_memories(home: &Path, project_path: &str) -> Vec<MemoryEntry> {
    let codex = home.join(".codex");
    let (Some(mem_db), Some(state_db)) = (
        latest_versioned(&codex, "memories"),
        latest_versioned(&codex, "state"),
    ) else {
        return Vec::new();
    };

    // Read-only URIs keep the -wal tail visible (immutable=1 would drop it).
    // The state db (holding thread->cwd) is ATTACHed and joined by thread_id.
    // The project path goes in as a SQL string literal with '' quote escaping
    // — sqlite3's ad-hoc CLI has no argv parameter binding.
    let mem_uri = format!("file:{}?mode=ro", mem_db.to_string_lossy());
    let attach = format!(
        "ATTACH DATABASE 'file:{}?mode=ro' AS st",
        sql_escape(&state_db.to_string_lossy())
    );
    let query = format!(
        "SELECT s.thread_id AS id, \
                COALESCE(s.rollout_slug, '') AS slug, \
                s.rollout_summary AS summary, \
                s.raw_memory AS content \
         FROM stage1_outputs s \
         JOIN st.threads t ON t.id = s.thread_id \
         WHERE t.cwd = '{}' \
         ORDER BY s.generated_at DESC \
         LIMIT {CODEX_ROW_LIMIT}",
        sql_escape(project_path)
    );

    let out = match Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg("-json")
        .arg(&mem_uri)
        .arg("-cmd")
        .arg(&attach)
        .arg(&query)
        .output()
    {
        Ok(out) if out.status.success() => out.stdout,
        // Missing binary, unreadable store, or a schema drift that breaks the
        // query: degrade to no Codex sqlite memories rather than erroring the
        // whole popover.
        _ => return Vec::new(),
    };

    let text = String::from_utf8_lossy(&out);
    let text = text.trim();
    // -json prints nothing for an empty result set.
    if text.is_empty() {
        return Vec::new();
    }
    let rows: Vec<serde_json::Value> = match serde_json::from_str(text) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    rows.into_iter()
        .filter_map(|row| {
            let content = row.get("content").and_then(|v| v.as_str())?.trim();
            if content.is_empty() {
                return None;
            }
            let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let slug = row.get("slug").and_then(|v| v.as_str()).unwrap_or("").trim();
            let summary = row
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let title = if slug.is_empty() {
                first_line(summary).unwrap_or_else(|| "Memory".to_string())
            } else {
                slug.replace('-', " ")
            };
            Some(MemoryEntry {
                id: if id.is_empty() { title.clone() } else { id.to_string() },
                title,
                description: first_line(summary).unwrap_or_default(),
                kind: "Auto-memory".to_string(),
                content: content.to_string(),
            })
        })
        .collect()
}

/// Escape a value for embedding as a single-quoted SQL string literal.
fn sql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

fn first_line(s: &str) -> Option<String> {
    let line = s.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_split_and_fields() {
        let text = "---\nname: my-memory\ndescription: \"a note\"\nmetadata:\n  node_type: memory\n  type: feedback\n---\nThe body.\n";
        let (front, body) = split_frontmatter(text);
        assert_eq!(front_field(front, "name").as_deref(), Some("my-memory"));
        assert_eq!(front_field(front, "description").as_deref(), Some("a note"));
        // node_type must not be mistaken for type.
        assert_eq!(front_type(front).as_deref(), Some("feedback"));
        assert_eq!(body.trim(), "The body.");
    }

    #[test]
    fn no_frontmatter_is_all_body() {
        let text = "# Heading\n\nplain markdown";
        let (front, body) = split_frontmatter(text);
        assert_eq!(front, "");
        assert_eq!(body, text);
        assert_eq!(front_field(front, "name"), None);
    }

    #[test]
    fn sql_escape_doubles_quotes() {
        assert_eq!(sql_escape("a'b"), "a''b");
        assert_eq!(sql_escape("/Users/kevin"), "/Users/kevin");
    }
}
