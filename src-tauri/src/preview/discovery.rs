use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv6Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_LISTENERS: usize = 128;
const DISCOVERY_WORKERS: usize = 8;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_RESPONSE_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewServer {
    pub url: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process: String,
    pub cwd: Option<String>,
    pub framework: Option<String>,
    pub project_match: bool,
}

#[derive(Clone, Debug)]
struct ParsedListener {
    pid: u32,
    process: String,
    port: u16,
}

#[derive(Debug)]
struct ProcessMetadata {
    pid: u32,
    cwd: Option<String>,
    command: Option<String>,
}

pub(super) fn discover(workspace_path: &str) -> Result<Vec<PreviewServer>, String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        .output()
        .map_err(|e| format!("Could not list local preview servers: {e}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }

    let workspace = Path::new(workspace_path);
    let listeners = parse_lsof_listeners(&String::from_utf8_lossy(&output.stdout));

    // A process may own several listeners. Collect its cwd/command once, with
    // the same fixed-size pool used for probes, instead of launching duplicate
    // subprocesses or one thread per listener.
    let mut pids = listeners
        .iter()
        .map(|listener| listener.pid)
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    let metadata = run_bounded_jobs(pids, DISCOVERY_WORKERS, |pid| {
        Some(ProcessMetadata {
            pid,
            cwd: cwd_for(pid),
            command: command_for(pid),
        })
    })
    .into_iter()
    .flatten()
    .map(|metadata| (metadata.pid, metadata))
    .collect::<HashMap<_, _>>();

    // Silent listeners can consume both 500 ms address attempts. Probe them
    // concurrently, but cap the worker count so discovery stays bounded even
    // when lsof returns MAX_LISTENERS entries. Result slots preserve lsof
    // order until the explicit deterministic rank below.
    let discovered = run_bounded_jobs(listeners, DISCOVERY_WORKERS, |listener| {
        let metadata = metadata.get(&listener.pid);
        let cwd = metadata.and_then(|metadata| metadata.cwd.clone());
        let process = metadata
            .and_then(|metadata| metadata.command.clone())
            .unwrap_or(listener.process);
        let response = probe_http(listener.port)?;
        let url = super::url::normalize_loopback_url(&listener.port.to_string())
            .ok()?
            .to_string();
        let framework = framework_label(&process, &response, cwd.as_deref());
        let project_match = project_matches(cwd.as_deref(), workspace);
        Some(PreviewServer {
            url,
            port: listener.port,
            pid: Some(listener.pid),
            process,
            cwd,
            framework,
            project_match,
        })
    });
    let mut servers = discovered.into_iter().flatten().collect::<Vec<_>>();
    rank_servers(&mut servers, workspace);
    Ok(servers)
}

fn bounded_worker_count(job_count: usize, max_workers: usize) -> usize {
    job_count.min(max_workers.max(1))
}

/// Run explicitly fallible blocking jobs on a small scoped worker pool. Each
/// output occupies the same index as its input. If the OS cannot create every
/// requested worker, queued work is completed synchronously after the workers
/// that did start have joined. An unexpectedly failed join leaves that job's
/// result absent without changing result order.
fn run_bounded_jobs<T, R, F>(jobs: Vec<T>, max_workers: usize, work: F) -> Vec<Option<R>>
where
    T: Send,
    R: Send,
    F: Fn(T) -> Option<R> + Sync,
{
    let job_count = jobs.len();
    if job_count == 0 {
        return Vec::new();
    }

    let queue = Arc::new(Mutex::new(
        jobs.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));
    let results = Arc::new(Mutex::new(
        (0..job_count).map(|_| None).collect::<Vec<Option<R>>>(),
    ));

    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..bounded_worker_count(job_count, max_workers) {
            let queue = Arc::clone(&queue);
            let results = Arc::clone(&results);
            let work = &work;
            match std::thread::Builder::new().spawn_scoped(scope, move || loop {
                let job = queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .pop_front();
                let Some((index, job)) = job else { break };
                if let Some(result) = work(job) {
                    results
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())[index] = Some(result);
                }
            }) {
                Ok(worker) => workers.push(worker),
                Err(_) => break,
            }
        }

        for worker in workers {
            // Production uses panic = "abort". This Result only provides a
            // safe degraded outcome in unwind-enabled development builds; no
            // panic recovery guarantee is part of the worker contract.
            let _ = worker.join();
        }

        // Normally empty. This is the bounded fallback for worker creation
        // failure, and also finishes jobs not claimed before a failed join.
        loop {
            let job = queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front();
            let Some((index, job)) = job else { break };
            if let Some(result) = work(job) {
                results
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())[index] = Some(result);
            }
        }
    });

    let mut results = results
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *results)
}

