use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv6Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const MAX_LISTENERS: usize = 128;
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

#[derive(Debug)]
struct ParsedListener {
    pid: u32,
    process: String,
    port: u16,
}

#[tauri::command]
pub(crate) async fn preview_servers(workspace_path: String) -> Result<Vec<PreviewServer>, String> {
    tauri::async_runtime::spawn_blocking(move || discover(&workspace_path))
        .await
        .map_err(|e| format!("Preview discovery task failed: {e}"))?
}

fn discover(workspace_path: &str) -> Result<Vec<PreviewServer>, String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        .output()
        .map_err(|e| format!("Could not list local preview servers: {e}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }

    let workspace = Path::new(workspace_path);
    let mut servers = Vec::new();
    for listener in parse_lsof_listeners(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .take(MAX_LISTENERS)
    {
        let cwd = cwd_for(listener.pid);
        let process = command_for(listener.pid).unwrap_or(listener.process);
        let Some(response) = probe_http(listener.port) else {
            continue;
        };
        let url = super::url::normalize_loopback_url(&listener.port.to_string())?.to_string();
        let framework = framework_label(&process, &response, cwd.as_deref());
        let project_match = project_matches(cwd.as_deref(), workspace);
        servers.push(PreviewServer {
            url,
            port: listener.port,
            pid: Some(listener.pid),
            process,
            cwd,
            framework,
            project_match,
        });
    }
    rank_servers(&mut servers, workspace);
    Ok(servers)
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
