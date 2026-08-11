# CLAUDE.md

Vibe Studio — a Tauri 2 macOS desktop app: multi-repo workspaces (titlebar tab
switcher), git source control (status, staging, commit/amend/push, stashes,
commit graph), integrated split terminals (portable-pty + xterm.js), a global
drag-and-drop agent-terminal dock, a CodeMirror 6 diff viewer/editor, and
TypeScript/Python LSP support (squiggles, hover, completion, go-to-def; off
at every launch — opt-in per session via the status-bar LSP button or the
⌘, settings modal). Rust backend in `src-tauri/`, React 19 + TypeScript
frontend in `src/` (Vite, zustand). Vitest covers pure frontend state and
detection logic; the Rust backend has focused unit tests, while final GUI
behavior still requires manual verification. All agents should also follow
`AGENTS.md`. Semantic terminal-agent architecture is documented in
`docs/architecture/agent-runtime.md`.

## Architecture map

| File | Responsibility |
|---|---|
| `src/lib/ipc.ts` | Typed IPC contract — single source of truth for command names and payload shapes |
| `src/lib/status.ts` | Shared status-code helpers: `statusLetter`, `statusColor`, `statusPaths` (renames span two paths!) |
| `src/lib/path.ts` | Shared POSIX-path helpers (`basename`, `dirname`, `isMarkdownPath`) — import these, don't redefine per file |
| `src/lib/fuzzy.ts` | Hand-rolled two-phase fuzzy matcher for quick open: O(n) subsequence reject over the whole list, then a scoring DP (boundary/camelCase/basename/consecutive bonuses) returning matched positions for highlighting |
| `src/lib/graphLayout.ts` | Pure lane-layout algorithm for the commit graph (algorithm documented in-file) |
| `src/lib/agentState.ts` | Pure semantic agent model: occupancy/lifecycle/authority types, derived display state, rollup priority, labels/tooltips, and notification-edge selection |
| `src/lib/agentProfiles.ts` | Independently authored Claude/Codex screen-detection profiles; bounded near-tail rules for blocked/working/idle evidence |
| `src/lib/terminalActivity.ts` | Generic lifecycle fallback for dedicated agent terminals: sustained output, BEL/OSC 9/777 notifications, quiet completion, and OSC 133/633 shell marks |
| `src/lib/termSession.ts` / `trackedCommand.ts` | Framework-free xterm+PTY session (attach/detach reparenting; ONLY `dispose()` kills the PTY); semantic screen inspection/acknowledgement, `XTERM_THEME`, and the multiline nonce-bound check-command wrapper live here |
| `src/lib/termSessions.ts` | Session registry for ALL dock terminals (`getOrCreateSession`/`getSession`/`disposeSession`) — sessions outlive React unmounts |
| `src/lib/agentSessions.ts` / `agentLaunchProgram.ts` / `agentCheckpointPrompt.ts` | Global-agent glue on the registry: semantic metadata, close paths, setup-before-baseline plus launch-shell environment, shared raw-Enter checkpoint handling, and intentional `claude`/`codex --yolo` launch defaults; restored layouts intentionally remain fresh shells |
| `src/lib/agentPromptQueue.ts` | Session-only, 8,192-character-bounded prompt queue pinned to terminal occupant generations; queue waits for safe input, steer is explicit, and both checkpoint isolated-task state before sending |
| `src/lib/agentControlPlane.ts` | Frontend half of the authenticated local control plane: semantic snapshot sync plus generation-checked focus/prompt/start routing; see `docs/architecture/agent-control.md` |
| `src/lib/nativeAgentSessions.ts` | Unambiguous isolated-Codex native-thread capture on semantic process/turn edges; stores only an opaque task reference |
| `src/lib/editorAgentContext.ts` | Safe same-project routing for bounded editor selection/file/diff context into an idle/question-owned agent prompt |
| `src/lib/agentNotifications.ts` | Opt-in semantic blocked/Done alerts for both docks; one banner ID per terminal, shared sound/banner settings, edge-triggered delivery, and acknowledgement/resume/exit/close/disable dismissal |
| `src/lib/workspaceSessions.ts` | Workspace terminal glue on the registry, including dedicated-agent semantic metadata, the intentional `codex --yolo` default, and launch/close paths |
| `src/lib/termFileDrop.ts` | Native file drops onto terminal panes (both docks) paste shell-quoted paths: Tauri webview drag-drop events (the DOM never sees native drags) → pane hit-test → `term.paste()` (bracketed paste is how Claude Code detects image paths). Drag positions are LOGICAL px despite the PhysicalPosition type (macOS wry quirk, documented in-file) — never divide by devicePixelRatio, but DO divide by `currentZoom()` (page zoom shrinks the CSS viewport) |
| `src/lib/previewSessions.ts` | Session-only registry for native localhost preview child webviews: per-preview serialized create/navigation/bounds/zoom/close operations, a global visibility coordinator that hides peers before showing one native view, and explicit disposal ownership so React unmounts only hide while tab/workspace close destroys; fitted device presets/custom dimensions use child-page zoom so responsive CSS sees the requested viewport size |
| `src/lib/zoom.ts` | Whole-app zoom (⌘+/⌘−/⌘0, App.tsx): browser-style step list applied via webview `setZoom` (WKWebView.pageZoom — layout-reflowing, so terminals refit via their ResizeObservers), localStorage-persisted, restored by `initZoom()`; `currentZoom()` feeds termFileDrop's coordinate mapping |
| `src/lib/tasks.ts` | VS Code-compatible `.vscode/tasks.json` model: JSONC parse + diagnostics, compound/dependency metadata, `${var}` substitution, and shell command-line assembly |
| `src/lib/taskRunner.ts` | Task execution glue: types the assembled command into a workspace dock terminal (reused per `presentation.panel` shared/dedicated/new; ^C first on reuse), reveals per `presentation.reveal` |
| `src/lib/checkPipelines.ts` / `pipelineModel.ts` | Agent review-check DAG validation/execution: reachable-only validation, parallel/sequential dependencies, fresh reserved terminals, pre/post fingerprint + one formatter rerun, nonce-bound exit evidence, revocable trust-gated autorun, and bounded history |
| `src/lib/agentInbox.ts` | Shared exact-terminal focus router for inbox rows, attention cycling, check nodes, and typed notification activations |
| `src/lib/isolatedTasks.ts` / `src/stores/isolatedTasks.ts` | Persistent isolated-worktree task lifecycle: setup/ignored-file/port policy, terminal ownership, archive/merge/keep/remove safety, explicit task-record deletion with parent-plan reference pruning, native Codex restore, and dependency-aware queue/steer/worktree/Best-of-N plans; see `docs/architecture/isolated-agent-tasks.md` |
| `src/lib/dockTree.ts` | Pure dock layout-tree model shared by both docks: split/group types, `normalize()` invariants, move/split/resize state ops, persistence sanitizer |
| `src/lib/lsp/` | LSP client service, layered and framework-free below cmLsp (a future IDE MCP server consumes the same API): `servers.ts` is the ONLY entry point (WorkspaceLsp facade registry keyed by workspace root — lazy per-language server start that follows the ACTIVE workspace (background/idle auto-stop with doc replay on resume), diagnostics store, crash policy, `getLspForFile` editor gate) → `client.ts` (JSON-RPC correlation + lifecycle + incremental didChange coalescing — the protocol brain) → `transport.ts` (IPC glue) → `lsp.rs`. `settings.ts` = session-scoped master mode (`LspMode` Disabled \| Dynamic — every launch starts Disabled, never persisted; ANDed into `isLanguageEnabled` so all gates + the change fan-out inherit it) over persisted `vibe-studio:lsp` per-language toggles + `LSP_LANGUAGES` UI metadata; `types.ts` = wire types + `serverLangForPath`; `uri.ts` = path↔file:// (NEVER concat URIs elsewhere); `markdown.ts` = sanitized hover/doc renderer (textContent only; fenced blocks async-highlighted via lazy language-data load + oneDarkHighlightStyle classes); `cmLsp.ts` = the CodeMirror bundle (doc-sync ViewPlugin, squiggles via `setDiagnostics` push, hover, completion override, ⌘-click/F12 go-to-def) |
| `src/lib/markdownDoc.ts` | Full-document markdown → DOM renderer for the preview (MarkdownPreview.tsx): @lezer/markdown GFM parse tree walked with createElement/textContent ONLY (lsp/markdown.ts discipline — raw HTML renders inert, no sanitizer dep). Links are `data-href`, never real hrefs (the webview must never navigate); images are placeholders (CSP allows no image sources); fenced code reuses lsp/markdown's `highlightInto` and mounts the oneDark token classes itself (style-mod) since no editor view may exist yet |
| `src/lib/cmChangeRuler.ts` | Overview ruler shared by Editor + DiffViewer: a ViewPlugin overlays the editor's scrollbar with change blips (add green / del red / mod blue, `--ruler-*` vars) positioned via the HEIGHT MAP (lineBlockAt — line-proportional math breaks under collapseUnchanged/widgets) and doubling as a scrubber (pointer drag = absolute jump; the native thumb beneath is the viewport indicator). Two mark sources: `changeRuler("merge")` follows merge chunks (both diff modes + both split sides); `changeRuler("field")` + `setRulerMarks`/`computeRulerMarks` for the file editor, whose Editor.tsx glue diffs the LIVE doc against a git HEAD baseline (the "staged" diff kind's old side — an index baseline would blank the ruler the moment a file is staged; untracked/ignored files get no ruler) |
| `src/lib/projectColors.ts` | Per-project palette-index assignment (auto on first ask; user-set via `setProjectColorIndex`, localStorage-persisted) — render through the reactive `useProjectColorIndex`/`useProjectColorVar` hooks; feeds tab/badge tints and the app-wide `--accent` override |
| `src/lib/projectNames.ts` | Cosmetic per-project display names (user-set via `setProjectDisplayName`, localStorage-persisted; folder-basename fallback) — render through the reactive `useProjectDisplayName(s)` hooks; purely visual, nothing path-based ever sees them |
| `src/lib/clipboard.ts` | Shared `copyText` (navigator.clipboard + execCommand fallback, no plugin) — GitGraph copy-SHA, Titlebar copy-path |
| `src/stores/workspaces.ts` | Workspace registry: one workspace per open repo (own repo/editor/terminal/search stores), open/close/setActive, session restore, `switchToProject` (agent-terminal navigation), `WorkspaceContext` + `useWorkspace`/`useRepo`/`useEditor`/`useTerminal`/`useSearch` hooks |
| `src/stores/repo.ts` | Per-workspace repo store factory: status/log/stashes, git mutations (return `Promise<boolean>`), log branch filter (`logFilter`/`setLogFilter`), watcher wiring (`init`/`dispose`), status-bar `error` |
| `src/stores/editor.ts` | Per-workspace editor-tab store factory (`Tab = file \| diff \| memory \| preview`), dirty tracking, session-only preview creation/orientation plus teardown ownership (`pendingPreviewDisposals` survives tab removal until native close succeeds), `closeTabSafely(store, id)` / batch `closeTabsSafely` (confirm unsaved), `openFile(path, at?)` + nonce-gated `reveal` request (cursor-to-line, consumed by Editor.tsx), `retargetFileTabs(from, to)` (explorer renames/moves — drops dirty flags, drafts die with the old tab id) |
| `src/stores/search.ts` | Per-workspace search store factory (⌘⇧F state: query/toggles/results); 250 ms debounce + sequence-number stale-result guard live in the store closure |
| `src/stores/terminal.ts` | Per-workspace terminal dock store factory (shell/Claude/Codex tabs, dockTree layout, ephemeral notification toggles, NOT persisted; never touches xterm or IPC) |
| `src/stores/agentRuntime.ts` | One ephemeral semantic runtime store for both docks: registration, occupancy polling, generation-safe transitions, authority fallback, acknowledgement, and workspace/group rollup selectors |
| `src/stores/agentTasks.ts` | Session-only generation-owned task/review store: cheap launch HEAD + async stable fingerprints, sequence-guarded/shared refreshes, runtime reconciliation after frontend hot reload, independent human review/check states, and stable inbox attention age |
| `src/stores/agentTerminals.ts` | GLOBAL terminal-groupings store: any number of named dockTree layouts (`groupings`, one panel tab each; `activeGroupingId`) over ONE shared terminals map, terminal↔project bindings, deletion-aware last-workspace navigation memory, deduped default titles, ephemeral live pane titles (`paneTitle`), per-terminal `notificationsEnabled` opt-in, localStorage persistence (`vibe-studio:agent-terminals`, v3; older layouts migrate on load), and `groupingDockStore(id)` — the cached per-grouping read-only store facade the generic Dock consumes |
| `src/stores/agentDefinitions.ts` | Typed built-in/custom agent definitions and launch profiles; visible `codex --yolo` default, stable definition IDs, command assembly, and restore/folder policy metadata |
| `src/stores/terminalRecipes.ts` | Persisted, user-owned per-workspace terminal commands; restore execution is disabled per recipe unless explicitly enabled |
| `src/stores/ui.ts` | Global (workspace-independent) sidebar/panel visibility, sizes, panel group (`terminal`/`agent`, `useEffectivePanelGroup`), panel maximize (`panelMaximized` — cleared by hiding the panel or opening an editor tab), markdown-preview toggle (`markdownPreview` — app-wide reading mode, not per-tab) |
| `src/App.tsx` | Shell layout, per-workspace `WorkspaceView`s (all mounted; inactive hidden), global shortcuts (⌘\` ⌘B ⌘⇧B ⌘P ⌘⇧F ⌘W ⌘1–9 ⌘±/⌘0 zoom), welcome screen |
| `src/components/Titlebar.tsx` | Workspace tab strip (switch/close/add; double-click → inline rename; right-click → rename / copy path / project color) + active repo's branch pill and fetch |
| `src/components/icons.tsx` | ALL shared SVG icons (16×16 stroke glyphs) — add new icons here, not inline |
| `src/components/SourceControl.tsx` | SCM panel: stage/unstage/discard, commit (+amend, &push), stashes, commit-graph branch filter dropdown |
| `src/components/GitGraph.tsx` | Hand-rolled virtualized commit list + SVG lane rail (no virtualization deps); ⌘/shift multi-select + right-click menu (checkout, create branch, squash, copy SHA) |
| `src/components/EditorArea.tsx` | Editor tab strip + active pane host (lazy Editor/DiffViewer/MarkdownPreview/MemoryPreview plus native-backed PreviewPane; inactive tabs unmount — drafts survive via Editor.tsx's cache, preview sessions survive and hide); owns the **+** preview-picker entry point and passes workspace visibility into previews; right-click tab menu (Close / Others / to the Right / All via `closeTabsSafely`, plus Copy Path / Relative Path / Reveal in Finder on file tabs); swaps the editor for MarkdownPreview when the ui store's `markdownPreview` is on and the active tab is a .md file |
| `src/components/MarkdownPreview.tsx` | Rendered markdown view (status-bar eye badge toggles it, shown only for .md tabs): renders the unsaved draft when one exists (Editor's `peekDraft`) else disk content, re-renders on repo-changed (250 ms debounce), routes `data-href` link clicks through `open_url`'s scheme whitelist |
| `src/components/Editor.tsx` | CodeMirror file editor + shared CM helpers (theme, languageFor, editKeymap) + unsaved-draft cache + external-change reload |
| `src/components/EditorSearch.tsx` | VS Code-style floating find/replace widget (⌘F, top-right overlay) replacing @codemirror/search's default panel; per-EditorView React root via custom `createPanel`; match counting goes through an escaped-regex twin of literal queries (RegExpCursor ≫ string cursor on big docs); shared by Editor + DiffViewer |
| `src/components/DiffViewer.tsx` | @codemirror/merge split/unified diff; worktree diffs editable (⌘S), auto-refetch on repo change |
| `src/components/Panel.tsx` | Global bottom panel (under the editor column): Project Terminals tab (leftmost) + one tab per global terminal grouping ("+" adds, double-click renames inline, right-click → rename/close with confirm) + per-group actions in one header row; per-workspace terminal docks AND every grouping's dock stay mounted (display:none); maximize toggle (button or header double-click outside grouping tabs) fills the center column |
| `src/components/Dock.tsx` | Generic dockable terminal grid shared by both groups: recursive split/group rendering, per-group tab strips, double-click tab rename, pointer-capture DnD (strip insert caret / 5-zone edge splits), split resizers — flavor injected via `Pane`/`TabIcon`/`TabBadge`/`Empty` props |
| `src/components/TerminalPanel.tsx` | Workspace flavor of Dock: shell and dedicated-agent sessions, semantic icons/text badges/tooltips, ephemeral notification toggle, and auto-first-terminal |
| `src/components/TaskPicker.tsx` | ⌘⇧B quick-pick overlay (filter + arrow/enter keyboard nav); a lone default build task skips it (App.tsx) |
| `src/components/QuickOpen.tsx` | ⌘P fuzzy file picker overlay (TaskPicker pattern); fetches the gitignore-aware file list per open, renders top 100 with match highlighting |
| `src/components/SettingsModal.tsx` | ⌘, settings modal (gear in status bar): LSP controls, agent integration/profile diagnostics, workspace terminal recipes, local-control paths, and agent notification/usage settings; sections are plain blocks — append future settings here |
| `src/components/AttentionInbox.tsx` | Titlebar inbox over both docks: strict attention ordering, exact navigation, independent review actions, bounded live context peek, pipeline controls, and keyboard operation |
| `src/components/IsolatedTasksPanel.tsx` | Repository-wide Worktrees sidebar (activity-bar tree icon): refreshes the active checkout's live `git worktree list`, keeps stable main-then-branch/path ordering while Current changes, renders compact ordinary rows with detached/locked/prunable/open/current state, path-keyed project color, and confirmed non-main checkout removal, and overlays expandable isolated-task evidence/actions by exact worktree path; New Task requests an app-owned create+agent dialog, removed checkout records live behind the conditional Removed tasks toggle, task records are independently deletable, and ordinary external worktrees are never silently adopted or automatically cleanup-owned |
| `src/components/WorktreeDialog.tsx` / `AgentLaunchDialog.tsx` | Worktree create/open UI and the profile-driven launch sheet shared by both terminal docks |
| `src/components/MemoriesPanel.tsx` | Memories sidebar view (ActivityBar brain icon): the active project's agent memories (Claude files + Codex sqlite + AGENTS.md, via memories.rs) in per-agent sections, fetched fresh per mount + refresh button (stale-response seq guard); cards expand inline through `renderMarkdownDoc`, and the hover action / double-click promotes one to an editor tab (`openMemory`) |
| `src/components/MemoryPreview.tsx` | Editor-area pane for `Tab` kind "memory": document header (source/type chips, title, description) over the `.md-doc` markdown body; renders the tab's snapshot only (no IPC — the sidebar owns fetching, `openMemory` refreshes an open tab in place), links via `open_url` |
| `src/components/PreviewPicker.tsx` | Workspace-bound **Open Preview** dialog: normalizes manual loopback URLs, scans through typed preview IPC, groups detected servers as **This project** / **Other local servers**, and opens a fresh session-only preview tab for every selection |
| `src/components/PreviewPane.tsx` | Interactive phone frame and browser toolbar over a native child WKWebView: measures zoom-adjusted host bounds, syncs resize/orientation/navigation/load state, and hides the native view whenever its tab/workspace is inactive, the panel is maximized, a global overlay covers it, or control fails; external navigations are routed through the app's URL opener |
| `src/components/SearchPanel.tsx` | ⌘⇧F sidebar search view: query + case/word/regex toggles, per-file collapsible result groups, click opens the file at the match line (`openFile(path, at)`) |
| `src/components/AgentDock.tsx` | Global flavor of Dock: semantic icons/text badges/tooltips plus OSC topic summary, active-project ring, project navigation, disconnected state, and persisted notification toggle |
| `src/components/Resizer.tsx` | Generic drag-to-resize handle (sidebar, panel, dock splits) |
| `src/components/ContextMenu.tsx` | Shared fixed-position context menu (viewport clamp, backdrop/Escape close) — GitGraph commit actions, Titlebar tab menu |
| `src/components/FileExplorer.tsx` | Lazy directory tree (per-dir cache + expanded set) with ⌘/Ctrl toggle, Shift-range, and ⌘A multi-selection; pointer-capture drag-and-drop (HTML drag events are unreliable in WKWebView) moves the selected files/folders onto folders or the repo root. Right-click file management (new file/folder + rename via inline in-row inputs, multi-item cut/copy/paste/trash/copy-path, reveal in Finder; F2 rename, ⌘⌫ delete) repoints open editor tabs after renames/moves via the editor store's `retargetFileTabs`, confirming first when unsaved drafts would be lost |
| `src-tauri/src/git.rs` | Git/source-control plus isolated worktree list/open/create/remove/merge; cheap `git_review_head` and privacy-bounded, moving-repo-revalidated whole/per-file review fingerprints (modes/conflict stages/dirty submodules included); network/history mutations shell out to `git` CLI where user auth/safety behavior matters |
| `src-tauri/src/pty.rs` | PTY sessions, flow control, and process-group teardown; macOS aggregated privacy-bounded agent descendant snapshots with matching-agent ancestry; PTY capability setup and host-only environment-variable isolation |
| `src-tauri/src/agent_sessions.rs` | Read-only, privacy-bounded Codex state-database lookup for exact-cwd native thread candidates and restore validation |
| `src-tauri/src/control.rs` | Mode-0600 per-user Unix-socket control plane: Rust semantic snapshots/event ring, timeouts/cancellation, generation waits, frontend action routing, and project-scoped capabilities |
| `src-tauri/src/lsp.rs` | Language-server stdio transport (pty.rs sibling, deliberately protocol-blind): spawn as process-group leader with the login-shell PATH injected, Content-Length frame parser → raw `lsp-message:<id>` events, `lsp_send` owns outgoing framing, `lsp_resolve` finds binaries via `$SHELL -lc` (cached, `__VIBE_PATH__` marker); kill = SIGTERM → 500 ms → SIGKILL group |
| `src-tauri/src/notify.rs` | UserNotifications banners + activation: retained delegate handles foreground presentation and response clicks, focuses the main window, and queues one terminal-id activation until the frontend listener is ready; `play_sound` uses preemptive detached afplay |
| `src-tauri/src/watcher.rs` | Debounced repo watchers (one per open repo, keyed by root) → `repo-changed` event `{repoPath, gitChanged}` |
| `src-tauri/src/fsops.rs` | fs_read_dir / fs_read_file (5 MB cap, NUL + UTF-8 binary sniff) / atomic fs_write_file; explorer file ops: fs_create_file/_dir (never overwrite), fs_rename (refuses existing targets — inode-compared so case-only renames pass on APFS), fs_trash (NSFileManager → macOS Trash), fs_copy (recursive, symlinks kept as links, Finder-style "name copy" uniquify), fs_reveal (`open -R`), open_url (scheme-whitelisted http(s)/mailto `open` — markdown-preview links) |
| `src-tauri/src/memories.rs` | `memories_list(projectPath)`: Claude memories from `~/.claude/projects/<munged>/memory/*.md` (frontmatter parsed/stripped, MEMORY.md index skipped) + Codex auto-memories via the system sqlite3 CLI (newest `~/.codex/memories_<n>.sqlite` `stage1_outputs` JOINed to `state_<n>.sqlite` `threads.cwd` through ATTACH; read-only `file:…?mode=ro` — WAL, never immutable=1) + repo AGENTS.md; every failure degrades to an empty section, never an error |
| `src-tauri/src/preview.rs` | Localhost preview backend root: loopback-only URL validation, bounded lsof/process discovery with HTTP probing and project/framework labeling, plus native child-WKWebView lifecycle commands (create/navigate/history/reload/bounds/visibility/focus/close); remote preview webviews receive no Tauri IPC capability |
| `src-tauri/src/search.rs` | `ignore`-crate worktree walks: list_workspace_files (quick open, 50k cap) + search_workspace (parallel walk, fsops's binary/size skip rules, 2000-match cap, UTF-16 offsets for JS/CodeMirror) |
| `src-tauri/src/main.rs` | Tauri composition root and command registration; the page-load PTY/LSP cleanup is guarded by `webview.label() == "main"` so preview navigation or reload can never kill IDE-owned terminals or language servers; app exit closes every native preview before process teardown |

## IPC contract rule

`src/lib/ipc.ts` is the single source of truth. Every Rust payload struct uses
`#[serde(rename_all = "camelCase")]` so wire shapes match the TS types exactly;
Tauri converts snake_case command args (`repo_path`) to camelCase (`repoPath`).
Adding a command = implement in the right `src-tauri/src/*.rs` module, register
in `main.rs` `generate_handler!`, add the typed wrapper in `ipc.ts`. Components
never call `invoke()` directly — always go through ipc.ts.

Backend rules: every command body runs inside `blocking(...)` (the
`spawn_blocking` helper in git.rs / per-module equivalents) so sync libgit2,
fs, or CLI work never stalls the async runtime that also serves terminal IPC.
Stash operations address stashes by **oid**, never index (indices shift).
Paths handed to libgit2 pathspec APIs must be escaped (`escape_pathspec`) or
use `disable_pathspec_match` — brackets/globs in filenames are otherwise
interpreted as patterns (real-world case: Next.js `app/[slug]/page.tsx`).

## Dev commands

```sh
pnpm install
pnpm tauri dev                  # run the app (starts vite via beforeDevCommand)
pnpm tauri build                # .app/.dmg in src-tauri/target/release/bundle
pnpm test                       # Vitest: detection/state/selector/alert logic
pnpm build                      # TypeScript project build + Vite production build
cd src-tauri && cargo check     # backend typecheck
cd src-tauri && cargo test      # backend unit tests
```

## Conventions

- Documentation ships with code. Any behavior/architecture/command/test/UI
  change must update `CLAUDE.md`, the relevant `docs/architecture/*.md`, and
  user-facing `README.md` or roadmap status where applicable in the SAME
  change. Never leave removed types, flags, or test claims documented.
- All colors/fonts/metrics come from CSS variables in `src/styles/theme.css`;
  never hardcode colors in component CSS. Sanctioned exceptions: the JS themes
  in `lib/termSession.ts` (XTERM_THEME) and `Editor.tsx` (editorTheme).
- The accent family (`--accent-hover/-muted`, `--button-bg/-hover`,
  `--bg-selected`, `--focus-ring`) is DERIVED from `--accent` via color-mix —
  App.tsx recolors the whole app per active project by overriding only
  `--accent` (from the `--project-N` palette via `lib/projectColors.ts`).
  GOTCHA: a custom property substitutes `var()` where it is DEFINED, so the
  derived family lives on `:root, .app, .accent-scope` (theme.css) — any new
  scope that changes `--accent` must carry `.accent-scope` or the family
  stays stale. Opt a subtree out of project coloring by re-pinning
  `--accent: var(--accent-default)` + `.accent-scope` (pattern: `.git-graph`).
  Never reintroduce literal accent-family values.
- Icons live in `src/components/icons.tsx` (16×16, stroke currentColor,
  round caps) — no icon library, no new inline SVGs in components.
- Status letters/colors/paths come from `src/lib/status.ts`. `statusPaths` is
  mandatory for any git mutation on a file entry — renamed files need both the
  new and old path or the operation half-applies.
- zustand: subscribe with narrow selectors (`useShallow` for multi-field picks
  of values the store already holds); whole-store destructuring re-renders on
  every state change. A selector that BUILDS a value must return a
  reference-stable one (memoize like `selectGroupingWorkspaceActivities`):
  zustand v5 runs selectors inside `useSyncExternalStore`'s getSnapshot, so a
  freshly allocated result reads as "changed" every time and spins React until
  it throws "Maximum update depth exceeded" — which kills the whole app.
  `useShallow` does NOT rescue that: its `shallow` compares array/object
  entries with `Object.is`, so a fresh array of fresh objects never matches
  (an empty one does, so the loop only appears once there's data). Inside a
  workspace tree, use the context hooks (`useRepo`/`useEditor`/`useTerminal`),
  NOT a global store; event handlers read fresh state via
  `useWorkspace().repo.getState()` etc. Global chrome (titlebar/status bar)
  follows `useActiveWorkspace()`. Repo mutations return booleans — branch on
  them, never probe `getState().error` for success.
- Tauri `listen()` resolves AFTER mount: track a `disposed` flag and call the
  unlisten fn in effect cleanup (pattern: `XtermPane`, `FileExplorer`).
- Errors: git mutations → repo store `error` (status bar, click to dismiss);
  save failures → inline banner; confirmations/open-repo failures →
  `@tauri-apps/plugin-dialog` `confirm()`/`message()`.

## Gotchas

- React StrictMode double-mounts effects in dev. PTY spawn/kill is guarded by
  a `disposed` flag + spawn-promise-sequenced kill (`lib/termSession.ts`),
  and the session registry's get-or-create is synchronous check-then-set;
  each repo store guards races with a per-store `disposed` flag;
  `openWorkspace` dedupes by root with no await between check and set. Keep
  this discipline for any new effectful mount.
- ALL workspace trees stay mounted; the inactive ones are hidden with
  `display:none` (same rule as terminal tabs) so shells, editor buffers, and
  explorer state survive switching — never key a workspace's subtree on the
  active path.
- `repo-changed` events are emitted for EVERY watched repo: each `listen`er
  must filter by `payload.repoPath` (repo store, `FileExplorer`, `Editor`,
  `DiffViewer`) or it will react to other workspaces' changes.
- WKWebView: `window.alert/confirm/prompt` are NO-OPS — always use
  `@tauri-apps/plugin-dialog`. Vite build target is `safari16`; avoid newer
  JS/CSS features than that. Every DOM modal/popover that can cover an editor
  must call `useNativeOverlay()` so a native preview child webview cannot sit
  above it regardless of CSS z-index.
- Watcher debounce layering (rationale documented in `watcher.rs`): Rust waits
  for a 250 ms quiet period (max 1 s), `repo.ts` adds 150 ms coalescing +
  skips watcher echoes within 400 ms of an explicit mutation refresh,
  `FileExplorer` debounces its own re-reads 300 ms. The event payload's
  `gitChanged` flag decides between a cheap status-only refresh (plain file
  edits) and a full status+log+stash refresh (HEAD/index/refs changed).
- Inactive dock tabs/groups stay mounted with `display:none` so xterm
  buffers survive — visibility is always `display:none`, never unmounting
  (and with registry sessions, even an unmount only detaches). On reveal,
  the session's ResizeObserver refits + `term.refresh()`es IMMEDIATELY (no
  debounce) — xterm's renderer is paused while hidden and the WebGL canvas
  can come back blank, so a debounced refit reads as flicker.
- Dedicated Claude/Codex tabs and discovery-enabled plain shell tabs in BOTH
  docks register in the ephemeral `agentRuntime` store; requested terminal
  kind is launch metadata, never proof of occupancy. macOS
  `pty_agent_process_snapshot` establishes whether the exact agent executable
  is a descendant of that PTY shell. Only then may the bounded xterm tail
  classifier own lifecycle. Screen > OSC > activity; delayed evidence must
  match the occupant generation. Read
  `docs/architecture/agent-runtime.md` before changing this pipeline.
- Agent PTYs set `TERM_PROGRAM=ghostty` so supported CLIs emit OSC 9/777
  notifications and OSC 0 titles. Known cost: TERM_PROGRAM-sniffing image CLIs
  may emit Kitty graphics xterm.js drops. PTY spawn also removes host-private
  `NO_COLOR`, `CODEX_CI`, `CODEX_THREAD_ID`, and Codex-forced pager settings;
  otherwise a dev app launched from an agent silently changes its child CLIs.
  The login shell may set them again intentionally.
- Semantic **Done** is derived from a present agent becoming idle in the
  background and remaining unseen. Viewing acknowledges Done; viewing blocked
  only dismisses its alert and MUST NOT clear lifecycle without new evidence.
  Rollup priority is blocked > done > working > idle/unknown/absent. Runtime
  and seen state are never persisted; restored global tabs are fresh shells.
- Every detected dedicated-agent generation owns one session-only `AgentTask`.
  Lifecycle and review are independent: Done never means checks passed.
  Shared-checkout review scope is the entire repository since base HEAD;
  isolated agents additionally capture a stable `IsolatedTask` owner. See
  `docs/architecture/attention-review.md` and
  `docs/architecture/isolated-agent-tasks.md`.
- Worktree cleanup never deletes a branch. Normal Git removal must refuse a
  dirty checkout before the UI may offer a confirmed force retry; a live
  global terminal bound to the checkout blocks removal, and successful removal
  prunes non-live persisted terminal records and rebinds global-group navigation
  memory for that path. Merge must prove both paths belong to the same Git
  worktree set. Workspace close, task archive, and checkout removal are distinct
  transitions.
- Review fingerprints are backend-only content hashes. Plain-text context
  peek is explicit, capped at 12 logical lines/4,096 characters, and component-only.
  Never log or persist terminal snapshots or check output.
- A prompt-owned user Enter in a detected agent terminal is delayed until
  `git_checkpoint_create` snapshots tracked/untracked non-ignored content into
  an unreachable Git tree through a private index. The real index is never
  mutated. A checkpoint error must withhold Enter and be surfaced; never
  silently submit an uncheckpointed prompt. Checkpoint diffs are read-only
  evidence and cannot undo external effects.
- Queued/steered automation prompts are session-only, capped at 8,192 characters, pinned
  to the detected occupant generation, and checkpoint before sending. Timeout
  or cancellation removes pending text before it can reach the PTY. Never
  persist a prompt queue, truncate instructions silently, or retarget it after
  process replacement. Multiline
  programmatic prompts must go through `TermSession.sendPrompt()` so terminal
  controls are stripped and only one final Enter is submitted.
- The local agent-control socket synchronizes privacy-bounded semantic state
  into Rust; Rust never reads screen text or writes PTYs directly. Keep the
  global token out of repository processes, enforce exact project scope for
  short-lived capabilities, and preserve snapshot → ordered events → resync
  semantics. See `docs/architecture/agent-control.md`.
- Check completion comes only from a random-nonce private OSC marker. Never
  parse terminal prose for exit status. Closed/exited sessions cancel evidence;
  automatic checks require persisted project trust. A pass is valid only when
  its pre/post fingerprint is stable; one formatter mutation reruns the full
  DAG, while a second invalidates it. Check panes are never reused because the
  user may have taken over their shell after completion.
- ALL dock terminals (both groups) decouple PTY lifetime from React via the
  session registry: host unmount = `detach()` ONLY (drag-and-drop and split
  rewraps remount bystander panes); the PTY dies exclusively via
  `disposeSession()` — reached through `closeAgentTerminal()`,
  `closeWorkspaceTerminal()`, or `closeWorkspace` (which disposes that
  workspace's sessions explicitly, since unmounting no longer kills
  anything). Never call `dispose()` from an effect cleanup, and never call a
  dock store's `closeTerminal` directly from UI (it would leak the shell).
  Agent terminals belong to a `workspacePath`, not a workspace: they keep
  running when their project closes ("disconnected" ⊘ badge; clicking
  reopens the project) and their layout persists across restarts (shells
  respawn lazily on first attach).
- NEVER `fit.fit()` a hidden (display:none) xterm host: xterm 6 measures
  glyphs via OffscreenCanvas even unrendered, so FitAddon doesn't bail — it
  resizes the terminal+PTY to a bogus ~10×5 grid. Guard every fit path with
  `host.offsetParent !== null` (mount fit, debounced fit, reveal fit).
- `fs_read_file` truncates files >5 MB (editor becomes read-only); binary =
  NUL in the first 8 KB **or invalid UTF-8** (we refuse to lossy-decode: a
  lossy round-trip through the editor would corrupt the file on save).
  `fs_write_file` is atomic (temp file + rename) and writes through symlinks.
- The editor and worktree/staged diffs reload on external changes (terminal
  git commands, formatters) and guard ⌘S with a disk-conflict check — don't
  bypass `Editor.tsx`'s save path with direct `fsWriteFile` calls.
- LSP: `lsp.rs` is a dumb byte-framing pipe — ALL protocol logic lives in
  `src/lib/lsp/client.ts`, which must answer EVERY server→client request
  (`workspace/configuration`, `client/registerCapability`, ...; unknown →
  `-32601` error) or the server hangs with no error anywhere. Binaries are
  resolved through the user's login shell and that PATH is injected into
  server children (`#!/usr/bin/env node` shebangs + tsserver's child spawn;
  works-in-dev/fails-from-Finder otherwise). Manual test needs
  `npm i -g typescript-language-server typescript pyright`.
- LSP coordinates are `{line, character}` 0-based UTF-16 (≡ JS string
  indexing); CM-offset conversion lives ONLY in `cmLsp.ts`, and incoming
  ranges must be clamped (an out-of-range `doc.line()` throws inside CM's
  update and kills the view). didChange batches emit a transaction's
  old-coordinate changes in DESCENDING position order, and position requests
  flush pending changes first — `client.ts` owns both rules; symptoms of
  breaking them are subtle off-by-N diagnostics, not errors.
- LSP didOpen/didClose pair exclusively with the doc-session plugin's
  constructor/destroy (Editor.tsx `lspCompartment`); detaching clears stale
  squiggles via `recheckLsp`'s second dispatch (the lint field survives the
  compartment, and plugin `destroy()` runs mid-update so it can't clear).
  Language servers die via `disposeWorkspaceLsp` (closeWorkspace), settings
  disable, the page-reload/app-exit `kill_all`, or the idle policy in
  servers.ts (workspace deactivated 15 min / a language doc-less 5 min —
  docs stay TRACKED through a stop and replay into a fresh server on
  resume) — same registry discipline as terminals. Servers only ever run
  for the ACTIVE workspace (`setActiveLspWorkspace`, subscribed in
  stores/workspaces.ts); initialize carries the app's real pid so servers
  self-exit if the app dies without teardown (verified: tls + tsserver also
  exit on stdin EOF). tsserver's syntax server is disabled
  (`useSyntaxServer: "never"`) — one tsserver per TS workspace, not two.
  DiffViewer deliberately has no LSP (its worktree side would fight the
  file tab over one document).
