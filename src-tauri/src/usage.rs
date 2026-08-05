//! Live Claude subscription usage — the 5-hour / weekly rate-limit windows
//! shown on claude.ai/settings/usage and by Claude Code's own `/usage`
//! command.
//!
//! We READ the OAuth access token Claude Code already minted (its login is the
//! user's — we add no new authorization) from `~/.claude/.credentials.json` or
//! the "Claude Code-credentials" keychain item, and call the same
//! `api.anthropic.com/api/oauth/usage` endpoint with it. Deliberately
//! READ-ONLY: we never refresh or rewrite that token, so we can never desync
//! Claude Code's login (an OAuth refresh can rotate the refresh token). When
//! the access token has expired we report `Expired` and wait for Claude Code
//! itself to refresh it on next use — in this app, whose agent terminals run
//! `claude`, that happens constantly.
//!
//! No new deps, matching the shell-out posture of git.rs / notify.rs: the
//! token comes from a file read or `security`, and the one HTTPS GET shells
//! out to `curl`. The Bearer token is passed via curl's stdin config (`-K -`)
//! so it never lands in a process argv another local process could `ps`.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Beta header the OAuth usage endpoint requires (mirrors Claude Code's web
/// client; see Usage4Claude's ClaudeOAuthConfig).
const BETA_HEADER: &str = "oauth-2025-04-20";
/// Treat the token as expired this many ms before its stated expiry so we
/// never fire a request that 401s in the gap.
const EXPIRY_SKEW_MS: i64 = 30_000;
/// Bound the experimental Codex app-server exchange so a wedged CLI cannot
/// permanently consume a blocking-runtime thread and leave frontend polling
/// stuck in its in-flight state.
const CODEX_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    /// 0–100, may be fractional.
    utilization: f64,
    /// ISO-8601 reset instant, or null when this window hasn't started.
    resets_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageLimit {
    /// Server-supplied model-bucket label (for example, "Fable").
    display_name: String,
    /// 0–100, may be fractional.
    utilization: f64,
    /// ISO-8601 reset instant.
    resets_at: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    five_hour: Option<UsageLimit>,
    seven_day: Option<UsageLimit>,
    seven_day_opus: Option<UsageLimit>,
    seven_day_sonnet: Option<UsageLimit>,
    /// Newer usage responses put model-specific weekly buckets such as Fable
    /// in the generic `limits` array instead of adding another top-level key.
    model_scoped: Vec<ModelUsageLimit>,
}

/// Discriminated result the status-bar chip renders directly.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UsageState {
    /// Live gauges fetched.
    Ok { usage: ClaudeUsage },
    /// No Claude Code login found on this machine.
    Unauthenticated,
    /// Claude Code's access token has lapsed; it refreshes on next use.
    Expired,
    /// Anything else (network, unexpected HTTP, parse) — message for the UI.
    Error { message: String },
}

