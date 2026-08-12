//! PTY sessions for the integrated terminal.
//!
//! Each terminal pane owns one `PtySession`, keyed by a frontend-generated id.
//! Output is streamed to the webview as base64 chunks on `pty-data:<id>`;
//! process exit is signalled on `pty-exit:<id>` with an `Option<i32>` code.
//!
//! Locking: the global session map is only ever held for map lookups —
//! never across a blocking PTY write — so one wedged terminal (full kernel
//! buffer, stopped reader) can never stall the other sessions or the IPC
//! runtime. Each writer has its own lock and writes run on the blocking pool.
//!
//! Flow control: webview event dispatch has no backpressure of its own, so a
//! chatty child (`yes`, a huge `cat`) could flood the main thread with more
//! base64 than xterm can parse and freeze the UI. The reader thread counts
//! emitted-but-unacknowledged bytes and parks above FLOW_HIGH_WATER; the
//! frontend acks via `pty_ack` from xterm's write-completion callback.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// Park the reader thread once this many emitted bytes are unacknowledged
/// (~1 MiB ≈ a few hundred ms of xterm parse work — snappy to recover, far
/// too small to freeze the UI).
const FLOW_HIGH_WATER: usize = 1 << 20;
/// How long pty_kill's SIGHUP gets to work before the process group is
/// SIGKILLed.
const KILL_GRACE: Duration = Duration::from_millis(500);

/// Consumption-side flow control shared by a session and its reader thread.
#[derive(Default)]
struct Flow {
    state: Mutex<FlowState>,
    cond: Condvar,
}

#[derive(Default)]
struct FlowState {
    /// Bytes emitted to the webview that the frontend hasn't parsed yet.
    unacked: usize,
    /// Session killed — unparks (and stops) a flow-parked reader.
    closed: bool,
}

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    flow: Arc<Flow>,
    /// Shell pid — doubles as its process-group id (spawned via setsid).
    pid: Option<u32>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// Bounded health/version probe for a binary already resolved through the
