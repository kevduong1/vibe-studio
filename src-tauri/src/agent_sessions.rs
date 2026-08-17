//! Narrow, read-only native-session discovery for terminal-launched agents.
//!
//! Codex does not expose its thread id to the parent terminal process. Its
//! supported local state database does, keyed by exact cwd and creation time.
//! We return only opaque ids and timestamps; callers must accept a candidate
//! only when the launch boundary makes it unambiguous. Titles, prompts,
//! previews, rollout paths, and transcript content never cross IPC.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionCandidate {
    id: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

fn latest_versioned(dir: &Path, stem: &str) -> Option<PathBuf> {
    let prefix = format!("{stem}_");
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name
                .strip_prefix(&prefix)?
                .strip_suffix(".sqlite")?
                .parse::<u64>()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

fn sql_escape(value: &str) -> String {
    value.replace('\'', "''")
}

fn branch_clause(branch: Option<&str>) -> String {
    branch
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" AND git_branch = '{}'", sql_escape(value)))
        .unwrap_or_default()
}

fn state_db() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
    latest_versioned(&PathBuf::from(home).join(".codex"), "state")
        .ok_or_else(|| "Codex state database was not found".to_string())
}

fn query_candidates(
    db: &Path,
    project_path: &str,
    branch: Option<&str>,
    created_after_ms: i64,
) -> Result<Vec<NativeSessionCandidate>, String> {
    let branch_clause = branch_clause(branch);
    let query = format!(
        "SELECT id, \
                COALESCE(created_at_ms, created_at * 1000) AS createdAtMs, \
                COALESCE(updated_at_ms, updated_at * 1000) AS updatedAtMs \
         FROM threads \
         WHERE cwd = '{}' AND archived = 0 \
           AND COALESCE(created_at_ms, created_at * 1000) >= {}{} \
         ORDER BY COALESCE(created_at_ms, created_at * 1000) DESC, id DESC \
         LIMIT 8",
        sql_escape(project_path),
        created_after_ms.max(0),
        branch_clause,
    );
    let uri = format!("file:{}?mode=ro", db.to_string_lossy());
    let output = Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg("-json")
        .arg(uri)
        .arg(query)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(text.trim()).map_err(|error| error.to_string())
}

fn session_exists(db: &Path, project_path: &str, id: &str) -> Result<bool, String> {
    let query = format!(
        "SELECT COUNT(*) FROM threads WHERE id = '{}' AND cwd = '{}' AND archived = 0",
        sql_escape(id),
        sql_escape(project_path),
    );
    let uri = format!("file:{}?mode=ro", db.to_string_lossy());
    let output = Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg(uri)
        .arg(query)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "1")
}

#[tauri::command]
pub async fn codex_native_session_candidates(
    project_path: String,
    branch: Option<String>,
    created_after_ms: i64,
) -> Result<Vec<NativeSessionCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        query_candidates(
            &state_db()?,
            &project_path,
            branch.as_deref(),
            created_after_ms,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn codex_native_session_exists(project_path: String, id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || session_exists(&state_db()?, &project_path, &id))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_values_are_escaped() {
        assert_eq!(sql_escape("/tmp/o'brien"), "/tmp/o''brien");
        assert_eq!(
            branch_clause(Some("talos/o'brien")),
            " AND git_branch = 'talos/o''brien'"
        );
    }

    #[test]
    fn parses_privacy_bounded_candidate_rows() {
        let rows: Vec<NativeSessionCandidate> =
            serde_json::from_str(r#"[{"id":"thread-1","createdAtMs":12,"updatedAtMs":34}]"#)
                .unwrap();
        assert_eq!(rows[0].id, "thread-1");
        assert_eq!(rows[0].created_at_ms, 12);
    }
}
