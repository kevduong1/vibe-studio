# Localhost Phone Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-only, workspace-owned editor tabs that interactively preview localhost web applications in phone-sized native WKWebViews and discover running local development servers.

**Architecture:** A Rust preview module validates loopback URLs, discovers HTTP listeners, and owns Tauri child-webview lifecycle. A typed frontend session registry serializes native-view operations, while the existing per-workspace editor store owns preview-tab metadata and React renders the picker, toolbar, and phone frame. Native views remain unprivileged and are hidden whenever their tab, workspace, editor surface, or an overlapping main-webview overlay is inactive.

**Tech Stack:** Tauri 2.11 with the `unstable` child-webview API, Rust standard networking plus `url`, React 19, TypeScript 5.9, Zustand 5, WKWebView, CSS.

## Global Constraints

- macOS is the supported desktop target; do not add cross-platform simulation behavior.
- Keep Tauri at `2.11`; enable only its `unstable` Cargo feature required by `Window::add_child`. Do not enable `macos-private-api`.
- Accept only top-level `http:` and `https:` URLs on `localhost`, `127.0.0.1`, or `[::1]`.
- Allow preview pages to load arbitrary subresources, APIs, images, fonts, and WebSockets, but grant remote pages no Tauri capability scope.
- Every preview invocation creates a new tab, including duplicate URLs.
- Preview tabs belong to the active workspace, live only for the current application session, and close with their tab or workspace.
- Discover all reachable plain-HTTP localhost servers, sort active-workspace process matches first, and preserve manual URL entry if discovery fails.
- Do not start or stop development servers.
- Use a 390×844 logical-point portrait target and an 844×390 landscape target, each clamped to available editor bounds.
- Do not add a JavaScript test framework; use Rust unit tests plus the existing TypeScript production build and manual Tauri verification.
- Preserve unrelated working-tree changes and stage only the files named by each task.

## File Structure

### New backend files

- `src-tauri/src/preview.rs` — public command surface and shared serialized preview types.
- `src-tauri/src/preview/url.rs` — loopback URL normalization and validation.
- `src-tauri/src/preview/discovery.rs` — listener enumeration, process metadata, HTTP probing, labeling, and sorting.
- `src-tauri/src/preview/webviews.rs` — native child-webview creation, navigation, geometry, focus, visibility, and teardown.

### New frontend files

- `src/lib/previewUrl.ts` — matching client-side URL normalization for immediate picker feedback.
- `src/lib/previewSessions.ts` — framework-independent live-session registry and serialized IPC lifecycle.
- `src/lib/nativeOverlays.ts` — mount/unmount hook that obscures native preview views behind React overlays.
- `src/components/PreviewPicker.tsx` and `PreviewPicker.css` — manual URL entry and ranked local-server picker.
- `src/components/PreviewPane.tsx` and `PreviewPane.css` — toolbar, device frame, bounds synchronization, and native-view controls.

### Existing files to modify

- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — child-webview feature and direct URL dependency.
- `src-tauri/capabilities/default.json` — target privileges at the trusted main webview rather than every child of the main window.
- `src-tauri/src/main.rs` — module/command registration, main-webview reload guard, shutdown cleanup.
- `src/lib/ipc.ts` — single typed IPC/event contract.
- `src/lib/zoom.ts` — subscribe to app zoom changes for native bounds resynchronization.
- `src/stores/editor.ts` — preview tab metadata and actions.
- `src/stores/workspaces.ts` — workspace-owned preview teardown.
- `src/stores/ui.ts` — native-overlay depth.
- `src/components/ContextMenu.tsx`, `TaskPicker.tsx`, `QuickOpen.tsx`, `SettingsModal.tsx` — hide native previews while fixed overlays are mounted.
- `src/components/EditorArea.tsx`, `EditorArea.css` — preview tab icon, add action, picker, pane routing, and workspace visibility.
- `src/App.tsx` — pass workspace visibility into the editor surface.
- `src/components/icons.tsx` — browser, phone, rotation, back, forward, and external-open glyphs.
- `README.md`, `CLAUDE.md` — user-facing feature and architecture map.

---

### Task 1: Loopback URL validation and local HTTP server discovery

