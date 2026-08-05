# Localhost Phone Preview Design

## Summary

Add interactive, phone-sized localhost previews as editor tabs. Each preview
belongs to the workspace that was active when it was opened and owns a native
Tauri child WKWebView. Preview tabs remain alive while their workspace is open
in the current application session, but they are not restored after relaunch.

The feature targets web-capable development servers such as Next.js, Expo Web,
and Vite. It does not emulate native iOS APIs or embed Apple Simulator.

## Goals

- Open a localhost web application in an interactive phone-sized editor tab.
- Open multiple independent preview tabs, including duplicate URLs.
- Keep each preview and its browser state bound to its owning workspace.
- Discover all reachable localhost HTTP development servers, ranking servers
  associated with the active workspace first.
- Support manual URL entry as the reliable fallback.
- Provide basic browser navigation and portrait/landscape controls.
- Preserve page state while switching tabs or workspaces during the session.
- Prevent preview pages from receiving Tauri privileges.

## Non-goals

- Embedding or controlling Apple Simulator.
- Emulating native iOS APIs in the web preview.
- Starting, stopping, or configuring development servers.
- Persisting preview tabs across application restarts.
- A catalog of named device presets or pixel-perfect device chrome.
- Remote-site browsing or complete OAuth flows that navigate away from
  localhost.
- A general-purpose browser with downloads, bookmarks, or extension support.

## User Experience

### Opening a preview

The editor tab strip gains a `+` button. Its menu contains **Open Preview…**.
The editor empty state exposes the same action so a preview can be the first
tab in a workspace.

The preview picker contains:

- a text field for a localhost URL or port;
- a refresh button;
- a **Current Project** server group; and
- an **Other Local Servers** group.

Manual input accepts forms such as `3000`, `localhost:3000`,
`http://127.0.0.1:3000/path`, and HTTPS loopback URLs. Inputs without a scheme
use HTTP. Only `localhost`, `127.0.0.1`, and `[::1]` are valid top-level preview
hosts.

Selecting a server or submitting a URL always creates a new preview tab in the
currently active workspace. Duplicate URLs are allowed and own independent
tabs and WKWebViews.

### Preview tab

The tab uses a browser/phone glyph and derives its initial title from the
server label when one is available, otherwise from the host and port. The tab
has a stable generated ID that does not change as browser history changes.

The preview toolbar contains:

- Back
- Forward
- Reload
- Editable URL
- Open in Default Browser
- Portrait/Landscape toggle

Back and Forward are safe no-ops when their corresponding history entry does
not exist. Submitting the address navigates the current preview rather than
opening another tab.

### Phone frame

The screen is centered in the available editor area. Portrait uses a target
size of 390 by 844 logical points, clamped independently to the available
width and height. Landscape uses the swapped 844 by 390 target with the same
clamping. The actual WKWebView viewport always matches the displayed screen
rectangle, so CSS media queries observe the visible dimensions.

The first version uses a restrained rectangular phone frame rather than
pixel-perfect hardware chrome. No CSS overlay is placed above the child
WKWebView because native child views have their own stacking layer.

### Lifetime

- Switching editor tabs hides the inactive preview without unloading it.
- Switching workspaces hides all previews owned by the inactive workspace.
- Returning to a preview restores the same live WKWebView and page state.
- Closing a preview tab destroys its WKWebView.
- Closing a workspace destroys all of that workspace's preview WKWebViews.
- Quitting the IDE destroys all previews, and session restore does not recreate
  preview tabs.

## Architecture

### Editor state

Extend the per-workspace `Tab` union in `src/stores/editor.ts` with a preview
variant containing:

```ts
interface PreviewTab {
  id: string;
  kind: "preview";
  title: string;
  preview: {
    url: string;
    orientation: "portrait" | "landscape";
  };
}
```

The store adds `openPreview`, `setPreviewUrl`, and `setPreviewOrientation`.
`openPreview` generates a fresh ID for every invocation. Existing close and
active-tab behavior remains shared across all tab kinds. Preview tabs never
participate in dirty-file confirmation.

Workspace disposal explicitly closes preview sessions before removing the
workspace. Editor session restoration, if later added for other tab kinds,
must continue to omit preview tabs unless this design is revisited.

### React components

`EditorArea` lazy-loads a `PreviewPane` for an active preview tab.
`PreviewPane` owns only DOM UI: the toolbar, device frame, creation/control
errors, loading state, and an empty host element marking the desired
native-view rectangle.

A `ResizeObserver` watches the screen host. Bounds updates are also triggered
by orientation changes, application zoom, window resize, sidebar resize,
bottom-panel resize/maximize, and workspace visibility changes. Updates are
coalesced to one animation frame.

The host's `getBoundingClientRect()` values are CSS pixels. The preview manager
converts them back to window logical coordinates with the existing
`currentZoom()` factor before sending bounds to Tauri. This is the inverse of
the coordinate conversion already used for native terminal file drops.

Native child webviews render above the main React WKWebView. The manager shows
only the active preview and hides it whenever:

- its tab is inactive;
- its workspace is inactive;
- the editor area is covered by the maximized bottom panel; or
- a global modal or picker that can overlap the preview is open.

Context menus that originate outside the preview cannot overlay a visible
child webview. Any such overlay state must use the same temporary-hide path.

### Frontend preview manager

Add a framework-independent registry in `src/lib/previewSessions.ts`, keyed by
preview tab ID. It mirrors the terminal-session lifetime pattern without
owning a webview directly. A session serializes typed IPC calls for create,
navigate, history, reload, bounds, visibility, focus, and close operations.

The registry guarantees:

