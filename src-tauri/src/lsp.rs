//! Language-server sessions over stdio — a thin JSON-RPC transport.
//!
//! Deliberately dumb, like pty.rs: spawn the server, parse Content-Length
//! frames off stdout, forward each message body verbatim to the webview as
//! `lsp-message:<id>`, and frame outgoing payloads from `lsp_send`. ALL
//! protocol logic (initialize handshake, document sync, request correlation)
//! lives in the frontend (`src/lib/lsp/`); Rust never parses message JSON —
//! tauri would just re-serialize it, so the single JSON.parse happens in TS.
//!
//! Locking mirrors pty.rs: the session map is only held for lookups, each
//! stdin has its own lock, and writes run on the blocking pool.
//!
//! No ack flow control (unlike the PTY): LSP output is demand-bounded —
//! responses only exist because we sent requests, and publishDiagnostics
//! only covers opened documents (pyright defaults to openFilesOnly; tsserver
//! diagnoses open files) — so a burst is dozens of messages, not a firehose,
//! and MAX_FRAME caps each one. If a workspace-wide-diagnostics mode ever
//! changes that, port the pty ack scheme.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager};

/// How long lsp_stop's SIGTERM gets to work before the process group is
/// SIGKILLed (pty.rs precedent).
const KILL_GRACE: Duration = Duration::from_millis(500);
/// A Content-Length beyond this means the stream is corrupt — it must not
/// trigger an unbounded allocation. 32 MiB comfortably exceeds any real
/// completion list or diagnostics batch.
const MAX_FRAME: usize = 32 << 20;
/// Cap on one header line in `read_frame` — real headers are tens of bytes.
/// Without it, a misconfigured binary dumping newline-free output to stdout
/// would grow the line buffer without bound (MAX_FRAME's anti-OOM job, but
/// before any Content-Length is even parsed).
const MAX_HEADER_LINE: u64 = 8 * 1024;
/// Keep only the stderr suffix for crash reporting.
const STDERR_TAIL_CAP: usize = 4096;
/// Sentinel bracketing `$PATH` in login-shell output — dotfiles freely print
/// to stdout under `zsh -l`, and zsh sources `~/.zlogout` AFTER the `-c`
/// command, so neither "stdout = PATH" nor "everything after one marker"
/// is reliable. The value sits between the LAST pair of markers.
const PATH_MARKER: &str = "__TALOS_PATH__";
/// How long the login-shell PATH probe may run before it is killed — a hung
/// dotfile must not park a blocking-pool thread (and the frontend's resolve
/// await) forever.
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);