**Files:**
- Create: `src-tauri/src/preview.rs`
- Create: `src-tauri/src/preview/url.rs`
- Create: `src-tauri/src/preview/discovery.rs`
- Modify: `src-tauri/src/main.rs:4-12,33-99`
- Modify: `src-tauri/Cargo.toml:10-22`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Produces: `normalize_loopback_url(input: &str) -> Result<url::Url, String>`
- Produces: `is_loopback_url(url: &url::Url) -> bool`
- Produces: `PreviewServer { url, port, pid, process, cwd, framework, project_match }`
- Produces: `#[tauri::command] async fn preview_servers(workspace_path: String) -> Result<Vec<PreviewServer>, String>`
- Consumes: active workspace root supplied by the frontend in Task 5.

- [ ] **Step 1: Add the URL dependency and preview module test scaffold**

Change Cargo dependencies to:

```toml
tauri = { version = "2.11", features = [] }
url = "2"
```

Add `mod preview;` to `main.rs`. In `preview.rs`, declare private `discovery`
and `url` children and re-export only the command. In `url.rs`, add tests
before production functions:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_port_and_host_shorthand() {
        assert_eq!(normalize_loopback_url("3000").unwrap().as_str(), "http://localhost:3000/");
        assert_eq!(normalize_loopback_url("localhost:8081/app").unwrap().as_str(), "http://localhost:8081/app");
    }

    #[test]
    fn accepts_only_loopback_http_urls() {
        for input in [
            "http://localhost:3000",
            "https://127.0.0.1:4443/path",
            "http://[::1]:8081",
        ] {
            assert!(normalize_loopback_url(input).is_ok(), "{input}");
        }
        for input in [
            "file:///tmp/index.html",
            "http://localhost.example.com:3000",
            "http://192.168.1.4:3000",
            "http://user:pass@localhost:3000",
        ] {
            assert!(normalize_loopback_url(input).is_err(), "{input}");
        }
    }
}
```

- [ ] **Step 2: Run the URL tests and verify they fail**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml preview::url::tests
```

Expected: compilation fails because `normalize_loopback_url` is not defined.

- [ ] **Step 3: Implement authoritative URL normalization**

Use one normalization path for server results, create, and navigate:

```rust
pub(crate) fn normalize_loopback_url(input: &str) -> Result<url::Url, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter a localhost URL or port".into());
    }
    let candidate = if raw.bytes().all(|b| b.is_ascii_digit()) {
        format!("http://localhost:{raw}")
    } else if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url = url::Url::parse(&candidate).map_err(|_| "Invalid preview URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || !is_loopback_url(&url) {
        return Err("Preview URLs must use HTTP or HTTPS on localhost".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Preview URLs cannot contain credentials".into());
    }
    Ok(url)
}

pub(crate) fn is_loopback_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}
```

- [ ] **Step 4: Run the URL tests and verify they pass**

Run the Task 1 test command again. Expected: all URL tests pass.

- [ ] **Step 5: Add failing listener, ranking, and framework tests**

Define a private parsed-listener seam and test exact lsof field output:

```rust
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
    assert_eq!(servers.iter().map(|s| s.port).collect::<Vec<_>>(), vec![8081, 3000]);
    assert!(servers[0].project_match);
}

#[test]
fn labels_common_dev_servers_without_filtering_unknown_http() {
    assert_eq!(framework_label("node next dev", "", None), Some("Next.js".into()));
    assert_eq!(framework_label("node expo start --web", "", None), Some("Expo Web".into()));
    assert_eq!(framework_label("node vite", "", None), Some("Vite".into()));
    assert_eq!(framework_label("python http.server", "HTTP/1.0 200 OK", None), None);
}
```