/// user's login-shell PATH. No shell is involved and no repository input is
/// passed as an argument.
#[tauri::command]
pub async fn executable_version(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let executable = std::path::Path::new(&path);
        if !executable.is_absolute() || !executable.is_file() {
            return Err("executable path must be an absolute file".to_string());
        }
        let mut child = Command::new(executable)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("version probe failed: {error}"))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                let output = child
                    .wait_with_output()
                    .map_err(|error| error.to_string())?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let text = if stdout.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                };
                if !output.status.success() {
                    return Err(if text.is_empty() {
                        format!("version probe exited with {}", output.status)
                    } else {
                        text.lines()
                            .next()
                            .unwrap_or("version probe failed")
                            .chars()
                            .take(240)
                            .collect()
                    });
                }
                return Ok(text
                    .lines()
                    .next()
                    .unwrap_or("Available")
                    .chars()
                    .take(240)
                    .collect());
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("version probe timed out".to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProcessTarget {
    terminal_id: String,
    executable_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessRow {
    pid: u32,
    parent_pid: u32,
    process_group: i32,
    executable: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProcessInfo {
    pid: u32,
    parent_pid: u32,
    /// Nearest matching agent ancestor, skipping non-agent helper processes.
    parent_agent_pid: Option<u32>,
    /// First matching agent below this PTY shell.
    root_agent_pid: u32,
    executable: String,
    foreground: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProcessSnapshot {
    terminal_id: String,
    processes: Vec<AgentProcessInfo>,
}

fn take_process_field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let trimmed = rest.trim_start();
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let field = &trimmed[..end];
    *rest = &trimmed[end..];
    (!field.is_empty()).then_some(field)
}

fn parse_process_table(text: &str) -> Vec<ProcessRow> {
    text.lines()
        .filter_map(|line| {
            let mut rest = line;
            let pid = take_process_field(&mut rest)?.parse().ok()?;
            let parent_pid = take_process_field(&mut rest)?.parse().ok()?;
            let process_group = take_process_field(&mut rest)?.parse().ok()?;
            // `ps ... comm=` is the final column and may itself contain
            // spaces. Preserve the remainder instead of treating its first
            // whitespace-delimited word as the executable.
            let executable = std::path::Path::new(rest.trim_start())
                .file_name()?
                .to_string_lossy()
                .to_string();
            Some(ProcessRow {
                pid,
                parent_pid,
                process_group,
                executable,
            })
        })
        .collect()
}

fn matching_descendants(
    rows: &[ProcessRow],
    shell_pid: u32,
    foreground_pgid: Option<i32>,
    names: &HashSet<&str>,
) -> Vec<AgentProcessInfo> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let by_pid: HashMap<u32, &ProcessRow> = rows.iter().map(|row| (row.pid, row)).collect();
    for row in rows {
        children.entry(row.parent_pid).or_default().push(row.pid);
    }
    let mut stack = vec![(shell_pid, None, None)];
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    while let Some((pid, parent_agent_pid, root_agent_pid)) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        let mut next_parent_agent_pid = parent_agent_pid;
        let mut next_root_agent_pid = root_agent_pid;
        if let Some(row) = by_pid.get(&pid) {
            if pid != shell_pid && names.contains(row.executable.as_str()) {
                let root = root_agent_pid.unwrap_or(pid);
                result.push(AgentProcessInfo {
                    pid: row.pid,
                    parent_pid: row.parent_pid,
                    parent_agent_pid,
                    root_agent_pid: root,
                    executable: row.executable.clone(),
                    foreground: foreground_pgid == Some(row.process_group),
                });
                next_parent_agent_pid = Some(pid);
                next_root_agent_pid = Some(root);
            }
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(
                kids.iter()
                    .map(|child| (*child, next_parent_agent_pid, next_root_agent_pid)),
            );
        }
    }
    result.sort_by_key(|process| (!process.foreground, process.pid));
    result
}

fn validate_process_command(success: bool, status: &str) -> Result<(), String> {
    if success {
        Ok(())
    } else {
        Err(format!("ps exited with {status}"))
    }
}

/// One aggregated, argument-free process snapshot for all requested PTYs.
/// A command failure is an error (the frontend degrades occupancy to unknown),
/// while a missing session has an empty result and is never confused with a
/// process-table failure.
#[tauri::command]
pub async fn pty_agent_process_snapshot(
    state: tauri::State<'_, PtyState>,
    targets: Vec<AgentProcessTarget>,
) -> Result<Vec<AgentProcessSnapshot>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, targets);
        return Err("agent process discovery is unsupported on this platform".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let sessions: HashMap<String, (u32, Option<i32>)> = {
            let sessions = state.sessions.lock();
            targets
                .iter()
                .filter_map(|target| {
                    let session = sessions.get(&target.terminal_id)?;
                    let pid = session.pid?;
                    let foreground = session.master.as_raw_fd().and_then(|fd| {
                        let pgid = unsafe { libc::tcgetpgrp(fd) };
                        (pgid > 0).then_some(pgid)
                    });
                    Some((target.terminal_id.clone(), (pid, foreground)))
                })
                .collect()
        };
        let output = tauri::async_runtime::spawn_blocking(|| {
            std::process::Command::new("ps")
                .args(["-axo", "pid=,ppid=,pgid=,comm="])
                .output()
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        validate_process_command(output.status.success(), &output.status.to_string())?;
        let rows = parse_process_table(&String::from_utf8_lossy(&output.stdout));
        Ok(targets
            .into_iter()
            .map(|target| {
                let processes = sessions
                    .get(&target.terminal_id)
                    .map(|(shell_pid, foreground)| {
                        let names = target.executable_names.iter().map(String::as_str).collect();
                        matching_descendants(&rows, *shell_pid, *foreground, &names)
                    })
                    .unwrap_or_default();
                AgentProcessSnapshot {
                    terminal_id: target.terminal_id,
                    processes,
                }
            })
            .collect())
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    agent: bool,
) -> Result<(), String> {
    if state.sessions.lock().contains_key(&id) {
        // A duplicate id would orphan the existing shell and let its reader
        // thread remove the new session from the map on exit.
        return Err(format!("pty id already in use: {id}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let launched_from_codex = std::env::var_os("CODEX_CI").is_some();
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // CommandBuilder inherits the app's environment, and in dev the app
    // itself may have been launched from a real terminal whose identity
    // would otherwise leak into every pane (LC_TERMINAL=iTerm2 alongside our
    // TERM_PROGRAM, live ITERM_SESSION_IDs, ...). Scrub the whole identity
    // family — a pane is not that terminal.
    for var in [
        // Coding-agent hosts commonly set NO_COLOR for their own captured
        // output. Letting that private parent setting leak into an integrated
        // terminal silently turns Claude/Codex (and every other CLI)
        // monochrome. The login shell may still set it again deliberately.
        "NO_COLOR",
        // A nested Codex must be a fresh interactive CLI, not inherit the
        // host agent's CI behavior or current conversation identity.
        "CODEX_CI",
        "CODEX_THREAD_ID",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TERM_SESSION_ID",
        "ITERM_SESSION_ID",
        "ITERM_PROFILE",
        "LC_TERMINAL",
        "LC_TERMINAL_VERSION",
        "GHOSTTY_RESOURCES_DIR",
        "GHOSTTY_BIN_DIR",
        "KITTY_WINDOW_ID",
        "KITTY_PID",
        "KITTY_PUBLIC_KEY",
        "KITTY_INSTALLATION_DIR",
        "WEZTERM_EXECUTABLE",
        "WEZTERM_CONFIG_FILE",
        "WEZTERM_CONFIG_DIR",
        "WEZTERM_PANE",
        "WEZTERM_UNIX_SOCKET",
    ] {
        cmd.env_remove(var);
    }
    if launched_from_codex {
        // Agent hosts force pagers to `cat` so captured command output cannot
        // block. An actual PTY is interactive, so restore normal pager
        // discovery; shell startup files remain free to choose another value.
        cmd.env_remove("PAGER");
        cmd.env_remove("GIT_PAGER");
    }
    if agent {
        // Masquerade as a notification-capable terminal: agent CLIs (Claude
        // Code & friends) only emit OSC 9 / OSC 777 notification sequences
        // when they recognize TERM_PROGRAM. The frontend
        // (lib/terminalActivity.ts) turns those into needs-attention
        // indicators on terminal and workspace tabs. Known cost:
        // TERM_PROGRAM-sniffing tools (chafa, yazi, ...) may assume Kitty
        // graphics support and emit images xterm.js silently drops — which is
        // why plain panes don't masquerade.
        cmd.env("TERM_PROGRAM", "ghostty");
        cmd.env("TERM_PROGRAM_VERSION", "1.2.0");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave fd is owned by the child now; close our copy.
    drop(pair.slave);

    let master = pair.master;
    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    let flow = Arc::new(Flow::default());

    // Register the session before the reader thread starts so an immediate
    // exit can't race the insertion.
    state.sessions.lock().insert(
        id.clone(),
        PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master,
            killer,
            flow: flow.clone(),
            pid,
        },
    );

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut child = child;
        let mut buf = [0u8; 32768];
        'read: loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // Count BEFORE emitting: an ack racing ahead of the
                    // increment would be clamped away by saturating_sub and
                    // leave phantom unacked bytes behind forever.
                    flow.state.lock().unacked += n;
                    let payload = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit(&format!("pty-data:{id}"), payload);
                    // Flow control: park until the frontend has parsed most
                    // of what we already sent (or the session is killed).
                    let mut st = flow.state.lock();
                    while st.unacked >= FLOW_HIGH_WATER {
                        if st.closed {
                            break 'read;
                        }
                        flow.cond.wait(&mut st);
                    }
                }
            }
        }
        // Reap the child (kill() alone leaves a zombie until wait()).
        let code: Option<i32> = child.wait().ok().map(|status| status.exit_code() as i32);
        let _ = app.emit(&format!("pty-exit:{id}"), code);
        app.state::<PtyState>().sessions.lock().remove(&id);
    });

    Ok(())
}

