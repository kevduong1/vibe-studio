# Native localhost previews

Talos renders each responsive localhost preview in a native child WKWebView.
The React editor pane owns its tab and toolbar, `src/lib/previewSessions.ts`
serializes native operations, and `src-tauri/src/preview/webviews.rs` owns the
view and its browser policy.

## State and lifetime

Preview tabs and sessions last only for the current app process. React unmounts
hide a native view so page state survives tab and workspace switches; closing a
tab or workspace destroys it. The session registry serializes create,
navigation, bounds, zoom, visibility, focus, reset, and close operations. A
global visibility queue hides every other child preview before showing one,
because native child views sit above the HTML compositor.

The main webview measures the placeholder in zoom-adjusted logical pixels.
Native bounds position the child over that placeholder, while child-page zoom
makes the fitted view expose the requested responsive CSS viewport size.

## Navigation and authentication

User-controlled entry points remain localhost-only: discovery, preview create,
toolbar address submission, and typed navigation IPC all accept credential-free
HTTP(S) URLs on `localhost`, `127.0.0.1`, or `::1` only.

Once a localhost page is running, page-initiated credential-free HTTP(S)
navigation may leave loopback. This is required for redirect-based OAuth: the
provider loads in the same preview history and can redirect to the local
callback. Page-initiated `about:blank` is admitted only as the exact bootstrap
URL used by clients that reserve an authentication popup before navigating it.

HTTP(S) `window.open` requests use WebKit's native app-owned popup behavior.
The popup shares the requesting WKWebView configuration, preserving its cookie
store, `window.opener`, and `postMessage`, so popup OAuth can report completion
to the localhost app. The popup is a browser surface, not a second Talos
frontend, and closes independently (including provider-driven `window.close`).

Rejected non-web protocols are sent to the main frontend as
`preview-external`; it verifies that a live preview tab still owns the supplied
ID before calling the scheme-whitelisted external URL opener. The toolbar's
explicit external button always opens the current URL in the default browser.

## Privacy and failure boundaries

The only capability manifest targets the `main` webview. Preview labels and
native popup content match no capability, so neither localhost nor remote
preview pages receive Tauri IPC access. Allowing a remote authentication page
does not expand its filesystem, terminal, Git, dialog, or event permissions.

Preview IDs must be generated `preview:<uuid>` labels. Initial URLs and direct
IPC navigation are validated again in Rust; remote pages cannot be created
through those commands. Invalid bounds, missing native views, or failed native
operations surface as a hidden-view error card. Retry closes any possibly stale
same-ID view before recreating it, and app exit closes every tracked preview.