- at most one native webview per preview tab ID;
- stale async create/bounds operations cannot resurrect a closed session;
- hide/show calls are idempotent;
- only one session is visible at a time; and
- close removes the registry entry even when native cleanup reports an error.

### Rust preview module

Add `src-tauri/src/preview.rs`. It owns native webview creation and lookup and
exposes commands through the typed IPC contract in `src/lib/ipc.ts`:

- `preview_servers(workspace_path)`
- `preview_create(id, url, bounds)`
- `preview_navigate(id, url)`
- `preview_back(id)`
- `preview_forward(id)`
- `preview_reload(id)`
- `preview_set_bounds(id, bounds)`
- `preview_set_visible(id, visible)`
- `preview_focus(id)`
- `preview_close(id)`
- `preview_close_many(ids)`

The Rust implementation creates child webviews on the main application window
using stable labels derived from preview IDs. Creation starts hidden until the
first authoritative bounds and visibility update have completed.

Navigation and page-load hooks validate top-level destinations and emit typed
events to the main webview for URL and load-phase updates. Preview pages are
remote content and receive no Tauri capability scope or custom IPC authority.

Subresources remain unrestricted so localhost applications can load remote
APIs, scripts, images, fonts, and WebSockets. A top-level navigation away from
loopback is cancelled and opened in the default system browser instead. This
means remote OAuth navigation is explicitly outside the first version's scope.

## Local Server Discovery

Discovery runs only when the picker opens or the user presses Refresh. It does
not poll in the background.

On macOS, the Rust module:

1. Enumerates listening TCP sockets and their PIDs with `lsof`.
2. Deduplicates IPv4/IPv6 listeners by port and process.
3. Reads each process's command line and working directory.
4. Performs short, bounded localhost HTTP probes concurrently.
5. Drops listeners that do not respond as HTTP servers.
6. Assigns best-effort framework labels from command lines, response headers,
   response HTML, and working-directory package metadata.
7. Marks a server as a project match when its process working directory is the
   active workspace path or a descendant of it.
8. Sorts project matches first, then remaining servers by port.

Each result contains the canonical URL, port, PID when available, process
name, working directory when available, optional framework label, and project
match flag.

Framework detection is presentational only. Unknown HTTP servers remain
selectable. Failures to inspect one process or probe one port do not fail the
whole scan. If discovery itself fails, the picker presents a concise warning
and keeps manual URL entry enabled.

The discovery target is plain localhost HTTP, which covers the intended
Next.js, Expo Web, and Vite workflows. HTTPS localhost URLs remain available
through manual entry; automatic TLS probing is not required in the first
version.

## Security

- Validate and normalize preview URLs in both TypeScript and Rust; Rust is the
  authority before create or navigate.
- Permit only HTTP and HTTPS top-level URLs with loopback hostnames or
  addresses.
- Never interpolate user input into a shell command. Server enumeration uses
  fixed command arguments and parses output as data.
- Do not grant remote URLs any Tauri capability scope.
- Use a navigation hook to prevent redirects from silently turning a trusted
  localhost preview into privileged remote content.
- Emit rejected external top-level destinations to the main webview, which
  opens them through the existing scheme-whitelisted system-browser path.
- Keep server probes short and bounded so a hostile or stalled local listener
  cannot freeze the async runtime that also serves terminals.

## Error Handling

- Invalid manual input is rejected inline without creating a tab.
- A discovery error does not disable manual entry.
- Webview creation failure leaves the preview tab open with a Retry action.
- A load or connection failure uses WKWebView's native failure page; the DOM
  toolbar remains available and Reload retries the same URL.
- If a development server stops, the tab remains open. Restarting the server
  and pressing Reload recovers it.
- Bounds, hide, focus, and close commands tolerate already-closed views.
- Asynchronous frontend operations carry a session generation so completion
  from an old tab instance cannot mutate a replacement or closed session.
- Application shutdown closes every preview as part of normal child-resource
  teardown.

## Verification

### Automated

Rust unit tests cover:

- URL normalization and loopback validation, including IPv6;
- rejection of non-HTTP schemes and non-loopback hosts;
- listener parsing and IPv4/IPv6 deduplication;
- process working-directory matching against the workspace root;
- stable server sorting;
- framework-label heuristics; and
- partial inspection/probe failures.

The frontend must pass the existing TypeScript and production build. No new
JavaScript test framework is introduced solely for this feature.

### Manual

Use `/Users/kevin/repos/vff/vff-mono-repo` as the primary compatibility
fixture:

- run the Next.js dashboard with `pnpm dev`;
- run Expo Web with `pnpm --filter @vff/mobile web`;
- confirm both appear under Current Project with useful labels;
- confirm unrelated localhost HTTP servers appear under Other Local Servers;
- open multiple and duplicate preview tabs;
- verify HMR and interaction inside visible previews;
- verify back, forward, reload, address navigation, and external-link routing;
- stop and restart each development server and recover with Reload;
- rotate portrait/landscape;
- resize the window, sidebar, and bottom panel;
- change whole-application zoom;
- maximize and restore the bottom panel;
- open global dialogs, pickers, and context menus over the editor;
- switch among preview, file, diff, and memory tabs;
- switch among workspaces;
- close preview tabs and workspaces; and
- quit and relaunch to confirm preview tabs do not restore.

After tab and workspace cleanup, verify preview labels are absent from Tauri's
live webview list and no hidden native views remain interactive.

## Compatibility Notes

In the VFF monorepo, the dashboard's `next dev` server is directly previewable.
The mobile project's normal `expo start` command serves Metro for native
clients; the phone preview requires its web target, provided by the existing
`expo start --web` script. Native-only modules and behaviors still require an
iOS or Android simulator or physical device.