/// Frontend acknowledgement that `bytes` of output were parsed by xterm —
/// the reader thread's licence to keep streaming. Late acks for an exited
/// session return Err("unknown pty"); callers ignore it.
#[tauri::command]
pub async fn pty_ack(
    state: tauri::State<'_, PtyState>,
    id: String,
    bytes: usize,
) -> Result<(), String> {
    let flow = {
        let sessions = state.sessions.lock();
        sessions.get(&id).ok_or("unknown pty")?.flow.clone()
    };
    let mut st = flow.state.lock();
    st.unacked = st.unacked.saturating_sub(bytes);
    flow.cond.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Clone the per-session writer handle out of the map so the global lock
    // is released before the (potentially blocking) write.
    let writer = {
        let sessions = state.sessions.lock();
        sessions.get(&id).ok_or("unknown pty")?.writer.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut w = writer.lock();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions.get(&id).ok_or("unknown pty")?;
    // resize is a fast ioctl; holding the map lock here is fine.
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Process-group ids to SIGKILL when tearing a shell down: the shell's own
/// group plus the group of every descendant process. An interactive login
/// shell runs each job (`npm run dev`, a next/webpack dev server, ...) in its
/// OWN process group via job control, so signalling only the shell's group
/// (`-shell_pid`) leaves those jobs alive — and when the shell then dies they
/// reparent away and keep running after the app is gone. Snapshot the tree
/// NOW, while it is still rooted at the shell; once the shell exits its jobs
/// reparent and can no longer be found from its pid.
fn descendant_pgids(shell_pid: u32) -> Vec<i32> {
    // The shell is a setsid session leader, so its pid IS its group id —
    // always include it, even if the ps snapshot below fails.
    let mut pgids: Vec<i32> = vec![shell_pid as i32];

    // One ps snapshot of (pid, ppid, pgid) for every process on the system.
    let table: HashMap<u32, (u32, i32)> = match std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,pgid="])
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                let mut f = line.split_whitespace();
                let pid = f.next()?.parse::<u32>().ok()?;
                let ppid = f.next()?.parse::<u32>().ok()?;
                let pgid = f.next()?.parse::<i32>().ok()?;
                Some((pid, (ppid, pgid)))
            })
            .collect(),
        Err(_) => return pgids,
    };

    // Children index, then BFS the shell's descendants collecting their groups.
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &(ppid, _)) in &table {
        children.entry(ppid).or_default().push(pid);
    }
    let mut seen = HashSet::new();
    let mut stack = vec![shell_pid];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(&(_, pgid)) = table.get(&pid) {
            if !pgids.contains(&pgid) {
                pgids.push(pgid);
            }
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids);
        }
    }
    pgids
}