#[tauri::command]
pub async fn claude_usage() -> Result<UsageState, String> {
    tauri::async_runtime::spawn_blocking(usage_impl)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageLimit {
    utilization: f64,
    /// Unix seconds, as returned by the Codex app-server protocol.
    resets_at: Option<i64>,
    window_minutes: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    five_hour: Option<CodexUsageLimit>,
    seven_day: Option<CodexUsageLimit>,
    plan_type: Option<String>,
    /// Expiry instants (unix seconds, ascending) of banked "available"
    /// rate-limit reset credits — grants that fully reset both windows.
    reset_credit_expiries: Vec<i64>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CodexUsageState {
    Ok { usage: CodexUsage },
    Unauthenticated,
    Error { message: String },
}

/// Ask the installed Codex CLI for its current account rate limits. The CLI's
/// app-server owns credential lookup and refresh; minimal-ide never reads or
/// forwards the tokens itself.
#[tauri::command]
pub async fn codex_usage() -> Result<CodexUsageState, String> {
    tauri::async_runtime::spawn_blocking(codex_usage_impl)
        .await
        .map_err(|e| e.to_string())
}

fn codex_usage_impl() -> CodexUsageState {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut child = match Command::new(shell)
        .args(["-lc", "codex app-server --stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return CodexUsageState::Error {
                message: format!("could not start Codex: {e}"),
            }
        }
    };

    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return CodexUsageState::Error {
                message: "could not query Codex: stdin unavailable".to_string(),
            };
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return CodexUsageState::Error {
                message: "could not query Codex: stdout unavailable".to_string(),
            };
        }
    };
    let (line_tx, line_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + CODEX_TIMEOUT;
    let initialize =
        "{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"minimal-ide\",\"version\":\"0.1.0\"}}}\n";
    if let Err(e) = stdin
        .write_all(initialize.as_bytes())
        .and_then(|_| stdin.flush())
    {
        let _ = child.kill();
        let _ = child.wait();
        return CodexUsageState::Error {
            message: format!("could not query Codex: {e}"),
        };
    }

    // app-server gates all requests until initialization completes. It does
    // not queue an `initialized` notification sent in the same stdin burst,
    // so wait for response 1 before advancing the handshake.
    if let Err(message) = read_codex_response(&line_rx, 1, deadline) {
        let _ = child.kill();
        let _ = child.wait();
        return CodexUsageState::Error { message };
    }

    let request = concat!(
        "{\"method\":\"initialized\"}\n",
        "{\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":null}\n"
    );
    if let Err(e) = stdin
        .write_all(request.as_bytes())
        .and_then(|_| stdin.flush())
    {
        let _ = child.kill();
        let _ = child.wait();
        return CodexUsageState::Error {
            message: format!("could not query Codex: {e}"),
        };
    }

    let response = match read_codex_response(&line_rx, 2, deadline) {
        Ok(response) => response,
        Err(message) => {
            let _ = child.kill();
            let _ = child.wait();
            return CodexUsageState::Error { message };
        }
    };
    drop(stdin);
    // We have the only response this short-lived server exists to provide.
    // Reap it explicitly rather than relying on stdin EOF timing (dropping a
    // std::process::Child does not wait and can leave a zombie).
    let _ = child.kill();
    let _ = child.wait();

    if let Some(error) = response.get("error") {
        let detail = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Codex is not signed in");
        return if detail.to_ascii_lowercase().contains("login")
            || detail.to_ascii_lowercase().contains("auth")
        {
            CodexUsageState::Unauthenticated
        } else {
            CodexUsageState::Error {
                message: detail.to_string(),
            }
        };
    }
    if let Some(snapshot) = response.get("result").and_then(|r| r.get("rateLimits")) {
        let (five_hour, seven_day) = parse_codex_windows(snapshot);
        let usage = CodexUsage {
            five_hour,
            seven_day,
            plan_type: snapshot
                .get("planType")
                .and_then(|p| p.as_str())
                .map(str::to_string),
            reset_credit_expiries: parse_codex_reset_credits(response.get("result")),
        };
        if usage.five_hour.is_none() && usage.seven_day.is_none() {
            return CodexUsageState::Error {
                message: "Codex returned no usage windows".to_string(),
            };
        }
        return CodexUsageState::Ok { usage };
    }

    let _ = child.wait();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    let detail = stderr.trim();
    if detail.contains("not found") || detail.contains("command not found") {
        CodexUsageState::Error {
            message: "Codex CLI not found".to_string(),
        }
    } else {
        CodexUsageState::Error {
            message: if detail.is_empty() {
                "Unexpected response from Codex".to_string()
            } else {
                format!("Codex usage error{}", short_detail(detail))
            },
        }
    }
}