- [ ] **Step 6: Run discovery tests and verify they fail**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml preview::discovery::tests
```

Expected: compilation fails on the first undefined parser/helper.

- [ ] **Step 7: Implement discovery with bounded failure isolation**

Implement these exact phases in `discovery.rs`:

```rust
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
```

1. Run `/usr/sbin/lsof` with fixed arguments
   `-nP -iTCP -sTCP:LISTEN -Fpcn`; cap parsed candidates at 128.
2. Parse `p`, `c`, and `n` records, extract the final numeric port from IPv4,
   IPv6, wildcard, and hostname forms, and deduplicate `(pid, port)`.
3. For each PID, run fixed-argument `/usr/sbin/lsof -a -p PID -d cwd -Fn`
   and `/bin/ps -p PID -o command=`. Treat either failure as missing metadata.
4. Probe `127.0.0.1:port`, then `[::1]:port`, with `TcpStream::connect_timeout`,
   500 ms connect/read/write timeouts, `GET / HTTP/1.0`,
   `Host: localhost`, and a 32 KiB read cap. Keep any response beginning
   `HTTP/` regardless of status code.
5. Label by case-insensitive command/response markers (`next dev`,
   `/_next/`, `expo start --web`, `expo-router`, `vite`) and, when still
   unknown, dependency keys in `<cwd>/package.json`.
6. Mark a project match only when canonical-or-lexical `cwd == workspace` or
   `cwd.starts_with(workspace + separator)`; `/repo-two` must not match
   `/repo`.
7. Sort by `project_match` descending, then port ascending, then process.

Run blocking enumeration/probes through `tauri::async_runtime::spawn_blocking`
inside the command so terminal and LSP IPC remains responsive:

```rust
#[tauri::command]
pub(crate) async fn preview_servers(
    workspace_path: String,
) -> Result<Vec<PreviewServer>, String> {
    tauri::async_runtime::spawn_blocking(move || discovery::discover(&workspace_path))
        .await
        .map_err(|e| format!("Preview discovery task failed: {e}"))?
}
```

- [ ] **Step 8: Register discovery and run backend verification**

Add `preview::preview_servers` under a `// previews` group in
`generate_handler!`, then run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml preview::
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: formatting, tests, and check pass.

- [ ] **Step 9: Commit discovery**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/main.rs src-tauri/src/preview.rs src-tauri/src/preview/url.rs src-tauri/src/preview/discovery.rs
git commit -m "feat: discover localhost preview servers"
```

---

### Task 2: Native child-webview lifecycle and security boundary

**Files:**
- Create: `src-tauri/src/preview/webviews.rs`
- Modify: `src-tauri/src/preview.rs`
- Modify: `src-tauri/src/main.rs:22-32,99-116`
- Modify: `src-tauri/Cargo.toml:11`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/capabilities/default.json:1-17`

**Interfaces:**
- Consumes: `normalize_loopback_url`, `is_loopback_url` from Task 1.
- Produces: `PreviewBounds { x, y, width, height }`.
- Produces commands: `preview_create`, `preview_navigate`, `preview_back`, `preview_forward`, `preview_reload`, `preview_set_bounds`, `preview_set_visible`, `preview_focus`, `preview_close`, `preview_close_many`.
- Produces events: `preview-load` with `PreviewLoadEvent`, and `preview-external` with `PreviewExternalEvent`.

- [ ] **Step 1: Enable only Tauri's child-webview feature**

Change the dependency to:

```toml
tauri = { version = "2.11", features = ["unstable"] }
```

Do not change `tauri.conf.json` to enable `macOSPrivateApi`, and do not add
`core:webview:allow-create-webview`; all creation stays behind typed Rust
commands invoked by the trusted main webview.

Because this becomes a multiwebview window, replace `"windows": ["main"]`
with `"webviews": ["main"]` in the existing default capability. Keep its
permission list unchanged and do not add a `remote` block. This explicitly
keeps every `preview:*` webview outside the IPC capability boundary.

- [ ] **Step 2: Add failing pure helper tests**

In `webviews.rs`, add tests for labels and bounds validation:

```rust
#[test]
fn accepts_only_generated_preview_ids() {
    assert_eq!(webview_label("preview:550e8400-e29b-41d4-a716-446655440000").unwrap(),
               "preview:550e8400-e29b-41d4-a716-446655440000");
    assert!(webview_label("main").is_err());
    assert!(webview_label("preview:../bad").is_err());
}

#[test]
fn rejects_non_finite_or_empty_bounds() {
    assert!(validate_bounds(PreviewBounds { x: 1.0, y: 2.0, width: 390.0, height: 844.0 }).is_ok());
    assert!(validate_bounds(PreviewBounds { x: 0.0, y: 0.0, width: 0.0, height: 844.0 }).is_err());
    assert!(validate_bounds(PreviewBounds { x: f64::NAN, y: 0.0, width: 390.0, height: 844.0 }).is_err());
}
```