/// SIGKILL whole process groups. A `pgid <= 1` is never signalled: `kill(-0)`
/// hits the caller's own group and `kill(-1)` every process we can reach.
fn sigkill_pgids(pgids: &[i32]) {
    for &pgid in pgids {
        if pgid > 1 {
            // Negative target = the entire process group.
            unsafe { libc::kill(-pgid, libc::SIGKILL) };
        }
    }
}

/// Phase 1 of teardown: unpark the reader, snapshot the process groups to
/// sweep, then SIGHUP the shell. Returns the groups for the later SIGKILL.
fn hangup_and_collect_pgids(session: &mut PtySession) -> Vec<i32> {
    // Unpark a flow-parked reader so it can wind down and reap.
    {
        let mut st = session.flow.state.lock();
        st.closed = true;
        session.flow.cond.notify_all();
    }
    // Snapshot BEFORE signalling — a dying shell's jobs reparent out of reach.
    let pgids = session.pid.map(descendant_pgids).unwrap_or_default();
    // SIGHUP first — the shell runs zlogout, HUPs its own jobs, and closes the
    // slave fd so the reader hits EOF and reaps. portable-pty sends a single
    // SIGHUP with no escalation, and it never touches the separate groups the
    // shell's job-control children live in, so the SIGKILL sweep is what
    // actually guarantees nothing outlives the teardown.
    let _ = session.killer.kill();
    pgids
}

/// Tear a session down: SIGHUP now, SIGKILL its process groups after a grace
/// period. Deferred off-thread so a HUP-respecting child gets to exit cleanly
/// first; used for single-pane kills and page reloads — NOT app exit, where
/// the deferred task would never run (see `kill_all_blocking`).
fn kill_session(mut session: PtySession) {
    let pgids = hangup_and_collect_pgids(&mut session);
    drop(session); // close master/writer/killer fds
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(KILL_GRACE);
        sigkill_pgids(&pgids);
    });
}

/// Kill every live session. Called when the webview (re)loads its page: a
/// reload loses all frontend pane state, so the sessions are unreachable —
/// nothing will ever ack them again, and a flow-parked reader would
/// otherwise stay parked forever, freezing its child mid-write.
pub fn kill_all(state: &PtyState) {
    let sessions: Vec<PtySession> = {
        let mut map = state.sessions.lock();
        map.drain().map(|(_, s)| s).collect()
    };
    for session in sessions {
        kill_session(session);
    }
}