/// Receive JSON-lines until the requested response id arrives, ignoring
/// notifications and unrelated responses. The shared deadline bounds the
/// entire initialize + request exchange rather than granting each phase a
/// fresh timeout.
fn read_codex_response(
    lines: &mpsc::Receiver<std::io::Result<String>>,
    id: i64,
    deadline: Instant,
) -> Result<serde_json::Value, String> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "Codex usage request timed out".to_string())?;
        let line = lines.recv_timeout(remaining).map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => "Codex usage request timed out".to_string(),
            mpsc::RecvTimeoutError::Disconnected => {
                "Codex app-server closed unexpectedly".to_string()
            }
        })?;
        let line = line.map_err(|e| format!("could not read Codex response: {e}"))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(|v| v.as_i64()) == Some(id) {
            return Ok(value);
        }
    }
}

/// Extract the expiry instants of still-available reset credits from the
/// `rateLimitResetCredits` sibling of `rateLimits` (absent on older CLIs).
fn parse_codex_reset_credits(result: Option<&serde_json::Value>) -> Vec<i64> {
    let mut expiries: Vec<i64> = result
        .and_then(|r| r.get("rateLimitResetCredits"))
        .and_then(|c| c.get("credits"))
        .and_then(|c| c.as_array())
        .map(|credits| {
            credits
                .iter()
                .filter(|c| c.get("status").and_then(|s| s.as_str()) == Some("available"))
                .filter_map(|c| c.get("expiresAt").and_then(|e| e.as_i64()))
                .collect()
        })
        .unwrap_or_default();
    expiries.sort_unstable();
    expiries
}

fn parse_codex_limit(v: Option<&serde_json::Value>) -> Option<CodexUsageLimit> {
    let v = v?;
    if v.is_null() {
        return None;
    }
    Some(CodexUsageLimit {
        utilization: v.get("usedPercent")?.as_f64()?,
        resets_at: v.get("resetsAt").and_then(|r| r.as_i64()),
        window_minutes: v.get("windowDurationMins").and_then(|w| w.as_i64()),
    })
}

/// Codex historically returned 5-hour as `primary` and weekly as `secondary`.
/// The service may omit the 5-hour window and move weekly into `primary`, so
/// use the reported duration when present and retain the old positions only
/// as a compatibility fallback for responses without `windowDurationMins`.
fn parse_codex_windows(
    snapshot: &serde_json::Value,
) -> (Option<CodexUsageLimit>, Option<CodexUsageLimit>) {
    const FIVE_HOUR_MINS: i64 = 5 * 60;
    const SEVEN_DAY_MINS: i64 = 7 * 24 * 60;

    let mut five_hour = None;
    let mut seven_day = None;
    for (position, limit) in [
        parse_codex_limit(snapshot.get("primary")),
        parse_codex_limit(snapshot.get("secondary")),
    ]
    .into_iter()
    .enumerate()
    {
        let Some(limit) = limit else { continue };
        match limit.window_minutes {
            Some(FIVE_HOUR_MINS) if five_hour.is_none() => five_hour = Some(limit),
            Some(SEVEN_DAY_MINS) if seven_day.is_none() => seven_day = Some(limit),
            // Old app-server responses did not report a duration.
            None if position == 0 && five_hour.is_none() => five_hour = Some(limit),
            None if position == 1 && seven_day.is_none() => seven_day = Some(limit),
            _ => {}
        }
    }
    (five_hour, seven_day)
}

fn usage_impl() -> UsageState {
    let (token, expires_at) = match read_credentials() {
        Some(c) => c,
        None => return UsageState::Unauthenticated,
    };

    // Skip a doomed request when the token is already (about to be) expired.
    if let Some(exp) = expires_at {
        if now_ms() >= exp - EXPIRY_SKEW_MS {
            return UsageState::Expired;
        }
    }

    match http_get_usage(&token) {
        Ok((200, body)) => match parse_usage(&body) {
            Some(usage) => UsageState::Ok { usage },
            None => UsageState::Error {
                message: format!("Unexpected usage response{}", short_detail(&body)),
            },
        },
        // Token rejected — same remedy as a local-expiry miss.
        Ok((401, _)) => UsageState::Expired,
        Ok((code, body)) => UsageState::Error {
            message: format!("Usage request failed (HTTP {code}){}", short_detail(&body)),
        },
        Err(e) => UsageState::Error { message: e },
    }
}