- [ ] **Step 3: Run the helper tests and verify they fail**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml preview::webviews::tests
```

Expected: compilation fails because the helper functions are missing.

- [ ] **Step 4: Implement the child-webview command surface**

Use these serialized types in `preview.rs`:

```rust
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewLoadEvent {
    pub id: String,
    pub url: String,
    pub phase: &'static str,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewExternalEvent {
    pub id: String,
    pub url: String,
}
```

`preview_create` must:

1. validate the generated `preview:<uuid>` ID, URL, and finite positive bounds;
2. return success without duplicating an existing view of the same label;
3. obtain `app.get_window("main")`;
4. build `WebviewBuilder::new(label, WebviewUrl::External(url))`;
5. allow only `is_loopback_url` in `on_navigation`;
6. emit rejected destinations to the main webview as `preview-external` and
   synchronously return `false`;
7. handle `window.open`: navigate the current preview for loopback URLs,
   otherwise emit `preview-external`, and always return `NewWindowResponse::Deny`;
8. emit `preview-load` on Started and Finished page-load events;
9. call `window.add_child` with logical position and size; and
10. immediately hide the result so React is the authority that reveals it.

Use `app.emit_to(tauri::EventTarget::webview("main"), ...)` and import
`tauri::{Emitter, Manager}`. Remote preview webviews are not targets of these
events and receive no capability entry.

Implement the remaining commands with exact fixed operations:

```rust
preview_navigate  => webview.navigate(normalize_loopback_url(&url)?)
preview_back      => webview.eval("history.back()")
preview_forward   => webview.eval("history.forward()")
preview_reload    => webview.eval("location.reload()")
preview_set_bounds=> webview.set_bounds(Rect::Logical { position, size })
preview_set_visible(true)  => webview.show()
preview_set_visible(false) => webview.hide()
preview_focus     => webview.set_focus()
preview_close     => webview.close(), missing view is success
preview_close_many=> loop IDs, close every existing view, return the first error after attempting all
```

Never interpolate URL or ID into evaluated JavaScript; the three history
scripts above are constants.

- [ ] **Step 5: Prevent preview loads from tearing down IDE processes**

The existing global `Builder::on_page_load` callback currently kills all PTYs
and LSPs for every webview load. Guard it exactly at the outer condition:

```rust
if webview.label() == "main"
    && payload.event() == tauri::webview::PageLoadEvent::Started
{
    pty::kill_all(&webview.app_handle().state::<pty::PtyState>());
    lsp::kill_all(&webview.app_handle().state::<lsp::LspState>());
}
```

Register all preview commands. On `RunEvent::Exit`, call a
`preview::close_all(&app_handle)` helper before process teardown; it filters
`app_handle.webviews()` to labels beginning `preview:` and closes them.

- [ ] **Step 6: Run backend verification**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml preview::
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: helper tests pass and the Tauri 2.11 child-webview API compiles with
only the `unstable` feature.

- [ ] **Step 7: Commit native lifecycle**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/default.json src-tauri/src/main.rs src-tauri/src/preview.rs src-tauri/src/preview/webviews.rs
git commit -m "feat: manage localhost preview webviews"
```

---

### Task 3: Typed frontend contract and serialized preview sessions

**Files:**
- Create: `src/lib/previewUrl.ts`
- Create: `src/lib/previewSessions.ts`
- Modify: `src/lib/ipc.ts:1-760`
- Modify: `src/lib/zoom.ts:15-58`

**Interfaces:**
- Consumes: all Rust commands/events from Tasks 1-2.
- Produces: `normalizePreviewInput(input: string) -> string | null`.
- Produces: `PreviewServer`, `PreviewBounds`, `PreviewLoadEvent`, `PreviewExternalEvent` TypeScript types.
- Produces: `getOrCreatePreviewSession`, `disposePreviewSession`, `disposePreviewSessions`, `hideAllPreviewSessions`.
- Produces: `onZoomChange(listener) -> () => void`.

- [ ] **Step 1: Add the exact IPC types and wrappers**

Append a Preview section to `ipc.ts`:

```ts
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewServer {
  url: string;
  port: number;
  pid: number | null;
  process: string;
  cwd: string | null;
  framework: string | null;
  projectMatch: boolean;
}

export interface PreviewLoadEvent {
  id: string;
  url: string;
  phase: "started" | "finished";
}

export interface PreviewExternalEvent { id: string; url: string }
```

