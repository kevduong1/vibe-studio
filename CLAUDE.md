# CLAUDE.md

Talos — a Tauri 2 macOS desktop app: multi-folder workspaces (titlebar tab
switcher; Git is an optional capability that can be initialized in place),
git source control (status, staging, commit/amend/push, stashes,
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
| `src/lib/path.ts` | Shared POSIX-path helpers (`basename`, `dirname`, `isMarkdownPath`, `isImagePath`) — import these, don't redefine per file |
| `src/lib/fuzzy.ts` | Hand-rolled two-phase fuzzy matcher shared by Quick Open and Explorer filename search: O(n) subsequence reject over the whole list, then a scoring DP (boundary/camelCase/basename/consecutive bonuses) returning matched positions for highlighting |
| `src/lib/graphLayout.ts` | Pure lane-layout algorithm for the commit graph (algorithm documented in-file); lane colors are resolved CSS strings handed out by the caller's `LaneColorFn` where a lane OPENS (default: the rotating `--graph-N` palette) |
| `src/lib/gitGraphRefs.ts` | Pure commit-graph ref-pill selection: local/remote/tag ordering, exact checked-out-branch prioritization and filled-pill identity, including multiple local refs sharing HEAD |
| `src/lib/agentState.ts` | Pure semantic agent model: occupancy/lifecycle/authority types plus the generation-owned background-work annotation, derived display state (blocked outranks the starting/launch grace; background work never changes idle input semantics), rollup priority (`rollupAgentStates` skips absent states and returns `null` when nothing is present, distinct from idle), labels/tooltips, and notification-edge selection |
| `src/lib/agentAvatars.ts` / `src/components/AgentAvatar.tsx` | Pure Agent Sessions personality/sprite/state model plus its theme-token-rendered Canvas blitter: detected Claude/Codex kind + reactive eight-color project palette → one of twelve deity identities; hand-authored bitmap string-grids on a 20×20 logical grid (integer 4× scale into the 80px tile) layer a shared chunky mini-figure body with per-deity low-alpha aura, robe regalia, headgear, emblem, held relic, and project-accent stole. `composeAgentAvatarFrame` is pure layer data; the component only maps palette keys to CSS custom properties (resolved once per effect run, not per frame) and fills run-length-merged rects. Animation is deliberately calm — ≤1 logical pixel of movement per frame, 350–1100 ms cadences, breathing bob/blink/relic tap+glint/cue+aura pulse, never a translating figure. One module-level animation clock drives intersecting instances, reduced motion freezes a descriptive frame without subscribing, and `absent` renders an empty subdued tile |
| `src/lib/agentProfiles.ts` | Independently authored Claude/Codex screen-detection profiles; box-frame/rule-line normalization (`normalizeAgentScreenLines`), bounded near-tail rules for blocked/working/idle evidence, and a separate bottom-four-line Claude footer extractor for live background-task counts (never the stale `still running` scrollback summary) |
| `src/lib/terminalActivity.ts` | Generic lifecycle fallback for dedicated/discovered agents: sustained normal- or alternate-screen output (runtime occupancy prevents ordinary TUI false positives), BEL/OSC 9/777 notifications, a `completed` turn-boundary signal reported for every stretch regardless of ping-worthiness, and OSC 133/633 shell marks that supply exact stretch boundaries only (never busy ownership for a whole agent session) |
| `src/lib/agentPaneTitle.ts` / `codexTerminalTitle.ts` | Shared OSC 0/2 topic integration: built-in Codex launches pin `activity`/`thread-title`/`task-progress`; presentation in both docks, Agent Sessions, and notification banners preserves useful topics while removing Codex activity/action-required phases, run-state/project duplicates, moving context meters, and unnamed-thread UUIDs, plus Claude's whitespace-separated leading sparkle glyph (· ✢ ✳ ✶ ✻ ✽) and default "Claude Code" product title |
| `src/lib/termSession.ts` / `trackedCommand.ts` | Framework-free xterm+PTY session (attach/detach reparenting; ONLY `dispose()` kills the PTY); one normalized semantic tail feeds lifecycle classification plus background annotations before the shared debounced landing; acknowledgement, `XTERM_THEME`, and the multiline nonce-bound check-command wrapper live here |
| `src/lib/termSessions.ts` | Session registry for ALL dock terminals (`getOrCreateSession`/`getSession`/`disposeSession`) — sessions outlive React unmounts |
| `src/lib/terminalCloseGuard.ts` | Pure user-close confirmation policy: every global terminal tab is protected; project tabs are protected when dedicated to an agent or currently occupied by a discovered agent. Automatic process-exit/cleanup paths bypass the prompt |
| `src/lib/agentSessions.ts` / `agentLaunchProgram.ts` / `agentCheckpointPrompt.ts` | Global-agent glue on the registry: semantic metadata, close paths, setup-before-baseline plus launch-shell environment, shared raw-Enter checkpoint handling, intentional `claude`/`codex --yolo` launch defaults, and the built-in Codex launch-scoped topic-title override; global terminal metadata and layouts are session-only and every app launch starts empty |
| `src/lib/agentPromptQueue.ts` | Session-only, 8,192-character-bounded prompt queue pinned to terminal occupant generations; queue waits for safe input, steer is explicit, and both checkpoint isolated-task state before sending |
| `src/lib/agentControlPlane.ts` | Frontend half of the authenticated local control plane: semantic snapshot sync (including the privacy-bounded background count/summary) plus generation-checked focus/prompt/start routing; see `docs/architecture/agent-control.md` |
| `src/lib/nativeAgentSessions.ts` | Unambiguous isolated-Codex native-thread capture on semantic process/turn edges; stores only an opaque task reference |
| `src/lib/editorAgentContext.ts` | Safe same-project routing for bounded editor selection/file/diff context into an idle/question-owned agent prompt |
| `src/lib/agentNotifications.ts` | Opt-in semantic blocked/Done alerts for both docks; one banner ID per terminal, shared sound/banner settings, edge-triggered delivery, and acknowledgement/resume/exit/close/disable dismissal |
| `src/lib/workspaceSessions.ts` | Workspace terminal glue on the registry, including dedicated-agent semantic metadata, the intentional `codex --yolo` default with its launch-scoped topic-title override, and launch/close paths |
| `src/lib/termFileDrop.ts` | Native file drops onto terminal panes (both docks) paste shell-quoted paths: Tauri webview drag-drop events (the DOM never sees native drags) → pane hit-test → `term.paste()` (bracketed paste is how Claude Code detects image paths). Drag positions are LOGICAL px despite the PhysicalPosition type (macOS wry quirk, documented in-file) — never divide by devicePixelRatio, but DO divide by `currentZoom()` (page zoom shrinks the CSS viewport) |
| `src/lib/previewSessions.ts` | Session-only registry for native localhost preview child webviews: per-preview serialized create/navigation/bounds/zoom/close operations, a global visibility coordinator that hides peers before showing one native view, and explicit disposal ownership so React unmounts only hide while tab/workspace close destroys; fitted device presets/custom dimensions use child-page zoom so responsive CSS sees the requested viewport size |
| `src/lib/zoom.ts` | Whole-app zoom (⌘+/⌘−/⌘0, App.tsx): browser-style step list applied via webview `setZoom` (WKWebView.pageZoom — layout-reflowing, so terminals refit via their ResizeObservers), localStorage-persisted, restored by `initZoom()`; `currentZoom()` feeds termFileDrop's coordinate mapping |
| `src/lib/tasks.ts` | VS Code-compatible `.vscode/tasks.json` model: JSONC parse + diagnostics, compound/dependency metadata, `${var}` substitution, and shell command-line assembly |
| `src/lib/taskRunner.ts` | Task execution glue: types the assembled command into a workspace dock terminal (reused per `presentation.panel` shared/dedicated/new; ^C first on reuse), reveals per `presentation.reveal` |
| `src/lib/checkPipelines.ts` / `pipelineModel.ts` | Agent review-check DAG validation/execution: reachable-only validation, parallel/sequential dependencies, fresh reserved terminals, pre/post fingerprint + one formatter rerun, nonce-bound exit evidence, revocable trust-gated autorun, and bounded history |
| `src/lib/agentInbox.ts` | Shared exact-terminal focus router for Agent Sessions rows, attention cycling, check nodes, and typed notification activations |
| `src/lib/isolatedTasks.ts` / `src/stores/isolatedTasks.ts` | Persistent isolated-worktree task lifecycle: setup/ignored-file/port policy, terminal ownership, archive/merge/keep/remove safety, explicit task-record deletion with parent-plan reference pruning, native Codex restore, and dependency-aware queue/steer/worktree/Best-of-N plans; see `docs/architecture/isolated-agent-tasks.md` |
| `src/lib/dockTree.ts` | Pure dock layout-tree model shared by both docks: split/group types, `normalize()` invariants, move/split/resize state ops, persistence sanitizer |
| `src/lib/lsp/` | LSP client service, layered and framework-free below cmLsp (a future IDE MCP server consumes the same API): `servers.ts` is the ONLY entry point (WorkspaceLsp facade registry keyed by workspace root — lazy per-language server start that follows the ACTIVE workspace (background/idle auto-stop with doc replay on resume), diagnostics store, crash policy, `getLspForFile` editor gate) → `client.ts` (JSON-RPC correlation + lifecycle + incremental didChange coalescing — the protocol brain) → `transport.ts` (IPC glue) → `lsp.rs`. `settings.ts` = session-scoped master mode (`LspMode` Disabled \| Dynamic — every launch starts Disabled, never persisted; ANDed into `isLanguageEnabled` so all gates + the change fan-out inherit it) over persisted `talos:lsp` per-language toggles + `LSP_LANGUAGES` UI metadata; `types.ts` = wire types + `serverLangForPath`; `uri.ts` = path↔file:// (NEVER concat URIs elsewhere); `markdown.ts` = sanitized hover/doc renderer (textContent only; fenced blocks async-highlighted via lazy language-data load + oneDarkHighlightStyle classes); `cmLsp.ts` = the CodeMirror bundle (doc-sync ViewPlugin, squiggles via `setDiagnostics` push, hover, completion override, ⌘-click/F12 go-to-def) |
| `src/lib/markdownDoc.ts` | Full-document markdown → DOM renderer for the preview (MarkdownPreview.tsx): @lezer/markdown GFM parse tree walked with createElement/textContent ONLY (lsp/markdown.ts discipline — raw HTML renders inert, no sanitizer dep). Links are `data-href`, never real hrefs (the webview must never navigate); images are placeholders (CSP allows no image sources); fenced code reuses lsp/markdown's `highlightInto` and mounts the oneDark token classes itself (style-mod) since no editor view may exist yet |
| `src/lib/cmChangeRuler.ts` | Overview ruler shared by Editor + DiffViewer: a ViewPlugin overlays the editor's scrollbar with change blips (add green / del red / mod blue, `--ruler-*` vars) positioned via the HEIGHT MAP (lineBlockAt — line-proportional math breaks under collapseUnchanged/widgets) and doubling as a scrubber (pointer drag = absolute jump; the native thumb beneath is the viewport indicator). Two mark sources: `changeRuler("merge")` follows merge chunks (both diff modes + both split sides); `changeRuler("field")` + `setRulerMarks`/`computeRulerMarks` for the file editor, whose Editor.tsx glue diffs the LIVE doc against a git HEAD baseline (the "staged" diff kind's old side — an index baseline would blank the ruler the moment a file is staged; untracked/ignored files get no ruler) |
| `src/lib/projectColors.ts` | Per-project palette-index assignment (auto on first ask; user-set via `setProjectColorIndex`, localStorage-persisted) — render through the reactive `useProjectColorIndex`/`useProjectColorVar` hooks (`assignedProjectColorIndex` + `useProjectColorsVersion` for probing many paths at once WITHOUT assigning); feeds tab/badge tints, commit-graph branch colors, and the app-wide `--accent` override |
| `src/lib/appTheme.ts` | App-wide fixed Granite surface palette initialization, including cleanup of obsolete persisted theme-picker state; project accent colors remain independent |
| `src/lib/projectNames.ts` | Cosmetic per-project display names (user-set via `setProjectDisplayName`, localStorage-persisted; folder-basename fallback) — render through the reactive `useProjectDisplayName(s)` hooks; purely visual, nothing path-based ever sees them |
| `src/lib/clipboard.ts` | Shared `copyText` (navigator.clipboard + execCommand fallback, no plugin) — GitGraph copy-SHA, Titlebar copy-path |
| `src/stores/workspaces.ts` | Folder workspace registry and optional-Git capability transition: canonical open/close/setActive, session restore including pinned file/diff tabs + MRU files (transient/native-preview/memory tabs never persist), `switchToProject` (agent-terminal navigation), `WorkspaceContext` + `useWorkspace`/`useRepo`/`useEditor`/`useTerminal`/`useSearch` hooks, plus `useActiveEditorTabCount`; see `docs/architecture/workspaces.md` |
| `src/stores/repo.ts` | Per-workspace optional repo store: always wires the filesystem watcher, gates status/log/stashes and Git mutations on `isGitRepository`, initializes Git in place, owns log branch filter (`logFilter`/`setLogFilter`), and surfaces status-bar `error` |
| `src/stores/editor.ts` | Per-workspace editor-tab store factory (`Tab = file \| diff \| memory \| preview`): one replaceable clean `transientTabId` shared by file/diff browsing (edit/explicit open pins), drag reorder, relative activation, bounded closed-tab + recent-file stacks, dirty tracking, session-only native preview creation/orientation plus teardown ownership (`pendingPreviewDisposals` survives tab removal until native close succeeds), native Save/Don’t Save/Cancel close helpers, `openFile(path, at?)` + nonce-gated `reveal`, and rename/move retargeting |
| `src/stores/search.ts` | Per-workspace Explorer search store factory: shared filename/content mode + query, content toggles/results, 250 ms content debounce, and sequence-number stale-result guard; filename matching stays local over the workspace file index |
| `src/stores/terminal.ts` | Per-workspace terminal dock store factory (shell/Claude/Codex tabs, dockTree layout, ephemeral notification toggles, NOT persisted; never touches xterm or IPC) |
| `src/stores/agentRuntime.ts` | One ephemeral semantic runtime store for both docks: requested-vs-detected identity, definition-aware exact-basename occupancy polling, atomic generation-safe PID/kind transitions, conclusive-screen-only background annotation set/update/clear with inconclusive/activity/query-mask retention, a per-generation work-stretch flag that drives unseen Done, confirmed output overriding Claude's ambiguous always-painted idle composer, other screen authority yielding to contradicting activity after 15s staleness (blocked excepted), a one-shot post-prompt completion-boundary set that can additionally clear an osc-only (ring-only) blocked prompt, a 1 Hz ambient reconcile on the shared poll tick reading pane visibility live off the DOM (`setAgentPaneVisibility`), acknowledgement, and workspace/group rollup selectors |
| `src/stores/agentTasks.ts` | Session-only generation-owned task/review store: cheap launch HEAD + async stable fingerprints, sequence-guarded/shared refreshes, runtime reconciliation after frontend hot reload, independent human review/check states, stable Agent Sessions attention age, and exact task-evidence acknowledgement keys that silence seen alerts without resolving them |
| `src/stores/agentTerminals.ts` | Session-only GLOBAL terminal-groupings store: any number of named dockTree layouts (`groupings`, one panel tab each; `activeGroupingId`) over ONE shared terminals map, terminal↔project bindings plus launch-time Git-family presentation metadata (keeps disconnected sessions grouped), deletion-aware last-workspace navigation memory, deduped default titles, ephemeral live pane titles (`paneTitle`), per-terminal `notificationsEnabled` opt-in, and `groupingDockStore(id)` — the cached per-grouping read-only store facade the generic Dock consumes. Groupings store no independent color; their panel tabs derive project folder identities from member terminals. No grouping or terminal metadata is loaded or saved across app launches |
| `src/stores/agentDefinitions.ts` | Typed built-in/custom agent definitions and launch profiles; visible `codex --yolo` default, stable definition IDs, exact executable-basename detection registry with fail-closed profile conflicts, command assembly, and restore/folder policy metadata |
| `src/stores/terminalRecipes.ts` | Persisted, user-owned per-workspace terminal commands; recipes are manual-only and opening/restoring a workspace never runs them |
| `src/stores/ui.ts` | Global (workspace-independent) sidebar/panel visibility, sizes, session-only Agent Sessions filter/sort controls (repository-family A–Z by default or session-name A–Z), panel group (`terminal`/`agent`, `useEffectivePanelGroup`), panel maximize (`panelMaximized` — cleared by hiding the panel or opening an editor tab), markdown-preview toggle, and persisted word-wrap / one-second Auto Save preferences; the bottom panel defaults hidden each app launch |
| `src/App.tsx` | Shell layout (editor and terminal panel are SEPARATE cards in a transparent center column; the editor card hides while the panel is maximized or no editor tab is open), always-available activity rail with global items above a divider and workspace items below, per-workspace `WorkspaceView`s (all mounted; inactive hidden), global workspace/editor/tab/zoom shortcuts, native dirty-buffer Save All / Quit Without Saving / Cancel interception for both window close and Rust-bridged macOS `ExitRequested`, and welcome screen |
| `src/styles/theme.css` / `app.css` | Shared visual system and workspace shell: fixed Granite surfaces, project-derived accents, typography, radii/shadows, focus treatment, a transparent icon-only activity rail on the global canvas, and inset card surfaces for the content sidebar, editor, terminal panel, and welcome (editor/file/diff and terminal bodies share one workspace-canvas color; the panel deliberately does not clip, so its header/body round their own corners around the overhanging drag-resizer). CodeMirror follows CSS tokens; xterm resolves them through its sanctioned JS theme site. |
| `src/components/Titlebar.tsx` | Workspace tab strip (switch/close/add; related repo/worktree families stay expanded while one member is active and expand transiently on hover; double-click → inline rename; right-click → rename / copy path / project color) + active repo's branch pill and fetch |
| `src/components/icons.tsx` | ALL shared SVG icons (16×16 stroke glyphs) — add new icons here, not inline |
| `src/components/SourceControl.tsx` | Workspace SCM sidebar with persistent internal Changes / Worktrees tabs: Changes owns changed-file preview/double-click/context actions (including opening the working-tree file), stage/unstage/discard, commit (+amend, &push), stashes, and commit-graph branch filtering; both panes remain mounted while switching tabs |
| `src/components/GitGraph.tsx` | Hand-rolled virtualized commit list + SVG lane rail (no virtualization deps); ⌘/shift multi-select + right-click menu (checkout, create branch, squash, copy SHA). Branch identity is project-colored: the active project's color for its exact named checked-out branch, each linked worktree's ALREADY-assigned project color for the branch it holds — applied to the lane (via `LaneColorFn`, so only at tips) and to local ref pills (`--pill-accent`). When multiple local refs share HEAD, the named active branch is prioritized into the visible pills and is the only filled one |
| `src/components/EditorArea.tsx` | Editor tab strip + active pane host (lazy Editor/DiffViewer/ImagePreview/MarkdownPreview/MemoryPreview plus native-backed PreviewPane; inactive tabs unmount — dirty buffers live in `lib/editorBuffers.ts`, native preview sessions survive and hide); raster file tabs automatically use the read-only image preview, pointer tab reorder, italic provisional tabs with double-click pin, expanded close/path/diff context actions, **+** preview picker, and markdown reading-mode swap |
| `src/components/ImagePreview.tsx` | Read-only, fit-to-pane raster preview for normal file tabs: supported extensions route through the bounded `fs_read_image` data-URL IPC path and reload on matching repo watcher events; SVG remains editable text |
| `src/components/MarkdownPreview.tsx` | Rendered markdown view (status-bar eye badge toggles it, shown only for .md tabs): renders the unsaved draft from `lib/editorBuffers.ts` when one exists else disk content, re-renders on repo-changed (250 ms debounce), routes `data-href` link clicks through `open_url`'s scheme whitelist |
| `src/lib/editorBuffers.ts` / `editorStatus.ts` | Session dirty-buffer/save registry shared by active and unmounted file/editable-diff views (exact disk baseline + LF/CRLF/CR serialization, native close/save helpers), plus stable active cursor/selection/indent/EOL status snapshots |
| `src/components/Editor.tsx` | CodeMirror file editor + shared CM helpers (theme, languageFor, editKeymap), shared buffer registry, exact line-ending preservation, detected indentation, persisted wrapping/Auto Save, cursor status, and external-change reload/conflict protection |
| `src/components/EditorSearch.tsx` | VS Code-style floating find/replace widget (⌘F, top-right overlay) replacing @codemirror/search's default panel; per-EditorView React root via custom `createPanel`; match counting goes through an escaped-regex twin of literal queries (RegExpCursor ≫ string cursor on big docs); shared by Editor + DiffViewer |
| `src/components/DiffViewer.tsx` | @codemirror/merge split/unified diff; worktree diffs editable with buffered mode/tab switches + exact line endings + optional Auto Save, auto-refetch/conflict protection, previous/next hunk commands, and Open File/path actions in toolbar/context menu |
| `src/components/Panel.tsx` | Global bottom panel (under the editor column): Project Terminals tab (leftmost) + one tab per global terminal grouping ("+" adds, double-click renames inline, right-click → rename/close with confirm), with one project-colored status glyph per distinct project represented by that grouping's terminals (folder with no non-idle rollup, replaced by the semantic activity glyph otherwise) and no independent group color picker; per-group actions share the header row. Per-workspace terminal docks AND every grouping's dock stay mounted (display:none); maximize toggle (button or header double-click outside grouping tabs) fills the center column, as does having no editor tab open (both drop the drag-resizer) |
| `src/components/Dock.tsx` | Generic dockable terminal grid shared by both groups: recursive split/group rendering, per-group tab strips, double-click tab rename, pointer-capture DnD (strip insert caret / 5-zone edge splits), split resizers — flavor injected via `Pane`/`TabIcon`/`TabBadge`/`Empty` props |
| `src/components/TerminalPanel.tsx` | Workspace flavor of Dock: shell and dedicated-agent sessions, semantic icons/text badges/tooltips, ephemeral notification toggle, and confirmation before a user closes a dedicated or currently agent-occupied tab; it renders an explicit empty state and never creates a terminal merely because a workspace mounted |
| `src/components/TaskPicker.tsx` | ⌘⇧B quick-pick overlay (filter + arrow/enter keyboard nav); a lone default build task skips it (App.tsx) |
| `src/components/QuickOpen.tsx` | ⌘P fuzzy file picker overlay (TaskPicker pattern); fetches the gitignore-aware file list per open, renders top 100 with match highlighting, and puts the editor store's MRU files first for an empty query; picks open provisionally |
| `src/components/SettingsModal.tsx` | ⌘, settings modal (gear in status bar): category sidebar over editor wrap/Auto Save, LSP controls, agent integrations, workspace terminal recipes, notifications, usage, and advanced agent diagnostics/local-control paths; only the active category mounts its content |
| `src/components/AgentSessionsPanel.tsx` / `useAgentSessionItems.ts` | Persistent global sidebar navigator over both terminal docks: fills the resizable sidebar width; defaults to alphabetical Git repository-family sections (the titlebar's same worktree/equivalent-clone identity), offers session-name A–Z sorting, applies Attention as a filter instead of an urgency sort, and keeps per-source-project accent scopes, cleaned topics, child-process counts, exact navigation, and launch/review entry points; it is live ephemeral state, not durable provider transcript history. Row anatomy: an 80px avatar selected from reactive project color + detected runtime kind and drawn as a four-frame chunky pixel-art portrait (shared mini-figure body plus the deity's own aura, robe regalia, headgear, corner emblem, and held working relic), with the deity name visible below; headline = cleaned topic, else tab title, else agent name; explicit repository / checkout / live branch / nonredundant tab metadata; then lifecycle / background / review-state / changed-file-count (`task.latestSnapshot.changedFiles`) / Conflicts / check / child-agent chips. Background work never creates attention. Working tiles run a bright accent head and fading trail around the square perimeter, starting tiles pulse their accent ring, and unacknowledged blocked/completion/review/check alerts blink the tile's own accent until navigation acknowledges the current evidence; acknowledged items remain textually actionable until resolved, while new evidence can alert again. Idle/unknown tiles are partially desaturated; lifecycle stays textual/accessibility-visible, reduced motion freezes ring/sprite animation while preserving status color, and No Agent is always an empty subdued box |
| `src/components/AttentionInbox.tsx` | Titlebar Agent Sessions shortcut plus the detailed review overlay: strict attention ordering, independent review actions, bounded live context peek, pipeline controls, and keyboard operation |
| `src/components/IsolatedTasksPanel.tsx` | Repository-wide Worktrees view (the Worktrees tab inside Source Control): refreshes the active checkout's live `git worktree list`, keeps stable main-then-branch/path ordering while Current changes, renders compact ordinary rows with detached/locked/prunable/open/current state, path-keyed project color, and confirmed non-main checkout removal, and overlays expandable isolated-task evidence/actions by exact worktree path; New Task requests an app-owned create+agent dialog, removed checkout records live behind the conditional Removed tasks toggle, task records are independently deletable, and ordinary external worktrees are never silently adopted or automatically cleanup-owned |
| `src/components/WorktreeDialog.tsx` / `AgentLaunchDialog.tsx` | Worktree create/open UI and the launch sheet shared by both terminal docks: Claude/Codex card choice plus an open-project target stay primary, while profile/model/permission/sandbox/environment/worktree controls live under Advanced |
| `src/components/MemoriesPanel.tsx` | Memories sidebar view (ActivityBar brain icon): the active project's agent memories (Claude files + Codex sqlite + AGENTS.md, via memories.rs) in per-agent sections, fetched fresh per mount + refresh button (stale-response seq guard); cards expand inline through `renderMarkdownDoc`, and the hover action / double-click promotes one to an editor tab (`openMemory`) |
| `src/components/MemoryPreview.tsx` | Editor-area pane for `Tab` kind "memory": document header (source/type chips, title, description) over the `.md-doc` markdown body; renders the tab's snapshot only (no IPC — the sidebar owns fetching, `openMemory` refreshes an open tab in place), links via `open_url` |
| `src/components/PreviewPicker.tsx` | Workspace-bound **Open Preview** dialog: normalizes manual loopback URLs, scans through typed preview IPC, groups detected servers as **This project** / **Other local servers**, and opens a fresh session-only preview tab for every selection |
| `src/components/PreviewPane.tsx` | Interactive phone frame and browser toolbar over a native child WKWebView: measures zoom-adjusted host bounds, syncs resize/orientation/navigation/load state, and hides the native view whenever its tab/workspace is inactive, the panel is maximized, a global overlay covers it, or control fails; external navigations are routed through the app's URL opener |
| `src/components/SearchPanel.tsx` | Explorer-integrated search surface: fuzzy gitignore-aware filename/path mode plus full-text content mode (case/word/regex); filename results open files, collapsible content results open the matching line, and ⌘⇧F selects Content mode |
| `src/components/AgentDock.tsx` | Global flavor of Dock: semantic icons/text badges/tooltips plus cleaned OSC topic, active-project ring, project navigation, disconnected state, notification toggle, and confirmation before every user-initiated global-tab close |
| `src/components/Resizer.tsx` | Generic drag-to-resize handle (sidebar, panel, dock splits) |
| `src/components/ContextMenu.tsx` | Shared fixed-position context menu (viewport clamp, backdrop/Escape close) — GitGraph commit actions, Titlebar tab menu |
| `src/components/FileExplorer.tsx` | Explorer shell with the integrated filename/content search above a lazy directory tree (per-dir cache + expanded set). The tree has active-file ancestor loading/auto-reveal, complete Left/Right parent-child navigation, ⌘/Ctrl toggle, Shift-range, and ⌘A multi-selection; single-click files open provisionally and double-click/Enter pins. Pointer-capture drag-and-drop moves selected files/folders; right-click file management covers create/rename/cut/copy/paste/trash/path/Finder and retargets open tabs after moves |
| `src-tauri/src/git.rs` | Git/source-control plus isolated worktree list/open/create/remove/merge; cheap `git_review_head` and privacy-bounded, moving-repo-revalidated whole/per-file review fingerprints (modes/conflict stages/dirty submodules included); network/history mutations shell out to `git` CLI where user auth/safety behavior matters |
| `src-tauri/src/pty.rs` | PTY sessions, flow control, and process-group teardown; macOS aggregated privacy-bounded agent descendant snapshots with matching-agent ancestry; PTY capability setup and host-only environment-variable isolation |
| `src-tauri/src/agent_sessions.rs` | Read-only, privacy-bounded Codex state-database lookup for exact-cwd native thread candidates and restore validation |
| `src-tauri/src/control.rs` | Mode-0600 per-user Unix-socket control plane: Rust semantic snapshots/event ring, timeouts/cancellation, generation waits, frontend action routing, and project-scoped capabilities |
| `src-tauri/src/lsp.rs` | Language-server stdio transport (pty.rs sibling, deliberately protocol-blind): spawn as process-group leader with the login-shell PATH injected, Content-Length frame parser → raw `lsp-message:<id>` events, `lsp_send` owns outgoing framing, `lsp_resolve` finds binaries via `$SHELL -lc` (cached, `__TALOS_PATH__` marker); kill = SIGTERM → 500 ms → SIGKILL group |
| `src-tauri/src/notify.rs` | UserNotifications banners + activation: retained delegate handles foreground presentation and response clicks, focuses the main window, and queues one terminal-id activation until the frontend listener is ready; `play_sound` uses preemptive detached afplay |
| `src-tauri/src/watcher.rs` | Debounced workspace watchers (one per open folder, keyed by root) → legacy-named `repo-changed` event `{repoPath, gitChanged}`; ordinary folders use the worktree fallback so explorer/editor reloads still work |
| `src-tauri/src/fsops.rs` | fs_read_dir / fs_read_file (5 MB cap, NUL + UTF-8 binary sniff) / fs_read_image (allowlisted raster extension, 25 MB cap, data URL) / atomic fs_write_file; explorer file ops: fs_create_file/_dir (never overwrite), fs_rename (refuses existing targets — inode-compared so case-only renames pass on APFS), fs_trash (NSFileManager → macOS Trash), fs_copy (recursive, symlinks kept as links, Finder-style "name copy" uniquify), fs_reveal (`open -R`), open_url (scheme-whitelisted http(s)/mailto `open` — markdown-preview links) |
| `src-tauri/src/memories.rs` | `memories_list(projectPath)`: Claude memories from `~/.claude/projects/<munged>/memory/*.md` (frontmatter parsed/stripped, MEMORY.md index skipped) + Codex auto-memories via the system sqlite3 CLI (newest `~/.codex/memories_<n>.sqlite` `stage1_outputs` JOINed to `state_<n>.sqlite` `threads.cwd` through ATTACH; read-only `file:…?mode=ro` — WAL, never immutable=1) + repo AGENTS.md; every failure degrades to an empty section, never an error |
| `src-tauri/src/preview.rs` | Localhost preview backend root: loopback-only URL validation, bounded lsof/process discovery with HTTP probing and project/framework labeling, plus native child-WKWebView lifecycle commands (create/navigate/history/reload/bounds/visibility/focus/close); remote preview webviews receive no Tauri IPC capability |
| `src-tauri/src/search.rs` | `ignore`-crate worktree walks: list_workspace_files (Quick Open + Explorer filename search, 50k cap) + search_workspace (Explorer content search, parallel walk, fsops's binary/size skip rules, 2000-match cap, UTF-16 offsets for JS/CodeMirror) |
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
- All colors/fonts/metrics/shape/elevation come from CSS variables in
  `src/styles/theme.css`; never hardcode them in component CSS. Granite is the
  fixed app surface palette initialized by `lib/appTheme.ts`; project accent
  colors remain user-selectable. Sanctioned exceptions: the JS themes
  in `lib/termSession.ts` (`xtermTheme`) and `Editor.tsx` (`editorTheme`).
- The accent family (`--accent-hover/-muted`, `--button-bg/-hover`,
  `--bg-selected`, `--focus-ring`) is DERIVED from `--accent` via color-mix —
  App.tsx recolors the whole app per active project by overriding only
  `--accent` (from the `--project-N` palette via `lib/projectColors.ts`).
  GOTCHA: a custom property substitutes `var()` where it is DEFINED, so the
  derived family lives on `:root, .app, .accent-scope` (theme.css) — any new
  scope that changes `--accent` must carry `.accent-scope` or the family
  stays stale. Opt a subtree out of project coloring by re-pinning
  `--accent: var(--accent-default)` + `.accent-scope` (pattern: `.git-graph`).
  That opt-out covers the accent FAMILY only: `--project-N` palette entries are
  absolute and stay usable inside such a scope (the commit graph colors branch
  lanes/pills by project through them).
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
  kind is launch metadata, never proof of occupancy. Every semantic terminal
  is queried against the same unambiguous registry of built-in profile names
  plus custom-definition executable basenames, so a Claude tab may correctly
  discover Codex (and vice versa) without changing its saved tab identity.
  macOS `pty_agent_process_snapshot` establishes whether an exact registered
  executable is a descendant of that PTY shell. PID or detected-kind changes
  atomically create a new generation. Only then may the bounded xterm tail
  classifier own lifecycle. Detection rules must match complete app-owned UI
  phrases, never bare domain words that can appear in ordinary agent prose;
  the newest matching logical line wins. The process snapshot is bounded to
  two seconds and kills/reaps a timed-out `ps`. A transient failure masks only
  a previously present occupant as Unknown, retaining PID/generation/evidence;
  proven absent/starting/exited states remain unchanged, so an empty set never
  acquires a false Idle rollup.
  Structured/working screen evidence normally outranks OSC and activity, but
  confirmed sustained output outranks Claude's always-painted idle composer;
  delayed evidence must match the occupant generation. Read
  `docs/architecture/agent-runtime.md` before changing this pipeline.
- Agent PTYs set `TERM_PROGRAM=ghostty` so supported CLIs emit OSC 9/777
  notifications and OSC 0 titles. Known cost: TERM_PROGRAM-sniffing image CLIs
  may emit Kitty graphics xterm.js drops. PTY spawn also removes host-private
  `NO_COLOR`, `CODEX_CI`, `CODEX_THREAD_ID`, and Codex-forced pager settings;
  otherwise a dev app launched from an agent silently changes its child CLIs.
  The login shell may set them again intentionally.
  Codex's `activity` title remains fallback activity evidence, but badge,
  Agent Sessions, and notification presentation strips its redundant braille spinner
  and blinking action-required phases, configured run-state/project/context
  fields, and unnamed-thread UUID instead of displaying them as a conversation
  topic. Built-in Codex launches also apply a launch-scoped
  `activity`/`thread-title`/`task-progress` list; custom definitions and agents
  launched manually in a shell keep their user-owned configuration.
  Claude titles are cleaned the same way: the
  leading sparkle/spinner glyph (· ✢ ✳ ✶ ✻ ✽) is dropped and a bare
  "Claude Code" is the product default, not a topic; any other Claude title
  passes through verbatim. Both terminal docks consume the
  same cleaned OSC topic; titles are presentation metadata, never lifecycle
  authority.
- Semantic **Done** is derived from a work stretch (a per-generation flag, not
  working→idle adjacency) that ended while the pane was unseen — an unanswered
  blocked prompt going quiet, or idle reached fresh after launch with no
  intervening stretch, is plain idle instead. A pane counts as watched only
  when it is visible (`offsetParent !== null`) AND the app is foreground.
  Blocked is retained through an inconclusive screen read and through
  viewing/acknowledgement (acknowledgement clears only the activity tracker's
  attention ping, never its `completed` turn-boundary signal); a still-latched
  notification under an existing prompt is corroboration, not a new prompt,
  and must not rewrite its reason/rule. Resumed work (a `busy` activity
  signal) always wins and clears blocked regardless of authority, but for a
  screen-authority prompt only indirectly — via the next inconclusive/unknown
  screen read handing off to the activity fallback, not a direct override.
  The `completed` turn-boundary signal, by contrast, IS authority-gated: it
  can only clear an osc-only prompt (no corroborating screen read), and only
  when observed strictly after the ring that established it (`completionSeen`,
  one-shot); a screen-authority prompt is never cleared by `completed` alone.
  Process exit/replacement unconditionally resets lifecycle regardless of the
  above. Viewing acknowledges Done; viewing blocked
  only dismisses its alert and MUST NOT clear lifecycle without new evidence.
  An acknowledged prompt stays seen
  while the SAME prompt (generation+reason+matchedRule) keeps re-classifying;
  a genuinely new prompt (including re-entry after acknowledgement) alerts
  again. Rollup priority is blocked > done > working > idle/unknown/absent.
  Runtime, seen state, terminal metadata/layout, and notification toggles are
  never persisted; both terminal docks start closed and empty on app launch.
- Every detected dedicated-agent generation owns one session-only `AgentTask`.
  Lifecycle and review are independent: Done never means checks passed.
  Shared-checkout review scope is the entire repository since base HEAD;
  isolated agents additionally capture a stable `IsolatedTask` owner. See
  `docs/architecture/attention-review.md` and
  `docs/architecture/isolated-agent-tasks.md`.
- Worktree cleanup never deletes a branch. Normal Git removal must refuse a
  dirty or locked checkout before the UI may offer a confirmed force retry;
  locked removal requires Git's double-force form. A live global terminal or a
  retained child task bound to the checkout blocks removal, and successful
  removal prunes non-live session terminal records and rebinds global-group
  navigation memory for that path. Merge requires the owning agent to be
  proven idle or stopped and must prove both paths belong to the same Git
  worktree set. Create/merge/remove/keep/archive/restore operations sharing a
  parent or checkout path are serialized, and task outcomes change only through
  expected-state compare-and-set transitions. Workspace close, task archive, task-record deletion, and
  checkout removal are distinct transitions; records with live bound terminals
  retain their preview-port reservation and cannot be deleted.
- Review fingerprints are backend-only content hashes. Plain-text context
  peek is explicit, capped at 12 logical lines/4,096 characters, and component-only.
  Never log or persist terminal snapshots or check output.
- Opening review evidence and marking it reviewed are separate, pinned actions.
  Never let async navigation acknowledge a newer occupant generation or
  repository fingerprint than the one the user opened.
- A prompt-owned user Enter in a detected agent terminal is delayed until
  `git_checkpoint_snapshot` atomically captures opaque review hashes and
  tracked/untracked non-ignored content in an unreachable Git tree through a
  private index. The real index is never mutated. A checkpoint error must
  withhold Enter and be surfaced; never silently submit an uncheckpointed
  prompt. Checkpoint diffs are read-only evidence and cannot undo external
  effects.
- Queued/steered automation prompts are session-only, capped at 8,192 characters, pinned
  to the detected occupant generation, and checkpoint inside their reserved
  terminal-input slot before sending. Dispatch resets the screen-evidence
  boundary; a committed user/automation turn gates later queued input until
  generation-owned post-boundary output reaches a stable non-unknown semantic
  state, including fast idle-to-idle turns. Settlement counts landed
  classifications (one per debounce-settled screen inspection, not per raw
  PTY write) and excludes the dispatch echo: the first landed classification
  after dispatch is the CLI echoing the submitted prompt into its own
  composer, so at least one further landing is required before a non-unknown
  classification counts as settled (`promptTurnSettledByScreen`,
  `DISPATCH_ECHO_LANDINGS`). Do not infer turn completion from `pty_write`
  returning. Timeout or
  cancellation removes pending text before it can reach the PTY. Never
  persist a prompt queue, truncate instructions silently, or retarget it after
  process replacement. Multiline
  programmatic prompts must go through `TermSession.sendPrompt()` so terminal
  controls are stripped and only one final Enter is submitted.
- The local agent-control socket synchronizes privacy-bounded semantic state
  into Rust; Rust never reads screen text or writes PTYs directly. Keep the
  global token out of repository processes, enforce exact project scope for
  short-lived capabilities, explicitly delegate isolated-child scope created by
  those capabilities, and preserve snapshot → ordered events → resync semantics.
  Every frontend action crosses Rust's request/delivery commit boundary
  immediately before its irreversible step; cancellation may win before that
  boundary and must report already committed after it, never a false successful
  cancellation.
  See `docs/architecture/agent-control.md`.
- Check completion comes only from a random-nonce private OSC marker. Never
  parse terminal prose for exit status. Closed/exited sessions cancel evidence;
  automatic checks require persisted project trust. A pass is valid only when
  its pre/post fingerprint is stable; one formatter mutation reruns the full
  DAG, while a second invalidates it. Check panes are never reused because the
  user may have taken over their shell after completion. A coalesced autorun
  must revalidate generation, selected root, enablement, and trust immediately
  before starting.
- ALL dock terminals (both groups) decouple PTY lifetime from React via the
  session registry: host unmount = `detach()` ONLY (drag-and-drop and split
  rewraps remount bystander panes); the PTY dies exclusively via
  `disposeSession()` — reached through `closeAgentTerminal()`,
  `closeWorkspaceTerminal()`, or `closeWorkspace` (which disposes that
  workspace's sessions explicitly, since unmounting no longer kills
  anything). Never call `dispose()` from an effect cleanup, and never call a
  dock store's `closeTerminal` directly from UI (it would leak the shell).
  Agent terminals belong to a `workspacePath`, not a workspace: they keep
  running when their project closes during the current app session
  ("disconnected" ⊘ badge; clicking reopens the project). Terminal metadata,
  layout, and PTYs do not cross app launches, so every launch starts with an
  empty global dock.
- NEVER `fit.fit()` a hidden (display:none) xterm host: xterm 6 measures
  glyphs via OffscreenCanvas even unrendered, so FitAddon doesn't bail — it
  resizes the terminal+PTY to a bogus ~10×5 grid. Guard every fit path with
  `host.offsetParent !== null` (mount fit, debounced fit, reveal fit).
- `fs_read_file` truncates files >5 MB (editor becomes read-only); binary =
  NUL in the first 8 KB **or invalid UTF-8** (we refuse to lossy-decode: a
  lossy round-trip through the editor would corrupt the file on save).
  Supported raster extensions bypass the text reader through `fs_read_image`,
  which returns a CSP-safe data URL and rejects payloads over 25 MB; SVG stays
  on the text-editor path.
  `fs_write_file` is atomic (temp file + rename) and writes through symlinks.
- The editor and worktree/staged diffs reload on external changes (terminal
  git commands, formatters); editable file/worktree-diff saves guard against
  disk conflicts and preserve the original line ending. Don't bypass their
  `editorBuffers.ts` save contract with direct `fsWriteFile` calls.
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