/// (accessToken, expiresAt-ms) from Claude Code's credential store, file
/// before keychain (the file read can't prompt).
fn read_credentials() -> Option<(String, Option<i64>)> {
    let raw = read_credentials_file().or_else(read_credentials_keychain)?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let oauth = v.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str()?.trim().to_string();
    if token.is_empty() {
        return None;
    }
    // expiresAt is epoch-ms; tolerate it arriving as integer or float.
    let expires_at = oauth
        .get("expiresAt")
        .and_then(|e| e.as_i64().or_else(|| e.as_f64().map(|f| f as i64)));
    Some((token, expires_at))
}

fn read_credentials_file() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join(".claude/.credentials.json");
    std::fs::read_to_string(path).ok()
}

fn read_credentials_keychain() -> Option<String> {
    // The item is ACL'd to Claude Code, so the first read prompts for keychain
    // access (the user can choose "Always Allow"). -w prints the raw secret.
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// GET the usage endpoint. Returns (http_status, body). Errors are reserved
/// for "couldn't even reach the server".
fn http_get_usage(token: &str) -> Result<(u16, String), String> {
    // Everything (incl. the Bearer token) goes through curl's stdin config so
    // it never appears in this process's argv. write-out appends the status
    // code on its own line after the body.
    let config = format!(
        "url = \"{USAGE_URL}\"\n\
         header = \"Authorization: Bearer {token}\"\n\
         header = \"anthropic-beta: {BETA_HEADER}\"\n\
         silent\n\
         show-error\n\
         max-time = 15\n\
         write-out = \"\\n%{{http_code}}\"\n"
    );

    let mut child = Command::new("curl")
        .arg("-K")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run curl: {e}"))?;

    child
        .stdin
        .take()
        .ok_or("curl stdin unavailable")?
        .write_all(config.as_bytes())
        .map_err(|e| e.to_string())?;

    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (body, code) = match stdout.rsplit_once('\n') {
        Some((b, c)) => (b.to_string(), c.trim().parse::<u16>().unwrap_or(0)),
        None => (String::new(), stdout.trim().parse::<u16>().unwrap_or(0)),
    };
    // code 0 = curl never got an HTTP response (DNS/connect/TLS/timeout).
    if code == 0 {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "could not reach Anthropic".to_string()
        } else {
            format!("network error: {err}")
        });
    }
    Ok((code, body))
}

fn parse_usage(body: &str) -> Option<ClaudeUsage> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let usage = ClaudeUsage {
        five_hour: parse_limit(v.get("five_hour")),
        seven_day: parse_limit(v.get("seven_day")),
        seven_day_opus: parse_limit(v.get("seven_day_opus")),
        seven_day_sonnet: parse_limit(v.get("seven_day_sonnet")),
        model_scoped: parse_model_scoped_limits(v.get("limits")),
    };
    // A well-formed-but-unrecognized body (e.g. an error envelope) parses as
    // JSON yet yields no windows — surface it as an error instead of a blank.
    if usage.five_hour.is_none()
        && usage.seven_day.is_none()
        && usage.seven_day_opus.is_none()
        && usage.seven_day_sonnet.is_none()
        && usage.model_scoped.is_empty()
    {
        return None;
    }
    Some(usage)
}