Add one wrapper per Task 2 command using camelCase payload keys, plus:

```ts
export const previewServers = (workspacePath: string): Promise<PreviewServer[]> =>
  invoke("preview_servers", { workspacePath });
export const onPreviewLoad = (cb: (value: PreviewLoadEvent) => void) =>
  listen<PreviewLoadEvent>("preview-load", (event) => cb(event.payload));
export const onPreviewExternal = (cb: (value: PreviewExternalEvent) => void) =>
  listen<PreviewExternalEvent>("preview-external", (event) => cb(event.payload));
```

- [ ] **Step 2: Implement matching client-side URL feedback**

`previewUrl.ts` mirrors Rust normalization but returns `null` rather than an
error string:

```ts
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizePreviewInput(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const candidate = /^\d+$/.test(raw)
    ? `http://localhost:${raw}`
    : raw.includes("://") ? raw : `http://${raw}`;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const loopback = LOOPBACK.has(hostname) || hostname === "::1";
    if (!/^https?:$/.test(url.protocol) || !loopback) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Make app zoom observable**

Add a module-level listener set in `zoom.ts`:

```ts
const listeners = new Set<() => void>();
export const onZoomChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
```

After updating `level` and calling `setZoom` in `apply`, notify a copied
listener list. Keep `currentZoom()` unchanged.

- [ ] **Step 4: Implement a generation-safe session registry**

`previewSessions.ts` exposes this public shape:

```ts
export interface PreviewSession {
  readonly id: string;
  ensure(url: string, bounds: PreviewBounds): Promise<void>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  setBounds(bounds: PreviewBounds): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  focus(): Promise<void>;
  close(): Promise<void>;
}

export function getOrCreatePreviewSession(id: string): PreviewSession;
export function disposePreviewSession(id: string): Promise<void>;
export function disposePreviewSessions(ids: string[]): Promise<void>;
export function hideAllPreviewSessions(exceptId?: string): Promise<void>;
```

Back each session with one promise queue. Every enqueued closure captures the
current generation and returns without IPC when the session was closed or its
generation changed. `ensure` calls `previewCreate` once and retries only after
a rejected create. `setVisible(true)` first hides every other registry entry;
`setVisible(false)` is idempotent. `close` marks the session closed and
increments its generation, appends an unguarded `previewClose(id)` after the
existing queue (so prior guarded operations become no-ops), removes the map
entry in `finally`, and never allows a stale bounds/show call to follow it.

- [ ] **Step 5: Run frontend and backend contract verification**

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: TypeScript payloads and Rust serde shapes compile with no casing or
union errors.

- [ ] **Step 6: Commit the frontend foundation**

```bash
git add src/lib/ipc.ts src/lib/previewUrl.ts src/lib/previewSessions.ts src/lib/zoom.ts
git commit -m "feat: add preview session client"
```

---

### Task 4: Workspace-owned tab lifecycle and React overlay coordination

**Files:**
- Create: `src/lib/nativeOverlays.ts`
- Modify: `src/stores/editor.ts:23-178`
- Modify: `src/stores/workspaces.ts:1-180`
- Modify: `src/stores/ui.ts:1-105`
- Modify: `src/components/ContextMenu.tsx:8-31`
- Modify: `src/components/TaskPicker.tsx:7-35`
- Modify: `src/components/QuickOpen.tsx:7-77`
- Modify: `src/components/SettingsModal.tsx:10-30,335-370`

**Interfaces:**
- Consumes: session disposal from Task 3.
- Produces: `PreviewTab`, `openPreview`, `setPreviewUrl`, `setPreviewOrientation`.
- Produces: `nativeOverlayDepth`, `pushNativeOverlay`, `popNativeOverlay` in `UiState`.
- Produces: `useNativeOverlay()`.

- [ ] **Step 1: Extend the editor tab union and actions**

Add:

```ts
export type PreviewOrientation = "portrait" | "landscape";
export interface PreviewTab {
  id: string;
  kind: "preview";
  title: string;
  preview: { url: string; orientation: PreviewOrientation };
}
```

Include `PreviewTab` in `Tab`, and add these state methods:

```ts
openPreview: (url: string, title?: string) => void;
setPreviewUrl: (id: string, url: string) => void;
setPreviewOrientation: (id: string, orientation: PreviewOrientation) => void;
```