pub struct LspSession {
    stdin: Arc<Mutex<ChildStdin>>,
    /// Server pid — doubles as its process-group id (spawned as group leader).
    pid: u32,
    /// Set by the reader thread once the child has been reaped.
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct LspState {
    sessions: Mutex<HashMap<String, LspSession>>,
    /// Login-shell `$PATH`, cached only when the marker probe succeeds
    /// (`refresh` busts it). Failed probes are NOT cached — pinning the
    /// degraded process-PATH fallback for the whole app run would make a
    /// transient dotfile hang permanent.
    login_path: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspResolveResult {
    /// Absolute path of the executable, or null when not found.
    path: Option<String>,
    /// "local" (workspace node_modules) | "path" (login-shell PATH).
    source: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspExit {
    code: Option<i32>,
    /// Last ~4 KiB of the server's stderr, for crash reporting in the UI.
    stderr_tail: String,
}

/// Run sync fs / process work on the blocking pool so it never stalls the
/// async runtime that also serves terminal IPC (git.rs precedent).
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// The user's real `$PATH` via their login shell. A Finder-launched app
/// inherits the bare system PATH (`/usr/bin:/bin:...`) — no nvm, no
/// homebrew — which is where the language servers (and node) actually live.
/// None on failure OR timeout; the caller falls back to the process PATH.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(shell)
        .args(["-lc", r#"printf '\n__TALOS_PATH__%s__TALOS_PATH__' "$PATH""#])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Read stdout on a helper thread: read_to_end only returns at EOF, and a
    // dotfile-spawned background process can inherit the pipe's write end and
    // hold it open past the shell's own exit — the deadline must bound the
    // read, not just the wait. (On that pathological setup the reader thread
    // is abandoned parked — one per resolve attempt, never accumulating in a
    // healthy environment.)
    let mut stdout_pipe = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut raw = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut raw);
        let _ = tx.send(raw);
    });
    // Poll instead of output(): output() has no timeout, and a hung dotfile
    // (network call, interactive prompt) would park this blocking-pool
    // thread forever with the frontend's resolve await pending alongside it.
    let deadline = Instant::now() + LOGIN_SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            // Timed out (or try_wait failed): kill and reap — no zombies.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // Whatever deadline remains bounds the read (floored so an exit landing
    // right at the deadline still collects the already-buffered output).
    let raw = rx
        .recv_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(100)),
        )
        .ok()?;
    let stdout = String::from_utf8_lossy(&raw);
    // Slice between the LAST pair of markers: zsh sources ~/.zlogout AFTER
    // the -c command, so logout chatter lands after `$PATH` in stdout — the
    // trailing marker is what keeps it out of the captured value.
    let close = stdout.rfind(PATH_MARKER)?;
    let open = stdout[..close].rfind(PATH_MARKER)?;
    let path = stdout[open + PATH_MARKER.len()..close].trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Locate a language-server binary: workspace-local candidates first (cheap
/// stats, never cached), then the cached login-shell PATH. Always warms the
/// PATH cache — lsp_start injects it into the child env even when a local
/// candidate wins, because the servers are `#!/usr/bin/env node` scripts
/// that need `node` resolvable at exec time.
#[tauri::command]
pub async fn lsp_resolve(
    app: tauri::AppHandle,
    bin: String,
    local_candidates: Vec<String>,
    refresh: bool,
) -> Result<LspResolveResult, String> {
    blocking(move || {
        let state = app.state::<LspState>();
        // Lock holds stay brief (lsp_start reads this cache from the async
        // runtime): check under the lock, run the shell WITHOUT it, store.
        // Racing first-resolves may both run the shell — rare and idempotent.
        let cached = if refresh { None } else { state.login_path.lock().clone() };
        let path_env = match cached {
            Some(p) => p,
            None => match login_shell_path() {
                Some(p) => {
                    *state.login_path.lock() = Some(p.clone());
                    p
                }
                // Probe failed or timed out: use the process PATH for THIS
                // resolve only and leave the cache empty so the next resolve
                // retries the shell — caching the bare Finder-launch PATH
                // would permanently pin the exact failure mode this resolver
                // exists to fix.
                None => std::env::var("PATH").unwrap_or_default(),
            },
        };
        for cand in &local_candidates {
            if is_executable(std::path::Path::new(cand)) {
                return Ok(LspResolveResult {
                    path: Some(cand.clone()),
                    source: Some("local".into()),
                });
            }
        }
        for dir in path_env.split(':').filter(|d| !d.is_empty()) {
            let p = std::path::Path::new(dir).join(&bin);
            if is_executable(&p) {
                return Ok(LspResolveResult {
                    path: Some(p.to_string_lossy().into_owned()),
                    source: Some("path".into()),
                });
            }
        }
        Ok(LspResolveResult { path: None, source: None })
    })
    .await
}

/// Spawn a language server. Returns the HOST app's pid — the frontend sends
/// it as initialize's `processId` so servers self-exit if this process dies
/// without running any teardown (crash, SIGKILL, force-quit).
#[tauri::command]
pub async fn lsp_start(
    app: tauri::AppHandle,
    id: String,
    cmd: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u32, String> {
    // spawn() and the mutex hops are sync work — run the body on the
    // blocking pool like every other command (lsp_resolve precedent).
    blocking(move || {
        let state = app.state::<LspState>();
        if state.sessions.lock().contains_key(&id) {
            // A duplicate id would orphan the existing server and let its
            // reader thread remove the new session from the map on exit.
            return Err(format!("lsp id already in use: {id}"));
        }

        let mut command = Command::new(&cmd);
        command
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(p) = state.login_path.lock().clone() {
            command.env("PATH", p);
        }
        // Group leader, like the pty's setsid: typescript-language-server
        // spawns tsserver as a separate node process that must die with the
        // group.
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn().map_err(|e| e.to_string())?;

        let pid = child.id();
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let exited = Arc::new(AtomicBool::new(false));

        // Register the session before the reader thread starts so an
        // immediate exit can't race the insertion.
        state.sessions.lock().insert(
            id.clone(),
            LspSession {
                stdin: Arc::new(Mutex::new(stdin)),
                pid,
                exited: exited.clone(),
            },
        );

        // Drain stderr (servers log noisily; an undrained pipe eventually
        // blocks the child) into a capped tail that rides on the exit event.
        // The tail stays raw bytes, decoded ONCE at exit — per-chunk lossy
        // decoding would tear multibyte sequences straddling read boundaries
        // into U+FFFD.
        let stderr_tail: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let tail = stderr_tail.clone();
        let stderr_thread = std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut buf = [0u8; 8192];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut t = tail.lock();
                        t.extend_from_slice(&buf[..n]);
                        if t.len() > STDERR_TAIL_CAP {
                            let mut cut = t.len() - STDERR_TAIL_CAP;
                            // Don't start the tail mid-character: skip past
                            // any UTF-8 continuation bytes at the cut.
                            while cut < t.len() && (t[cut] & 0xC0) == 0x80 {
                                cut += 1;
                            }
                            t.drain(..cut);
                        }
                    }
                }
            }
        });

        std::thread::spawn(move || {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            while let Some(body) = read_frame(&mut reader) {
                let _ = app.emit(&format!("lsp-message:{id}"), body);
            }
            // EOF or corrupt stream. The child usually exited already (EOF),
            // but if it is alive (corrupt frame / closed stdout while
            // running) the wait() below would hang — make sure the group is
            // dead first. The child is not yet reaped, so its pgid cannot
            // have been recycled.
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
            let _ = stderr_thread.join();
            let code = child.wait().ok().and_then(|status| status.code());
            exited.store(true, Ordering::Release);
            let tail = String::from_utf8_lossy(&stderr_tail.lock()).into_owned();
            let _ = app.emit(
                &format!("lsp-exit:{id}"),
                LspExit { code, stderr_tail: tail },
            );
            app.state::<LspState>().sessions.lock().remove(&id);
        });

        Ok(std::process::id())
    })
    .await
}