fn parse_lsof_listeners(raw: &str) -> Vec<ParsedListener> {
    let mut listeners = Vec::new();
    let mut seen = HashSet::new();
    let mut pid = None;
    let mut process = String::new();

    for line in raw.lines() {
        let Some((field, value)) = line.chars().next().map(|field| (field, &line[1..])) else {
            continue;
        };
        match field {
            'p' => pid = value.parse::<u32>().ok(),
            'c' => process = value.to_string(),
            'n' => {
                let Some(pid) = pid else { continue };
                let Some(port) = lsof_port(value) else {
                    continue;
                };
                if seen.insert((pid, port)) {
                    listeners.push(ParsedListener {
                        pid,
                        process: process.clone(),
                        port,
                    });
                    if listeners.len() == MAX_LISTENERS {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    listeners
}

fn lsof_port(name: &str) -> Option<u16> {
    name.rsplit(':').next()?.parse().ok()
}

fn cwd_for(pid: u32) -> Option<String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n').map(ToOwned::to_owned))
        .filter(|cwd| !cwd.is_empty())
}

fn command_for(pid: u32) -> Option<String> {
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!command.is_empty()).then_some(command)
}

fn probe_http(port: u16) -> Option<String> {
    let addresses = [
        SocketAddr::from(([127, 0, 0, 1], port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ];
    addresses.into_iter().find_map(probe_address)
}

fn probe_address(address: SocketAddr) -> Option<String> {
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(CONNECT_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(CONNECT_TIMEOUT)).ok()?;
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .ok()?;

    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0; 4096];
    while response.len() < MAX_RESPONSE_BYTES {
        let max = (MAX_RESPONSE_BYTES - response.len()).min(chunk.len());
        match stream.read(&mut chunk[..max]) {
            Ok(0) => break,
            Ok(read) => response.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    let response = String::from_utf8_lossy(&response).into_owned();
    response.starts_with("HTTP/").then_some(response)
}

fn framework_label(command: &str, response: &str, cwd: Option<&str>) -> Option<String> {
    let markers = format!("{command}\n{response}").to_ascii_lowercase();
    if markers.contains("next dev") || markers.contains("/_next/") {
        return Some("Next.js".into());
    }
    if markers.contains("expo start --web") || markers.contains("expo-router") {
        return Some("Expo Web".into());
    }
    if markers.contains("vite") {
        return Some("Vite".into());
    }
    dependency_framework(cwd?)
}

fn dependency_framework(cwd: &str) -> Option<String> {
    let package_json = fs::read_to_string(Path::new(cwd).join("package.json")).ok()?;
    let package: serde_json::Value = serde_json::from_str(&package_json).ok()?;
    let has_dependency = |name: &str| {
        [
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ]
        .iter()
        .any(|section| package[section].get(name).is_some())
    };
    if has_dependency("next") {
        Some("Next.js".into())
    } else if has_dependency("expo") || has_dependency("expo-router") {
        Some("Expo Web".into())
    } else if has_dependency("vite") {
        Some("Vite".into())
    } else {
        None
    }
}

fn project_matches(cwd: Option<&str>, workspace: &Path) -> bool {
    let Some(cwd) = cwd else { return false };
    let cwd = Path::new(cwd);
    let canonical_cwd = fs::canonicalize(cwd);
    let canonical_workspace = fs::canonicalize(workspace);
    let (cwd, workspace) = match (canonical_cwd, canonical_workspace) {
        (Ok(cwd), Ok(workspace)) => (cwd, workspace),
        _ => (cwd.to_path_buf(), workspace.to_path_buf()),
    };
    cwd == workspace || cwd.starts_with(workspace)
}

fn rank_servers(servers: &mut [PreviewServer], workspace: &Path) {
    for server in servers.iter_mut() {
        server.project_match = project_matches(server.cwd.as_deref(), workspace);
    }
    servers.sort_by(|left, right| {
        right
            .project_match
            .cmp(&left.project_match)
            .then_with(|| left.port.cmp(&right.port))
            .then_with(|| left.process.cmp(&right.process))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(port: u16, cwd: Option<&str>) -> PreviewServer {
        PreviewServer {
            url: format!("http://localhost:{port}/"),
            port,
            pid: None,
            process: String::new(),
            cwd: cwd.map(ToOwned::to_owned),
            framework: None,
            project_match: false,
        }
    }

    #[test]
    fn parses_and_deduplicates_lsof_field_output() {
        let raw = "p101\ncnode\nn*:3000\nn[::1]:3000\np202\ncControlCenter\nn*:5000\n";
        let got = parse_lsof_listeners(raw);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].pid, got[0].port), (101, 3000));
        assert_eq!((got[1].pid, got[1].port), (202, 5000));
    }

    #[test]
    fn caps_parsed_listeners_at_128_unique_records() {
        let raw = (0..129)
            .map(|index| format!("p{}\ncnode\nn*:{}\n", index + 1, index + 3000))
            .collect::<String>();
        let got = parse_lsof_listeners(&raw);
        assert_eq!(got.len(), MAX_LISTENERS);
        assert_eq!(got.last().map(|listener| listener.port), Some(3127));
    }

    #[test]
    fn bounded_jobs_preserve_input_order_and_explicit_failures() {
        let got = run_bounded_jobs(vec![3, 2, 1, 0], 2, |value| {
            (value != 2).then_some(value * 10)
        });
        assert_eq!(got, vec![Some(30), None, Some(10), Some(0)]);
    }

    #[test]
    fn worker_count_is_never_unbounded_or_zero_for_work() {
        assert_eq!(bounded_worker_count(0, DISCOVERY_WORKERS), 0);
        assert_eq!(bounded_worker_count(3, DISCOVERY_WORKERS), 3);
        assert_eq!(bounded_worker_count(128, DISCOVERY_WORKERS), 8);
        assert_eq!(bounded_worker_count(4, 0), 1);
    }

    #[test]
    fn project_matches_sort_before_other_servers() {
        let root = std::path::Path::new("/repo");
        let mut servers = vec![
            server(3000, Some("/other/app")),
            server(8081, Some("/repo/apps/mobile")),
        ];
        rank_servers(&mut servers, root);
        assert_eq!(
            servers.iter().map(|s| s.port).collect::<Vec<_>>(),
            vec![8081, 3000]
        );
        assert!(servers[0].project_match);
    }

    #[test]
    fn labels_common_dev_servers_without_filtering_unknown_http() {
        assert_eq!(
            framework_label("node next dev", "", None),
            Some("Next.js".into())
        );
        assert_eq!(
            framework_label("node expo start --web", "", None),
            Some("Expo Web".into())
        );
        assert_eq!(framework_label("node vite", "", None), Some("Vite".into()));
        assert_eq!(
            framework_label("python http.server", "HTTP/1.0 200 OK", None),
            None
        );
    }
}