`openPreview` always generates `preview:${crypto.randomUUID()}`, appends a
portrait tab, activates it, and calls `revealEditor()`. The default title is
`new URL(url).host`. The two setters update only the matching preview tab.
When `closeTab` finds a preview, call `void disposePreviewSession(id)` before
removing it; preview tabs never enter `dirty`.

- [ ] **Step 2: Tear down previews before workspace removal**

In `closeWorkspace`, collect preview IDs and await cleanup before the Zustand
workspace removal:

```ts
const previewIds = ws.editor.getState().tabs
  .filter((tab): tab is PreviewTab => tab.kind === "preview")
  .map((tab) => tab.id);
await disposePreviewSessions(previewIds);
```

Keep PTY and LSP cleanup unchanged. No preview metadata is added to
`saveSession`, so relaunch restores repositories but not editor preview tabs.

- [ ] **Step 3: Add reference-counted native overlay state**

Add `nativeOverlayDepth: 0` and actions that increment and clamp decrement at
zero. Implement the hook:

```ts
export function useNativeOverlay(): void {
  useEffect(() => {
    useUiStore.getState().pushNativeOverlay();
    return () => useUiStore.getState().popNativeOverlay();
  }, []);
}
```

Call `useNativeOverlay()` once at the top of mounted `ContextMenu`,
`TaskPicker`, `QuickOpen`, and `SettingsModal`. The counter, rather than a
boolean, keeps StrictMode and nested overlay unmount order correct.

- [ ] **Step 4: Build and inspect lifecycle call sites**

```bash
pnpm build
rg -n "disposePreview|nativeOverlayDepth|useNativeOverlay" src
```

Expected: build passes; the output shows tab close, workspace close, and all
four global overlay families.

- [ ] **Step 5: Commit tab ownership and overlays**

```bash
git add src/lib/nativeOverlays.ts src/stores/editor.ts src/stores/workspaces.ts src/stores/ui.ts src/components/ContextMenu.tsx src/components/TaskPicker.tsx src/components/QuickOpen.tsx src/components/SettingsModal.tsx
git commit -m "feat: own preview tabs by workspace"
```

---

### Task 5: Local server picker and editor entry points

**Files:**
- Create: `src/components/PreviewPicker.tsx`
- Create: `src/components/PreviewPicker.css`
- Modify: `src/components/EditorArea.tsx:7-269`
- Modify: `src/components/EditorArea.css:7-125`
- Modify: `src/components/icons.tsx`

**Interfaces:**
- Consumes: `previewServers`, `normalizePreviewInput`, `openPreview`, `useNativeOverlay`.
- Produces: `PreviewPicker({ workspace, onClose })`.
- Produces editor-strip and empty-state Open Preview actions.

- [ ] **Step 1: Add shared preview glyphs**

Add static icons through the existing `Svg` wrapper: `IcBrowser` (window with
address dots), `IcPhone` (rounded handset rectangle), `IcRotate`, `IcBack`,
`IcForward`, and `IcExternal`. Do not add inline SVG to picker or pane files.

- [ ] **Step 2: Implement picker data loading and manual validation**

The picker state is:

```ts
const [input, setInput] = useState("");
const [servers, setServers] = useState<PreviewServer[] | null>(null);
const [error, setError] = useState<string | null>(null);
const [refreshNonce, setRefreshNonce] = useState(0);
```

On mount and refresh, call `previewServers(workspace.path)` with a disposed
flag so stale scans cannot set state. Call `useNativeOverlay()` while mounted.
Submit manual input only when `normalizePreviewInput(input)` is non-null;
otherwise show `Enter a localhost HTTP or HTTPS URL` inline.

Group strictly by `server.projectMatch`. Render every returned server with:

- primary label: `framework ?? process ?? "Local server"`;
- canonical URL and optional PID;
- working directory when present; and
- one click that calls
  `workspace.editor.getState().openPreview(server.url, label)` then closes.

Discovery errors render above the list and leave the manual form enabled.
Escape and backdrop close the picker; keyboard events stop propagation so
global workspace/tab shortcuts do not run underneath it.

- [ ] **Step 3: Add editor entry points**