fn parse_model_scoped_limits(v: Option<&serde_json::Value>) -> Vec<ModelUsageLimit> {
    v.and_then(|limits| limits.as_array())
        .map(|limits| {
            limits
                .iter()
                .filter(|limit| {
                    limit.get("kind").and_then(|kind| kind.as_str()) == Some("weekly_scoped")
                })
                .filter_map(|limit| {
                    let display_name = limit
                        .get("scope")?
                        .get("model")?
                        .get("display_name")?
                        .as_str()?
                        .trim();
                    if display_name.is_empty() {
                        return None;
                    }
                    Some(ModelUsageLimit {
                        display_name: display_name.to_string(),
                        utilization: limit.get("percent")?.as_f64()?,
                        resets_at: limit
                            .get("resets_at")
                            .and_then(|reset| reset.as_str())
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_limit(v: Option<&serde_json::Value>) -> Option<UsageLimit> {
    let v = v?;
    if v.is_null() {
        return None;
    }
    let utilization = v.get("utilization")?.as_f64()?;
    let resets_at = v
        .get("resets_at")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string());
    Some(UsageLimit {
        utilization,
        resets_at,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A short, single-line snippet of a response body for error messages.
fn short_detail(body: &str) -> String {
    let t = body.trim();
    if t.is_empty() {
        return String::new();
    }
    let snippet: String = t.chars().take(160).collect();
    format!(": {}", snippet.replace('\n', " "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_usage_parses_model_scoped_weekly_limits() {
        let usage = parse_usage(
            r#"{
                "five_hour": {"utilization": 3, "resets_at": "2026-07-20T18:00:00Z"},
                "seven_day": {"utilization": 0, "resets_at": "2026-07-25T06:00:00Z"},
                "limits": [
                    {
                        "kind": "weekly_scoped",
                        "group": "model",
                        "percent": 1.25,
                        "resets_at": "2026-07-25T06:00:00Z",
                        "scope": {"model": {"display_name": "Fable"}}
                    },
                    {
                        "kind": "weekly_scoped",
                        "percent": 9,
                        "scope": {"surface": {"display_name": "Claude Code"}}
                    }
                ]
            }"#,
        )
        .expect("recognized usage response");

        assert_eq!(usage.model_scoped.len(), 1);
        assert_eq!(usage.model_scoped[0].display_name, "Fable");
        assert_eq!(usage.model_scoped[0].utilization, 1.25);
        assert_eq!(
            usage.model_scoped[0].resets_at.as_deref(),
            Some("2026-07-25T06:00:00Z")
        );
    }

    #[test]
    fn codex_windows_are_classified_by_duration() {
        let snapshot = serde_json::json!({
            "primary": {
                "usedPercent": 23,
                "windowDurationMins": 10080,
                "resetsAt": 1785163733
            },
            "secondary": null
        });

        let (five_hour, seven_day) = parse_codex_windows(&snapshot);
        assert!(five_hour.is_none());
        assert_eq!(seven_day.expect("weekly window").utilization, 23.0);
    }

    #[test]
    fn codex_windows_keep_legacy_positional_fallback() {
        let snapshot = serde_json::json!({
            "primary": {"usedPercent": 4},
            "secondary": {"usedPercent": 12}
        });

        let (five_hour, seven_day) = parse_codex_windows(&snapshot);
        assert_eq!(five_hour.expect("five-hour window").utilization, 4.0);
        assert_eq!(seven_day.expect("weekly window").utilization, 12.0);
    }

    #[test]
    fn codex_response_reader_ignores_notifications_and_other_ids() {
        let (tx, rx) = mpsc::channel();
        tx.send(Ok(r#"{"method":"account/rateLimits/updated"}"#.to_string()))
            .unwrap();
        tx.send(Ok(r#"{"id":1,"result":{}}"#.to_string())).unwrap();
        tx.send(Ok(
            r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":7}}}}"#.to_string(),
        ))
        .unwrap();

        let response = read_codex_response(&rx, 2, Instant::now() + Duration::from_secs(1))
            .expect("response 2");
        assert_eq!(
            response["result"]["rateLimits"]["primary"]["usedPercent"],
            7
        );
    }

    #[test]
    fn codex_response_reader_times_out() {
        let (_tx, rx) = mpsc::channel::<std::io::Result<String>>();
        let error = read_codex_response(&rx, 2, Instant::now())
            .expect_err("an expired deadline should time out");
        assert_eq!(error, "Codex usage request timed out");
    }
}