/// Read one Content-Length-framed JSON-RPC message body. None on EOF or a
/// corrupt stream (missing/unparseable/oversized length) — the caller treats
/// both as end-of-session.
fn read_frame(reader: &mut impl BufRead) -> Option<String> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        // Each header line reads through a fresh take() limiter so a binary
        // dumping newline-free output to stdout can't grow `line` without
        // bound. take() on by_ref() keeps the BufReader's buffered bytes
        // intact for subsequent reads.
        if reader.by_ref().take(MAX_HEADER_LINE).read_line(&mut line).ok()? == 0 {
            return None; // EOF
        }
        if line.len() as u64 >= MAX_HEADER_LINE && !line.ends_with('\n') {
            return None; // limit consumed without a newline — corrupt stream
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break; // blank line ends the headers
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            // Case-insensitive; Content-Type and unknown headers are ignored.
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().ok();
            }
        }
    }
    let len = content_length.filter(|&l| l <= MAX_FRAME)?;
    // Content-Length counts UTF-8 BYTES: read exactly that many, then decode.
    // Valid UTF-8 (the overwhelmingly common case, including multi-MB
    // completion responses) moves the buffer without copying; only an
    // invalid body pays for the lossy re-decode.
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).ok()?;
    Some(
        String::from_utf8(body)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()),
    )
}

/// `payload` is one complete JSON-RPC message; Rust owns the framing
/// (`payload.len()` is UTF-8 bytes — the TS side never computes lengths).
#[tauri::command]
pub async fn lsp_send(
    state: tauri::State<'_, LspState>,
    id: String,
    payload: String,
) -> Result<(), String> {
    // Clone the per-session stdin handle out of the map so the global lock
    // is released before the (potentially blocking) write.
    let stdin = {
        let sessions = state.sessions.lock();
        sessions.get(&id).ok_or("unknown lsp")?.stdin.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut w = stdin.lock();
        w.write_all(format!("Content-Length: {}\r\n\r\n", payload.len()).as_bytes())
            .map_err(|e| e.to_string())?;
        w.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tear a session down. SIGTERM (not SIGHUP — these aren't shells) to the
/// process group, escalating exactly like pty.rs: the pid can't be recycled
/// before the reader thread reaps the child, and `exited` only flips after
/// that. The frontend sends the protocol-level shutdown/exit dance BEFORE
/// calling lsp_stop; this is idempotent cleanup, not the polite path.
fn kill_lsp_session(session: LspSession) {
    unsafe { libc::kill(-(session.pid as i32), libc::SIGTERM) };
    let LspSession { pid, exited, stdin } = session;
    // Dropping our stdin clone gives well-behaved servers EOF as a second
    // exit cue (a concurrent lsp_send may briefly keep it alive — harmless).
    drop(stdin);
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(KILL_GRACE);
        if !exited.load(Ordering::Acquire) {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
    });
}

#[tauri::command]
pub async fn lsp_stop(state: tauri::State<'_, LspState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().remove(&id).ok_or("unknown lsp")?;
    kill_lsp_session(session);
    Ok(())
}

/// Kill every live server. Called when the webview (re)loads its page: a
/// reload loses the frontend client state (request maps, document versions),
/// so live servers are unreachable garbage — the service cold-starts fresh
/// ones on demand after the reload.
pub fn kill_all(state: &LspState) {
    let sessions: Vec<LspSession> = {
        let mut map = state.sessions.lock();
        map.drain().map(|(_, s)| s).collect()
    };
    for session in sessions {
        kill_lsp_session(session);
    }
}