In `EditorArea`, own `previewPickerOpen`. Add an `IcPlus` button after the tab
items inside `.editor-tabs`, with title `Open Preview`. In `EmptyState`, add a
small primary action labeled `Open Preview…`; pass the same opener into the
empty state rather than reaching through global state.

Extend tab tooltip/icon discrimination so preview tabs use `tab.preview.url`
and `IcBrowser`; preserve existing file/diff/memory branches. Render
`PreviewPicker` as a sibling of the tab menu.

- [ ] **Step 4: Style the picker and tab-strip add action**

Reuse the QuickOpen visual language: fixed transparent backdrop at z-index
100, top-centered 560 px panel, `.text-input`, bounded scroll list, group
headings, selected-row hover, dim URL/cwd metadata, inline error, and refresh
icon. Add a fixed-width `.editor-tab-add` that does not inherit the normal
110 px tab minimum.

- [ ] **Step 5: Build and verify session-only tab creation**

```bash
pnpm build
git diff --check
```

Then in `pnpm tauri dev`, open two copies of the same manually entered URL and
verify two independent preview tab IDs appear in React DevTools/Zustand. Close
and reopen the repository and verify preview tabs are absent.

- [ ] **Step 6: Commit the picker**

```bash
git add src/components/icons.tsx src/components/PreviewPicker.tsx src/components/PreviewPicker.css src/components/EditorArea.tsx src/components/EditorArea.css
git commit -m "feat: add localhost preview picker"
```

---

### Task 6: Interactive phone pane and native bounds synchronization

**Files:**
- Create: `src/components/PreviewPane.tsx`
- Create: `src/components/PreviewPane.css`
- Modify: `src/components/EditorArea.tsx:206-269`
- Modify: `src/App.tsx:140-175,330-350`

**Interfaces:**
- Consumes: `PreviewTab`, preview session registry, IPC load/external events, `openUrl`, `currentZoom`, `onZoomChange`, overlay depth, and panel-maximized state.
- Produces: `PreviewPane({ tab, workspaceVisible })`.
- Changes: `EditorArea({ workspaceVisible })` and `WorkspaceEditor({ visible })` pass explicit visibility to the native layer.

- [ ] **Step 1: Build the phone-pane DOM and toolbar**

`PreviewPane` renders:

```tsx
<div className="preview-pane">
  <div className="preview-toolbar">{/* back, forward, reload, URL, external, rotate */}</div>
  <div className={`preview-stage ${orientation}`}>
    <div className="preview-device">
      <div ref={hostRef} className="preview-native-host" />
    </div>
  </div>
</div>
```

Keep toolbar controls in the main React webview. URL submission uses
`normalizePreviewInput`; on success call session `navigate` and
`setPreviewUrl`. Back, Forward, and Reload call their fixed session methods.
Open External calls existing `openUrl(tab.preview.url)`. Rotate toggles the
store orientation.

Listen to `preview-load` for the matching ID: update local loading state and
commit the emitted loopback URL to the tab on Started. Install one module-level
`preview-external` listener that calls `openUrl` only after confirming the
event ID still exists in a workspace preview tab.

- [ ] **Step 2: Implement authoritative bounds synchronization**

Use one coalesced function:

```ts
const syncBounds = () => {
  cancelAnimationFrame(frame.current);
  frame.current = requestAnimationFrame(() => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const zoom = currentZoom();
    const bounds = {
      x: rect.left * zoom,
      y: rect.top * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
    if (!visibleRef.current) {
      void session.setVisible(false);
      return;
    }
    void session.ensure(tab.preview.url, bounds)
      .then(() => session.setBounds(bounds))
      .then(() => session.setVisible(visibleRef.current));
  });
};
```

Trigger it from a `ResizeObserver(host)`, `window.resize`, `onZoomChange`,
orientation changes, and visibility changes. Cancel the frame and observers
on unmount, but do not close the session; inactive tab unmounts must preserve
its page state.

`shouldShow` is exactly:

```ts
workspaceVisible && !panelMaximized && nativeOverlayDepth === 0
```

Mirror `shouldShow` into `visibleRef.current` on every render so an async create
cannot reveal the child view after an overlay opens or workspace switch. When
false, hide immediately rather than waiting for a resize. On pointer down
inside the device frame, call `session.focus()`.

- [ ] **Step 3: Pass workspace visibility through the mounted workspace tree**

Change:

