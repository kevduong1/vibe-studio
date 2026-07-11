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
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
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