/// Synchronous teardown for app exit. SIGHUP every shell, wait one grace
/// period, then SIGKILL every collected process group — all inline. The
/// `RunEvent::Exit` callback returns straight into process teardown, so the
/// off-thread escalation `kill_session` relies on would never run: only the
/// SIGHUP (ineffective on job-control children) would land and dev servers
/// would survive. Blocking the exit for one grace period is the price of
/// guaranteeing nothing is orphaned.
pub fn kill_all_blocking(state: &PtyState) {
    let sessions: Vec<PtySession> = {
        let mut map = state.sessions.lock();
        map.drain().map(|(_, s)| s).collect()
    };
    let mut pgids: Vec<i32> = Vec::new();
    for mut session in sessions {
        pgids.extend(hangup_and_collect_pgids(&mut session));
        // session dropped here → master/writer/killer fds closed
    }
    if pgids.is_empty() {
        return;
    }
    std::thread::sleep(KILL_GRACE);
    sigkill_pgids(&pgids);
}

#[tauri::command]
pub async fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().remove(&id).ok_or("unknown pty")?;
    kill_session(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_process_table_and_keeps_only_basename() {
        let rows =
            parse_process_table(" 10 1 10 /bin/zsh\n 20 10 20 /opt/homebrew/bin/claude\ninvalid\n");
        assert_eq!(
            rows,
            vec![
                ProcessRow {
                    pid: 10,
                    parent_pid: 1,
                    process_group: 10,
                    executable: "zsh".into(),
                },
                ProcessRow {
                    pid: 20,
                    parent_pid: 10,
                    process_group: 20,
                    executable: "claude".into(),
                },
            ]
        );
    }

    #[test]
    fn preserves_spaces_in_the_process_command_column() {
        let rows = parse_process_table("20 10 20 /Applications/Agent Tools/claude helper\n");
        assert_eq!(
            rows,
            vec![ProcessRow {
                pid: 20,
                parent_pid: 10,
                process_group: 20,
                executable: "claude helper".into(),
            }]
        );
    }

    #[test]
    fn groups_descendants_and_marks_foreground_membership() {
        let rows = parse_process_table(
            "10 1 10 /bin/zsh\n20 10 20 /bin/node\n21 20 20 /usr/local/bin/claude\n30 1 30 /usr/local/bin/claude\n",
        );
        let names = HashSet::from(["claude"]);
        assert_eq!(
            matching_descendants(&rows, 10, Some(20), &names),
            vec![AgentProcessInfo {
                pid: 21,
                parent_pid: 20,
                parent_agent_pid: None,
                root_agent_pid: 21,
                executable: "claude".into(),
                foreground: true,
            }]
        );
    }

    #[test]
    fn distinguishes_agent_children_from_shell_siblings() {
        let rows = parse_process_table(
            "10 1 10 /bin/zsh\n20 10 20 /usr/local/bin/codex\n21 20 20 /bin/node\n22 21 20 /usr/local/bin/codex\n30 10 30 /usr/local/bin/codex\n",
        );
        let names = HashSet::from(["codex"]);
        let processes = matching_descendants(&rows, 10, Some(20), &names);
        assert_eq!(processes.len(), 3);
        assert_eq!(processes[0].pid, 20);
        assert_eq!(processes[0].parent_agent_pid, None);
        assert_eq!(processes[1].pid, 22);
        assert_eq!(processes[1].parent_agent_pid, Some(20));
        assert_eq!(processes[1].root_agent_pid, 20);
        assert_eq!(processes[2].pid, 30);
        assert_eq!(processes[2].parent_agent_pid, None);
        assert_eq!(processes[2].root_agent_pid, 30);
    }

    #[test]
    fn missing_session_root_has_no_false_matches() {
        let rows = parse_process_table("20 10 20 /usr/local/bin/codex\n");
        let names = HashSet::from(["codex"]);
        assert!(matching_descendants(&rows, 999, None, &names).is_empty());
    }

    #[test]
    fn command_failure_is_an_error_not_an_empty_snapshot() {
        assert!(validate_process_command(false, "exit status: 1").is_err());
        assert!(validate_process_command(true, "exit status: 0").is_ok());
    }
}