```tsx
function WorkspaceEditor({ visible }: { visible: boolean }) {
  return (
    <div
      className="workspace-editor"
      style={{ display: visible ? undefined : "none" }}
    >
      <EditorArea workspaceVisible={visible} />
    </div>
  );
}
```

Change `EditorArea` to accept that prop and pass it only to active
`PreviewPane`. The active PreviewPane in a hidden workspace stays mounted but
hides its native child view.

- [ ] **Step 4: Style real viewport dimensions without CSS scaling**

The stage centers the device and clips overflow. Portrait device size is:

```css
.preview-stage.portrait .preview-device {
  width: min(390px, calc(100% - 32px));
  height: min(844px, calc(100% - 32px));
}
.preview-stage.landscape .preview-device {
  width: min(844px, calc(100% - 32px));
  height: min(390px, calc(100% - 32px));
}
```

Use no transform scaling and no rounded clipping over the native view. Give
the device an opaque border/background; the empty host and native view occupy
the same full rectangle. Loading is indicated in the toolbar, not as an
overlay over the child WKWebView. Creation/control failure hides the native
view and replaces the host with a DOM error card whose Retry clears error and
runs `syncBounds`.

- [ ] **Step 5: Build and perform focused native-view checks**

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

In `pnpm tauri dev`, use a known local HTTP server and verify:

1. page clicks, typing, scrolling, HMR, back/forward/reload;
2. portrait/landscape swaps actual CSS viewport dimensions;
3. app zoom keeps native bounds aligned;
4. sidebar, panel, maximize, and window resize keep alignment;
5. editor tab and workspace switches preserve page state but hide inactive
   native views;
6. PreviewPicker, QuickOpen, TaskPicker, Settings, and ContextMenu cover the
   editor without the native view painting above them; and
7. closing a tab removes its `preview:` label from Tauri's webview list.

- [ ] **Step 6: Commit the interactive pane**

```bash
git add src/components/PreviewPane.tsx src/components/PreviewPane.css src/components/EditorArea.tsx src/App.tsx
git commit -m "feat: render interactive phone previews"
```

---

### Task 7: Documentation and end-to-end VFF verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Verify: all files changed by Tasks 1-6

**Interfaces:**
- Consumes: complete feature from Tasks 1-6.
- Produces: documented user workflow and final verification evidence.

- [ ] **Step 1: Document the feature and architecture**

Add a README feature section explaining:

- `+` → **Open Preview…**;
- manual localhost entry and detected-server groups;
- one session-only preview tab per invocation;
- portrait/landscape, navigation, and reload;
- Expo projects must run their web target (`expo start --web`); and
- native-only behavior still requires Simulator or a device.

Update the CLAUDE architecture map for `preview.rs`, `previewSessions.ts`,
`PreviewPicker.tsx`, and `PreviewPane.tsx`. Update the editor-store and
EditorArea rows to include the `preview` tab kind and native-view visibility
discipline. Document the `main` label guard in `main.rs` so future page-load
cleanup cannot regress.

- [ ] **Step 2: Run the complete automated verification suite**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm build
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 3: Verify discovery and previews against the VFF monorepo**

In separate integrated terminals rooted at
`/Users/kevin/repos/vff/vff-mono-repo`, run:

```bash
pnpm dev
pnpm --filter @vff/mobile web
```

Open the VFF repository as the active IDE workspace and verify both servers
appear under **Current Project**, with Next.js and Expo Web labels when their
process/response signatures are available. Start any unrelated plain HTTP
server outside VFF and verify it appears under **Other Local Servers**. Confirm
manual entry remains usable after stopping all detected servers.

- [ ] **Step 4: Run the lifecycle regression matrix**

Verify duplicate URLs, several workspaces, file/diff/memory/preview switching,
server stop/restart with Reload, external-link routing, zoom levels 0.5/1/2,
portrait/landscape, panel maximize, all global overlays, preview tab close,
workspace close, and application quit/relaunch. Confirm PTYs and LSPs remain
alive when preview pages navigate or reload. Confirm no preview tab restores
after relaunch.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md CLAUDE.md
git commit -m "docs: explain localhost phone previews"
```

- [ ] **Step 6: Record final repository evidence**

```bash
git status --short
git log --oneline -7
```

Expected: only pre-existing unrelated user changes remain, and the feature is
represented by the focused commits from Tasks 1-7.
