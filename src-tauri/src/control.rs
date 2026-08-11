//! Authenticated local agent control plane.
//!
//! A per-user Unix socket exposes privacy-bounded semantic snapshots and
//! frontend-routed start/prompt/focus actions. The bearer token and socket are
//! mode 0600 in the app data directory. Repository processes never receive the
//! global token; short-lived capabilities can restrict callers to one project.

use base64::Engine;
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const EVENT_LIMIT: usize = 1024;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlSnapshot {
    terminal_id: String,
    workspace_path: String,
    scope: String,
    kind: String,
    occupancy: String,
    occupant_pid: Option<u32>,
    generation: u64,
    lifecycle: String,
    seen: bool,
    changed_at: u64,
    authority: Option<String>,
    reason: Option<String>,
    matched_rule: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlEvent {
    seq: u64,
    kind: &'static str,
    terminal_id: String,
    agent: Option<AgentControlSnapshot>,
}

#[derive(Debug, Clone)]
struct Capability {
    project_path: String,
    expires_at_ms: u64,
}

#[derive(Default)]
struct Data {
    seq: u64,
    agents: HashMap<String, AgentControlSnapshot>,
    events: VecDeque<ControlEvent>,
    capabilities: HashMap<String, Capability>,
    frontend_responses: HashMap<String, Option<Result<Value, String>>>,
    active_request_projects: HashMap<String, String>,
    cancelled: HashSet<String>,
}

struct Inner {
    data: Mutex<Data>,
    changed: Condvar,
    running: AtomicBool,
    global_token: Mutex<String>,
    socket_path: Mutex<Option<PathBuf>>,
    token_path: Mutex<Option<PathBuf>>,
    app: Mutex<Option<AppHandle>>,
}

#[derive(Clone)]
pub struct ControlState {
    inner: Arc<Inner>,
}

impl Default for ControlState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                data: Mutex::new(Data::default()),
                changed: Condvar::new(),
                running: AtomicBool::new(false),
                global_token: Mutex::new(String::new()),
                socket_path: Mutex::new(None),
                token_path: Mutex::new(None),
                app: Mutex::new(None),
            }),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiRequest {
    token: String,
    command: String,
    request_id: Option<String>,
    terminal_id: Option<String>,
    generation: Option<u64>,
    text: Option<String>,
    mode: Option<String>,
    workspace_path: Option<String>,
    kind: Option<String>,
    task_name: Option<String>,
    isolated: Option<bool>,
    wait: Option<bool>,
    desired: Option<Vec<String>>,
    timeout_ms: Option<u64>,
    after_seq: Option<u64>,
    ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendControlRequest {
    request_id: String,
    action: String,
    terminal_id: Option<String>,
    generation: Option<u64>,
    text: Option<String>,
    mode: Option<String>,
    workspace_path: Option<String>,
    kind: Option<String>,
    task_name: Option<String>,
    isolated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlInfo {
    socket_path: String,
    token_path: String,
    cli_path: String,
    skill_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedCapability {
    token: String,
    project_path: String,
    expires_at_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|error| error.to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn write_private(path: &Path, value: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    file.write_all(value.as_bytes())
        .map_err(|error| error.to_string())
}

fn push_event(
    data: &mut Data,
    kind: &'static str,
    terminal_id: String,
    agent: Option<AgentControlSnapshot>,
) {
    data.seq += 1;
    let seq = data.seq;
    data.events.push_back(ControlEvent {
        seq,
        kind,
        terminal_id,
        agent,
    });
    while data.events.len() > EVENT_LIMIT {
        data.events.pop_front();
    }
}

pub fn start(app: &AppHandle, state: &ControlState) -> Result<(), String> {
    if state
        .inner
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }
    let prepared = (|| {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        let socket_path = dir.join("agent-control.sock");
        let token_path = dir.join("agent-control.token");
        let _ = std::fs::remove_file(&socket_path);
        let token = random_token()?;
        write_private(&token_path, &token)?;
        let listener = UnixListener::bind(&socket_path).map_err(|error| error.to_string())?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        Ok::<_, String>((listener, socket_path, token_path, token))
    })();
    let (listener, socket_path, token_path, token) = match prepared {
        Ok(value) => value,
        Err(error) => {
            state.inner.running.store(false, Ordering::SeqCst);
            if let Ok(dir) = app.path().app_local_data_dir() {
                let _ = std::fs::remove_file(dir.join("agent-control.sock"));
                let _ = std::fs::remove_file(dir.join("agent-control.token"));
            }
            return Err(error);
        }
    };
    *state.inner.global_token.lock() = token;
    *state.inner.socket_path.lock() = Some(socket_path.clone());
    *state.inner.token_path.lock() = Some(token_path.clone());
    *state.inner.app.lock() = Some(app.clone());
    let inner = state.inner.clone();
    std::thread::spawn(move || {
        while inner.running.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let connection = inner.clone();
                    std::thread::spawn(move || handle_connection(stream, connection));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_file(&token_path);
        *inner.global_token.lock() = String::new();
        *inner.socket_path.lock() = None;
        *inner.token_path.lock() = None;
        inner.running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

pub fn stop(state: &ControlState) {
    state.inner.running.store(false, Ordering::SeqCst);
    state.inner.changed.notify_all();
    if let Some(path) = state.inner.socket_path.lock().as_ref() {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = state.inner.token_path.lock().as_ref() {
        let _ = std::fs::remove_file(path);
    }
}

fn capability_for(inner: &Inner, token: &str) -> Result<Option<String>, String> {
    if token == *inner.global_token.lock() {
        return Ok(None);
    }
    let mut data = inner.data.lock();
    data.capabilities
        .retain(|_, capability| capability.expires_at_ms > now_ms());
    data.capabilities
        .get(token)
        .map(|capability| Some(capability.project_path.clone()))
        .ok_or_else(|| "unauthorized".to_string())
}

fn request_project(data: &Data, request: &ApiRequest) -> Result<Option<String>, String> {
    if let Some(terminal_id) = request.terminal_id.as_ref() {
        let project = data
            .agents
            .get(terminal_id)
            .map(|agent| agent.workspace_path.clone())
            .ok_or_else(|| "terminal not found".to_string())?;
        if request
            .workspace_path
            .as_ref()
            .is_some_and(|requested| requested != &project)
        {
            return Err("workspacePath does not match the terminal project".to_string());
        }
        return Ok(Some(project));
    }
    Ok(request.workspace_path.clone())
}

fn authorize_project(scope: Option<&str>, project: Option<&str>) -> Result<(), String> {
    match (scope, project) {
        (Some(scope), Some(project)) if scope == project => Ok(()),
        (Some(_), _) => Err("capability is not valid for this project".to_string()),
        (None, _) => Ok(()),
    }
}

fn handle_connection(mut stream: UnixStream, inner: Arc<Inner>) {
    if stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .is_err()
    {
        return;
    }
    let cloned = match stream.try_clone() {
        Ok(value) => value,
        Err(_) => return,
    };
    let mut line = String::new();
    let read = BufReader::new(cloned)
        .take(MAX_REQUEST_BYTES)
        .read_line(&mut line);
    let response = match read {
        Ok(0) => Err("empty request".to_string()),
        Ok(_) => serde_json::from_str::<ApiRequest>(&line)
            .map_err(|error| error.to_string())
            .and_then(|request| handle_request(&inner, request)),
        Err(error) => Err(error.to_string()),
    };
    let body = match response {
        Ok(value) => json!({ "ok": true, "result": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    let _ = writeln!(stream, "{body}");
}

fn filtered_agents(data: &Data, scope: Option<&str>) -> Vec<AgentControlSnapshot> {
    let mut agents: Vec<_> = data
        .agents
        .values()
        .filter(|agent| {
            scope
                .map(|path| path == agent.workspace_path)
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    agents.sort_by(|a, b| {
        a.workspace_path
            .cmp(&b.workspace_path)
            .then(a.terminal_id.cmp(&b.terminal_id))
    });
    agents
}

fn validate_request(request: &ApiRequest) -> Result<(), String> {
    match request.command.as_str() {
        "focus" => {
            if request.terminal_id.is_none() {
                return Err("terminalId is required".to_string());
            }
        }
        "prompt" => {
            if request.terminal_id.is_none() {
                return Err("terminalId is required".to_string());
            }
            if !request
                .text
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
            {
                return Err("text is required".to_string());
            }
            if !matches!(
                request.mode.as_deref(),
                None | Some("queue") | Some("steer")
            ) {
                return Err("mode must be queue or steer".to_string());
            }
        }
        "start" => {
            if request.workspace_path.is_none() {
                return Err("workspacePath is required".to_string());
            }
            if !matches!(
                request.kind.as_deref(),
                None | Some("claude") | Some("codex")
            ) {
                return Err("kind must be claude or codex".to_string());
            }
        }
        "wait" => {
            if request.terminal_id.is_none() {
                return Err("terminalId is required".to_string());
            }
            if request.desired.as_ref().is_some_and(|states| {
                states.is_empty()
                    || states.iter().any(|state| {
                        !matches!(
                            state.as_str(),
                            "present" | "working" | "idle" | "blocked" | "absent" | "unknown"
                        )
                    })
            }) {
                return Err("desired contains an unknown semantic state".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

fn handle_request(inner: &Arc<Inner>, request: ApiRequest) -> Result<Value, String> {
    let scope = capability_for(inner, &request.token)?;
    if request.command == "cancel" {
        let id = request
            .request_id
            .ok_or_else(|| "requestId is required".to_string())?;
        let mut data = inner.data.lock();
        let project = data
            .active_request_projects
            .get(&id)
            .ok_or_else(|| "active request not found".to_string())?;
        authorize_project(scope.as_deref(), Some(project))?;
        data.cancelled.insert(id.clone());
        let frontend_pending = data.frontend_responses.contains_key(&id);
        drop(data);
        inner.changed.notify_all();
        if frontend_pending {
            emit_frontend_cancel(inner, &id);
        }
        return Ok(json!({ "requestId": id, "cancelled": true }));
    }
    validate_request(&request)?;
    let project = request_project(&inner.data.lock(), &request)?;
    if !matches!(request.command.as_str(), "list" | "snapshot" | "events") {
        authorize_project(scope.as_deref(), project.as_deref())?;
    }
    match request.command.as_str() {
        "list" | "snapshot" => {
            let data = inner.data.lock();
            Ok(json!({ "seq": data.seq, "agents": filtered_agents(&data, scope.as_deref()) }))
        }
        "events" => wait_events(
            inner,
            scope.as_deref(),
            request.after_seq.unwrap_or(0),
            request.timeout_ms,
        ),
        "wait" => wait_state(inner, &request),
        "capability" => {
            if scope.is_some() {
                return Err("only the global token can issue capabilities".to_string());
            }
            let project_path = request
                .workspace_path
                .ok_or_else(|| "workspacePath is required".to_string())?;
            let ttl = request.ttl_seconds.unwrap_or(900).clamp(1, 3600);
            let token = random_token()?;
            let expires_at_ms = now_ms() + ttl * 1000;
            inner.data.lock().capabilities.insert(
                token.clone(),
                Capability {
                    project_path: project_path.clone(),
                    expires_at_ms,
                },
            );
            Ok(json!({ "token": token, "projectPath": project_path, "expiresAtMs": expires_at_ms }))
        }
        "focus" | "prompt" | "start" => dispatch_frontend(
            inner,
            request,
            project.ok_or_else(|| "project could not be resolved".to_string())?,
        ),
        _ => Err(format!("unknown command: {}", request.command)),
    }
}

fn wait_events(
    inner: &Arc<Inner>,
    scope: Option<&str>,
    after_seq: u64,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, 300_000));
    let started = std::time::Instant::now();
    let mut data = inner.data.lock();
    loop {
        let oldest = data
            .events
            .front()
            .map(|event| event.seq)
            .unwrap_or(data.seq + 1);
        if after_seq > data.seq || after_seq.saturating_add(1) < oldest {
            return Ok(json!({
                "resync": true,
                "snapshot": { "seq": data.seq, "agents": filtered_agents(&data, scope) }
            }));
        }
        let events: Vec<_> = data
            .events
            .iter()
            .filter(|event| event.seq > after_seq)
            .filter(|event| {
                event
                    .agent
                    .as_ref()
                    .map(|agent| {
                        scope
                            .map(|path| path == agent.workspace_path)
                            .unwrap_or(true)
                    })
                    .unwrap_or(scope.is_none())
            })
            .cloned()
            .collect();
        if !events.is_empty() {
            return Ok(json!({ "resync": false, "seq": data.seq, "events": events }));
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("event wait timed out".to_string());
        }
        inner.changed.wait_for(&mut data, remaining);
    }
}

fn desired_state(agent: &AgentControlSnapshot, desired: &[String]) -> bool {
    desired.iter().any(|value| match value.as_str() {
        "present" => agent.occupancy == "present",
        "working" => agent.occupancy == "present" && agent.lifecycle == "working",
        "idle" => agent.occupancy == "present" && agent.lifecycle == "idle",
        "blocked" => agent.occupancy == "present" && agent.lifecycle == "blocked",
        "absent" => agent.occupancy == "absent" || agent.occupancy == "exited",
        "unknown" => agent.occupancy == "unknown" || agent.lifecycle == "unknown",
        _ => false,
    })
}

fn wait_state(inner: &Arc<Inner>, request: &ApiRequest) -> Result<Value, String> {
    let terminal_id = request
        .terminal_id
        .as_ref()
        .ok_or_else(|| "terminalId is required".to_string())?;
    let desired = request
        .desired
        .clone()
        .unwrap_or_else(|| vec!["idle".to_string(), "blocked".to_string()]);
    let request_id = match request.request_id.clone() {
        Some(value) => value,
        None => random_token()?,
    };
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, 300_000),
    );
    let started = std::time::Instant::now();
    let mut data = inner.data.lock();
    let pinned_generation = request
        .generation
        .or_else(|| data.agents.get(terminal_id).map(|agent| agent.generation))
        .ok_or_else(|| "terminal not found".to_string())?;
    let project = data
        .agents
        .get(terminal_id)
        .map(|agent| agent.workspace_path.clone())
        .ok_or_else(|| "terminal not found".to_string())?;
    if data.active_request_projects.contains_key(&request_id) {
        return Err("requestId is already active".to_string());
    }
    data.active_request_projects
        .insert(request_id.clone(), project);
    let result = (|| loop {
        if data.cancelled.remove(&request_id) {
            return Err("wait cancelled".to_string());
        }
        let agent = data
            .agents
            .get(terminal_id)
            .ok_or_else(|| "terminal no longer available".to_string())?;
        if agent.generation != pinned_generation {
            return Err("terminal occupant generation changed".to_string());
        }
        if desired_state(agent, &desired) {
            return Ok(
                json!({ "requestId": request_id, "generation": pinned_generation, "agent": agent }),
            );
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("state wait timed out".to_string());
        }
        inner.changed.wait_for(&mut data, remaining);
    })();
    data.active_request_projects.remove(&request_id);
    result
}

fn dispatch_frontend(
    inner: &Arc<Inner>,
    mut request: ApiRequest,
    project: String,
) -> Result<Value, String> {
    let request_id = request.request_id.clone().unwrap_or(random_token()?);
    request.request_id = Some(request_id.clone());
    {
        let mut data = inner.data.lock();
        if data.active_request_projects.contains_key(&request_id) {
            return Err("requestId is already active".to_string());
        }
        data.active_request_projects
            .insert(request_id.clone(), project);
    }
    let result = dispatch_frontend_inner(inner, request);
    let mut data = inner.data.lock();
    data.active_request_projects.remove(&request_id);
    data.cancelled.remove(&request_id);
    result
}

fn dispatch_frontend_inner(inner: &Arc<Inner>, request: ApiRequest) -> Result<Value, String> {
    let request_id = request
        .request_id
        .clone()
        .ok_or_else(|| "requestId is required".to_string())?;
    let generation = if let Some(id) = request.terminal_id.as_ref() {
        let data = inner.data.lock();
        let agent = data
            .agents
            .get(id)
            .ok_or_else(|| "terminal not found".to_string())?;
        let pinned = request.generation.unwrap_or(agent.generation);
        if pinned != agent.generation {
            return Err("terminal occupant generation changed".to_string());
        }
        Some(pinned)
    } else {
        None
    };
    let (baseline_seq, baseline_working) = {
        let data = inner.data.lock();
        let working = request
            .terminal_id
            .as_ref()
            .and_then(|id| data.agents.get(id))
            .map(|agent| agent.lifecycle == "working")
            .unwrap_or(false);
        (data.seq, working)
    };
    let payload = FrontendControlRequest {
        request_id: request_id.clone(),
        action: request.command.clone(),
        terminal_id: request.terminal_id.clone(),
        generation,
        text: request.text.clone(),
        mode: request.mode.clone(),
        workspace_path: request.workspace_path.clone(),
        kind: request.kind.clone(),
        task_name: request.task_name.clone(),
        isolated: request.isolated.unwrap_or(true),
    };
    let app = inner
        .app
        .lock()
        .clone()
        .ok_or_else(|| "frontend unavailable".to_string())?;
    inner
        .data
        .lock()
        .frontend_responses
        .insert(request_id.clone(), None);
    if let Err(error) = app.emit_to("main", "agent-control-request", payload) {
        inner.data.lock().frontend_responses.remove(&request_id);
        return Err(error.to_string());
    }
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, 300_000),
    );
    let started = std::time::Instant::now();
    let mut data = inner.data.lock();
    loop {
        if data.cancelled.remove(&request_id) {
            data.frontend_responses.remove(&request_id);
            drop(data);
            emit_frontend_cancel(inner, &request_id);
            return Err("request cancelled".to_string());
        }
        if let Some(Some(response)) = data.frontend_responses.remove(&request_id) {
            let value = response?;
            drop(data);
            if request.command == "prompt" && request.wait.unwrap_or(false) {
                let remaining = timeout.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err("prompt wait timed out".to_string());
                }
                return wait_prompt_turn(
                    inner,
                    request.terminal_id.as_deref().unwrap_or_default(),
                    generation.unwrap_or_default(),
                    &request_id,
                    baseline_seq,
                    baseline_working && request.mode.as_deref() == Some("steer"),
                    remaining,
                );
            }
            return Ok(value);
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            data.frontend_responses.remove(&request_id);
            drop(data);
            emit_frontend_cancel(inner, &request_id);
            return Err("frontend request timed out".to_string());
        }
        inner.changed.wait_for(&mut data, remaining);
    }
}

fn emit_frontend_cancel(inner: &Inner, request_id: &str) {
    if let Some(app) = inner.app.lock().clone() {
        let _ = app.emit_to("main", "agent-control-cancel", request_id.to_string());
    }
}

fn wait_prompt_turn(
    inner: &Arc<Inner>,
    terminal_id: &str,
    generation: u64,
    request_id: &str,
    baseline_seq: u64,
    mut saw_working: bool,
    timeout: Duration,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let mut data = inner.data.lock();
    loop {
        if data.cancelled.remove(request_id) {
            return Err("prompt wait cancelled".to_string());
        }
        let agent = data
            .agents
            .get(terminal_id)
            .ok_or_else(|| "terminal no longer available".to_string())?;
        if agent.generation != generation {
            return Err("terminal occupant generation changed".to_string());
        }
        if data.seq > baseline_seq {
            if agent.lifecycle == "working" {
                saw_working = true;
            } else if saw_working && (agent.lifecycle == "idle" || agent.lifecycle == "blocked") {
                return Ok(
                    json!({ "requestId": request_id, "generation": generation, "agent": agent }),
                );
            }
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("prompt wait timed out".to_string());
        }
        inner.changed.wait_for(&mut data, remaining);
    }
}

#[tauri::command]
pub fn agent_control_sync(
    state: tauri::State<'_, ControlState>,
    agents: Vec<AgentControlSnapshot>,
) {
    let mut data = state.inner.data.lock();
    let next: HashMap<_, _> = agents
        .into_iter()
        .map(|agent| (agent.terminal_id.clone(), agent))
        .collect();
    let removed: Vec<_> = data
        .agents
        .keys()
        .filter(|id| !next.contains_key(*id))
        .cloned()
        .collect();
    for id in removed {
        if let Some(agent) = data.agents.remove(&id) {
            push_event(&mut data, "removed", id, Some(agent));
        }
    }
    for (id, agent) in next {
        if data.agents.get(&id) != Some(&agent) {
            data.agents.insert(id.clone(), agent.clone());
            push_event(&mut data, "upserted", id, Some(agent));
        }
    }
    drop(data);
    state.inner.changed.notify_all();
}

#[tauri::command]
pub fn agent_control_respond(
    state: tauri::State<'_, ControlState>,
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) {
    let mut data = state.inner.data.lock();
    if let Some(slot) = data.frontend_responses.get_mut(&request_id) {
        *slot = Some(if ok {
            Ok(result.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "frontend request failed".to_string()))
        });
    }
    drop(data);
    state.inner.changed.notify_all();
}

#[tauri::command]
pub fn agent_control_info(
    app: AppHandle,
    state: tauri::State<'_, ControlState>,
) -> Result<ControlInfo, String> {
    if state.inner.socket_path.lock().is_none() {
        start(&app, &state)?;
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    Ok(ControlInfo {
        socket_path: state
            .inner
            .socket_path
            .lock()
            .as_ref()
            .ok_or_else(|| "control socket unavailable".to_string())?
            .to_string_lossy()
            .into_owned(),
        token_path: state
            .inner
            .token_path
            .lock()
            .as_ref()
            .ok_or_else(|| "control token unavailable".to_string())?
            .to_string_lossy()
            .into_owned(),
        cli_path: resources
            .join("resources/vibe-agent")
            .to_string_lossy()
            .into_owned(),
        skill_path: resources
            .join("resources/vibe-agent-skill/SKILL.md")
            .to_string_lossy()
            .into_owned(),
    })
}

#[tauri::command]
pub fn agent_control_issue_capability(
    state: tauri::State<'_, ControlState>,
    project_path: String,
    ttl_seconds: u64,
) -> Result<IssuedCapability, String> {
    let token = random_token()?;
    let expires_at_ms = now_ms() + ttl_seconds.clamp(1, 3600) * 1000;
    state.inner.data.lock().capabilities.insert(
        token.clone(),
        Capability {
            project_path: project_path.clone(),
            expires_at_ms,
        },
    );
    Ok(IssuedCapability {
        token,
        project_path,
        expires_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(token: &str, command: &str) -> ApiRequest {
        ApiRequest {
            token: token.to_string(),
            command: command.to_string(),
            request_id: None,
            terminal_id: None,
            generation: None,
            text: None,
            mode: None,
            workspace_path: None,
            kind: None,
            task_name: None,
            isolated: None,
            wait: None,
            desired: None,
            timeout_ms: None,
            after_seq: None,
            ttl_seconds: None,
        }
    }

    fn agent(id: &str, lifecycle: &str) -> AgentControlSnapshot {
        AgentControlSnapshot {
            terminal_id: id.to_string(),
            workspace_path: "/repo".to_string(),
            scope: "workspace".to_string(),
            kind: "codex".to_string(),
            occupancy: "present".to_string(),
            occupant_pid: Some(1),
            generation: 2,
            lifecycle: lifecycle.to_string(),
            seen: true,
            changed_at: 1,
            authority: None,
            reason: None,
            matched_rule: None,
        }
    }

    #[test]
    fn desired_states_are_semantic() {
        assert!(desired_state(&agent("a", "idle"), &["idle".to_string()]));
        assert!(!desired_state(
            &agent("a", "working"),
            &["idle".to_string()]
        ));
    }

    #[test]
    fn event_ring_is_bounded_and_ordered() {
        let mut data = Data::default();
        for index in 0..(EVENT_LIMIT + 5) {
            push_event(&mut data, "removed", index.to_string(), None);
        }
        assert_eq!(data.events.len(), EVENT_LIMIT);
        assert_eq!(data.events.front().unwrap().seq, 6);
        assert_eq!(data.events.back().unwrap().seq, (EVENT_LIMIT + 5) as u64);
    }

    #[test]
    fn project_capability_filters_snapshots_and_cancels_only_its_request() {
        let state = ControlState::default();
        *state.inner.global_token.lock() = "global".to_string();
        let mut data = state.inner.data.lock();
        data.agents.insert("a".to_string(), agent("a", "idle"));
        let mut other = agent("b", "idle");
        other.workspace_path = "/other".to_string();
        data.agents.insert("b".to_string(), other);
        drop(data);

        let mut issue = request("global", "capability");
        issue.workspace_path = Some("/repo".to_string());
        let issued = handle_request(&state.inner, issue).unwrap();
        let token = issued["token"].as_str().unwrap();

        let snapshot = handle_request(&state.inner, request(token, "list")).unwrap();
        assert_eq!(snapshot["agents"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["agents"][0]["terminalId"], "a");

        let mut spoofed = request(token, "focus");
        spoofed.terminal_id = Some("b".to_string());
        spoofed.workspace_path = Some("/repo".to_string());
        assert!(handle_request(&state.inner, spoofed)
            .unwrap_err()
            .contains("does not match"));

        state
            .inner
            .data
            .lock()
            .active_request_projects
            .insert("wait-a".to_string(), "/repo".to_string());
        let mut cancel = request(token, "cancel");
        cancel.request_id = Some("wait-a".to_string());
        handle_request(&state.inner, cancel).unwrap();
        assert!(state.inner.data.lock().cancelled.contains("wait-a"));

        state
            .inner
            .data
            .lock()
            .active_request_projects
            .insert("wait-b".to_string(), "/other".to_string());
        let mut forbidden = request(token, "cancel");
        forbidden.request_id = Some("wait-b".to_string());
        assert!(handle_request(&state.inner, forbidden).is_err());
    }
}
