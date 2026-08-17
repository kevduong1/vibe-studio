<div align="center">
  <img src="app-icon.png" width="128" height="128" alt="Talos icon" />

# Talos

**The IDE for agent-driven coding.** Git, terminals, diffs, and a first-class dock for
AI coding agents — in a fast, minimal, native macOS app.

![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri_2-24C8D8?logo=tauri&logoColor=white)
![React 19](https://img.shields.io/badge/React_19-087EA4?logo=react&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-DEA584?logo=rust&logoColor=black)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

Like VS Code without all the extra stuff: source control you can see, real
terminals, a proper diff viewer, and multi-repo workspaces built around
agent-driven development. Built with [Tauri 2](https://tauri.app) — native
WKWebView, no bundled Chromium — so it stays light on CPU and RAM.

The interface uses a modern, layered dark workspace: rounded inset surfaces,
matching editor/diff and terminal canvases, project-tinted accents, and
elevated command overlays keep dense repository, editor, and terminal workflows
easy to scan. Pick Midnight, Charcoal, Soft
Gray, Slate, or one of 18 additional neutral, cool, warm, earth, and jewel
palettes in **Settings → Appearance**; the app remembers the background palette
across launches.

## Features

### 🗂 Multi-repo workspaces

- Every open repo is a tab in the titlebar with its own editor, terminals,
  search, and source control — all workspaces stay alive, so switching is
  instant and nothing reloads
- Jump with **⌘1–9**, double-click a tab to rename it, right-click to pick a
  **per-project accent color** that tints the whole app
- Session restore: your workspaces, layouts, and agent terminals come back
  on relaunch

### 🌱 Source control

- Stage / unstage / discard, commit (+ amend, commit & push), stash
  (save / apply / pop / drop), fetch / pull / push using your existing git
  auth and credential helpers
- Right-click a staged or working-tree change to open the file or pinned diff,
  or use the applicable stage, unstage, and discard actions
- **Commit graph** with colored branch lanes, branch & tag pills, and a
  branch filter; virtualized so huge histories stay smooth. The checked-out
  branch takes the active project's color, and a branch held by another
  worktree takes that checkout's project color (when it has one)
- Click a commit to browse and diff its files; multi-select + right-click
  for checkout, branch creation, squash, and copy-SHA
- A debounced file watcher keeps status, log, and graph live — including
  changes made by external `git` commands

### 🤖 Global terminals

A global dock for persistent shells and AI coding agents:

- Start a plain shell, **Claude Code**, or **Codex** in the project root —
  quit an agent and you're back in its shell
- Dedicated Codex tabs intentionally launch with `codex --yolo` by default
- Global terminals are pinned to a **project**, not a window — they keep
  running when their workspace closes, and clicking one jumps straight to
  its project
- Semantic **Working / Needs Input / Done / No Agent** state distinguishes a
  live agent from the shell it returns to, with accessible text, icons, and
  priority rollups across the dock, titlebar tabs, and status bar; each leaf
  terminal tab keeps its requested Claude/Codex icon beside its state
  indicator. If the other supported agent is started in that shell, runtime
  state follows the detected process and the tooltip explains the mismatch
- Claude or Codex launched manually inside a plain shell is discovered too;
  Settings shows versioned detection-profile and current-match diagnostics
  without retaining terminal text, arguments, prompts, or environment.
  **Needs Input** requires a complete CLI-owned prompt or error phrase, so
  ordinary agent prose does not claim attention merely for sharing a keyword
- Live badges in both terminal docks combine semantic state with each agent's
  current OSC terminal topic; tooltips explain the state authority and
  structured reason. Claude's contextual title works by default (leave
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` unset); `claude -n <name>` or `/rename`
  supplies a stable topic. For Codex, a useful `~/.codex/config.toml` setup is
  `terminal_title = ["activity", "thread-title", "task-progress"]` under
  `[tui]`; `/title` edits the same setting, and naming the thread makes
  `thread-title` descriptive. Talos keeps `activity` as fallback evidence
  while hiding its spinner/action-required phases, semantic run-state,
  redundant project name, and unnamed-thread UUID from the displayed topic
- Optional per-terminal sound and macOS banners alert once for background
  questions/permissions or unseen completion; clicking a banner returns to
  the exact terminal
- A global **Agent Sessions** view (the first activity-rail item, the titlebar
  shortcut, or **⌘⇧I**) combines both docks in attention / active / quiet
  sections, with exact-terminal navigation, a bounded review-context peek,
  independent review status, and check evidence
- Drag & drop tabs into splits; layout persists across restarts
- Drop a file or image from Finder onto a pane to paste its path — image
  drops work with Claude Code out of the box

### ✨ Agent Sessions & review

Agent Sessions turns live agent activity into persistent global navigation
across global and project terminals. It sits above a divider in the activity
rail; Explorer, Worktrees, Search, Source Control, and Memories remain
workspace-specific below it.

- Open it from the top activity icon, the top-right titlebar shortcut, or with
  **⌘⇧I**. It remains available with no repository open. **Attention** shows
  actionable agents; **All** includes active, idle, accepted, and unavailable
  sessions.
- Actionable items keep the strict urgency order: **Needs Input**, conflicts or
  failed checks, then completed/unreviewed/stale approvals. Active and quiet
  rows keep stable registration order so normal status ticks do not move the
  session you were about to select.
- Every row includes agent identity, terminal/topic title, project, elapsed
  time, textual lifecycle state, and separate review/check evidence. Row
  highlights and accent-colored states match the source project's color, even
  when another workspace is active. Detected child agent processes appear as a
  bounded count, not as invented conversation history.
- Opening an item activates the exact project, panel side, dock grouping, tab,
  and terminal. Closed global-terminal projects are reopened when possible.
  **⌘⌥↓** and **⌘⌥↑** cycle through actionable agents.
- **Peek context** explicitly reads only the last 12 logical terminal lines,
  capped at 4,096 characters. The text stays in the detailed review overlay
  and is never persisted, logged, or added to task history.
- macOS notification clicks use the same exact-terminal routing. A notification
  for a terminal that has since closed opens the session/review surface with a
  nonfatal message.

This first version is intentionally a live-session navigator, not provider
transcript history: terminal metadata/layout may persist, but PTYs, lifecycle,
review state, and terminal text remain session-only. Restored global tabs still
start as fresh shells.

Each dedicated agent launch owns a session-only review task tied to that exact
terminal occupant. Review state is intentionally independent from terminal
lifecycle: **Done** means an unseen idle agent, not that its work passed checks
or was approved.

- Human review states cover **Clean**, **Unreviewed**, **Reviewed**,
  **Feedback**, **Approval Stale**, and **Accepted**. Conflicts and check results
  are shown separately instead of controlling approval.
- Talos captures the launch's base commit and refreshes privacy-bounded
  Git evidence as the repository changes. Committed, staged, working-tree, and
  untracked changes, executable modes, conflict stages, and dirty submodules
  are included; file contents are hashed in Rust and never retained in the
  frontend. Unborn repositories are supported, while late/manual-launch
  baselines are clearly marked as potentially incomplete review boundaries.
- **Review changes** opens Source Control and the first current worktree/index
  diff when one is available. Return to detailed review and explicitly **Mark
  reviewed** after inspecting that exact fingerprint; only then does **Accept**
  become available. Async navigation cannot acknowledge a newer generation or
  repository state. Checks are optional evidence and do not gate acceptance. **Needs changes**
  records feedback and returns to the terminal without sending text. If the
  repository changes after acceptance, Agent Sessions marks that approval stale.
- Agents in a normal workspace still use “all repository changes since the
  base commit” scope. For isolated ownership, choose **New Task…** from the
  Worktrees sidebar or titlebar **+** menu.

### 🌿 Git worktrees & isolated agent tasks

- **New Worktree…**, **Open Worktree…**, and **New Task…** create or open
  linked checkouts as ordinary workspaces. New Task also launches the selected
  agent. The root is configurable;
  repositories can opt into bootstrap, ignored-file includes, and a preview
  port range with `.talos/worktrees.json`.
- The Worktrees sidebar lists the main checkout and every linked worktree Git
  knows about for the current repository, including worktrees created outside
  Talos. It shows branch/detached state, HEAD, main/linked and
  locked/prunable status, and lets you open or switch to another checkout.
  Ordinary worktrees stay in compact rows; Talos-owned task rows expand for
  review evidence, plans, feedback, and lifecycle actions. The activity-bar
  tree icon opens this view. Ordering remains stable while switching: the main
  checkout comes first, followed by branch and path, while **Current** is only
  a status badge.
  Live Git data remains authoritative; ordinary worktrees are never silently
  adopted as Talos-owned tasks. **New Task** creates an isolated worktree and
  launches the selected agent; **Removed tasks** appears only when task records
  remain after their Git checkouts were deleted. Every linked worktree has a
  confirmed remove action that keeps its branch; the main checkout cannot be
  removed. A checkout that parents retained child tasks cannot be removed, and
  confirmed force removal handles both dirty and locked worktrees. Task rows
  separately support permanent **Delete Task Record**, which deletes Talos
  metadata while leaving its worktree and branch intact after bound terminals
  have stopped.
- Talos-owned worktree rows additionally combine whole-task/latest-turn
  changes, conflicts, checks, diagnostics, commits, previews, agent state, and
  read-only child-agent rows. Every live worktree row uses the same path-keyed
  project color as its workspace tab; removed history falls back to its parent
  project's color.
  Prompt-owned turns snapshot into a private Git tree first, so latest-turn
  files open as checkpoint-to-current diffs without changing the real index.
  Line comments are pinned to the exact generation and review fingerprint where
  they were drafted. Current comments can be batched into a follow-up only while
  that same agent generation owns an idle/question prompt; outdated drafts stay
  visible for removal instead of being silently sent against newer evidence.
- Editable task plans support dependencies, explicit queue versus steer, one
  isolated worktree per approved independent step, and two-to-four-candidate
  Best-of-N runs whose results remain separate comparable task cards.
- Archives keep code restoration separate from conversation restoration. An
  unambiguous local Codex thread can be validated and resumed after approval;
  absent, stale, or ambiguous references fall back to a fresh shell without
  guessing or using `--last`.
- Task outcomes are explicit: **Apply / Merge**, **Keep Branch**, **Archive**,
  and **Remove Worktree**. Closing, archiving, checkout deletion, and permanent
  task-record deletion are separate. Git
  gets the first dirty/locked-removal refusal; force requires confirmation; live
  global terminals block removal; successful cleanup forgets deleted checkout
  paths in global terminal groups; branches are never deleted implicitly.
- Agent buttons open a launch sheet for each definition's supported model,
  reasoning, permission, and sandbox controls, plus validated environment,
  one-argument-per-line extras, and current/worktree folder choice. Conversation
  restore remains an explicit archived-task action. The initial Codex profile remains
  `codex --yolo`. Integrations reports
  executable health/version/capabilities and supports stable-ID custom commands;
  each custom executable basename participates in semantic detection under its
  selected Claude/Codex profile, with conflicting assignments rejected.

Repository checks come from `.vscode/tasks.json`:

- Tasks in the `build` or `test` groups can be selected as pipeline roots.
  Compound tasks are supported, dependencies run in parallel by default, and
  `dependsOrder: "sequence"` preserves listed order.
- Reachable duplicate labels, malformed execution/dependency fields, missing
  dependencies, cycles, unsupported/background tasks, and unavailable or unknown variables are
  rejected before execution; unrelated broken tasks do not block the pipeline.
- Check nodes run in fresh app-reserved project terminals. Exit status is
  reported by a private nonce-bound terminal marker instead of parsing output;
  closing a terminal cancels the node rather than inventing a failure.
- Checks compare pre/post fingerprints and rerun the full DAG once when a
  formatter changes the tree; another mutation invalidates the evidence. Any
  later repository mutation also makes a pass stale. The latest 20
  structured runs are kept for the current app session, without raw output.
- Manual runs are explicitly authorized by the click. **Auto-run on turn
  completion** requires one project-scoped approval before repository commands
  may run automatically, and that approval can be revoked in review detail. Queued
  follow-ups revalidate the generation, selected root, enablement, and trust
  immediately before running.

### ⌨️ Project terminals

- Real PTYs running your login shell, Claude Code, or Codex, with tabs,
  side-by-side splits, and drag-and-drop layout
- Dedicated Codex tabs intentionally launch with `codex --yolo` by default
- Dedicated Claude/Codex tabs use the same semantic state, Done tracking,
  rollups, and optional notification toggle as global agent terminals
- WebGL-accelerated rendering (xterm.js 6) with backpressure-aware
  streaming, so `cat`-ing a huge file won't wedge the app
- **⌘⇧B task runner**: VS Code-compatible `.vscode/tasks.json`, with a
  quick-pick overlay, `${variable}` substitution, and panel reuse rules
- Agent check pipelines use build/test task roots and support compound tasks,
  parallel `dependsOn`, and `dependsOrder: "sequence"`; automatic runs require
  explicit, revocable per-project approval. Checks use fresh reserved terminals
  and compare the repository before/after execution, rerunning once when a
  formatter changes the tree rather than certifying untested edits
- Settings can save user-owned commands as per-project terminal recipes. Each
  recipe has its own explicit run-on-restore switch; recipes default to off.

### ✍️ Editor & navigation

- CodeMirror 6 tabs with on-demand language loading, unsaved-draft
  recovery, preserved LF/CRLF/CR line endings, and external-change reload
  with save-conflict protection
- **Provisional tabs** — single-clicking Explorer, search, source-control, or
  commit files reuses one italic tab; editing, double-clicking the file/tab,
  or **Keep Open** pins it. Pinned file/diff tabs restore on relaunch
- Drag tabs to reorder them; middle-click closes; **⌘⇧T** reopens the most
  recently closed tab; tab menus include close-left / close-saved actions
- **⌘P quick open** — fuzzy file matching (gitignore-aware) with match
  highlighting and recently opened files first when the query is empty
- **⌘⇧F workspace search** — parallel Rust walk with case / whole-word /
  regex toggles; results open at the matching line
- **⌘F find & replace** — floating VS Code-style widget in every editor
  and diff
- **Control-G** go to line; Control-Tab / Control-Shift-Tab and
  **⌘⇧[ / ⌘⇧]** cycle tabs
- Lazy file explorer with active-file auto-reveal and complete Left/Right tree
  navigation; whole-app zoom (**⌘+ / ⌘− / ⌘0**)
- Status bar cursor/selection, detected indentation, line-ending, and persisted
  word-wrap controls; optional one-second Auto Save in Settings
- Closing a dirty tab/workspace or quitting offers native
  **Save / Don’t Save / Cancel** protection
- A file tab's context menu can send the bounded current selection, file
  reference, or diff-review request to a safe idle/question-owned agent in the
  same project; working or permission-blocked agents are never steered implicitly

### 🔌 Local agent automation

- The bundled `talos-agent` CLI lists privacy-bounded semantic snapshots,
  follows ordered events, starts isolated agents, focuses terminals, queues or
  explicitly steers prompts, and waits with timeouts/cancellation pinned to the
  exact occupant generation. Cancellation is authoritative before the final
  action commit; afterward the CLI reports that the action already committed
  instead of claiming an agent launch or prompt delivery was stopped.
- A fresh mode-0600 token and Unix socket live in the per-user app-data
  directory. Short-lived capabilities initially restrict repository automation
  to one exact project and explicitly gain only the isolated checkout paths they
  successfully start; unrelated sibling worktrees remain hidden. The global
  credential is never injected into terminal shells.
- The bundle also includes an agent skill describing the CLI contract. Settings
  shows and can copy the bundled CLI path, and shows socket/token/skill paths,
  but never displays the token value or silently changes your `PATH`.

### 📱 Responsive localhost previews

- Click the editor tab strip **+** and choose **Open Preview…** to open an
  interactive preview in its own editor tab
- Enter a localhost URL manually, or choose a detected server grouped under
  **This project** or **Other local servers**; every invocation creates a new
  preview tab that lasts only for the current app session
- Use phone, tablet, laptop, HD, or 1920×1080 presets, enter custom viewport
  dimensions, or rotate the current size; large viewports fit the editor while
  preserving their responsive CSS dimensions
- The toolbar also supports back/forward, reload, address changes, and opening
  the page externally
- Expo projects must run their web target (for example,
  `npx expo start --web`) before they can appear as an interactive preview;
  native-only app behavior still requires Apple Simulator or a physical device

### 🔍 Diff viewer

- Side-by-side or unified, syntax-highlighted, unchanged regions collapsed
- Working-tree diffs are **editable** — fix what you see and ⌘S saves it
- **Open File** in the toolbar, tab menu, and source context menu; normal file
  tabs offer the reverse **View Changes** action
- Previous/next hunk navigation from the toolbar or **Shift-F7 / F7**
- Auto-refreshes when the repo changes underneath it

## Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘ P | Quick open file |
| ⌘ ⇧ F | Search across the workspace |
| ⌘ F | Find / replace in the editor |
| Control G | Go to line |
| Control Tab / Control ⇧ Tab | Next / previous editor tab |
| ⌘ ⇧ [ / ⌘ ⇧ ] | Previous / next editor tab |
| ⌘ ⇧ T | Reopen the last closed editor tab |
| F7 / ⇧ F7 | Next / previous diff hunk |
| ⌘ ⇧ B | Run build task |
| ⌘ ⇧ I | Show Agent Sessions |
| ⌘ ⌥ ↓ / ⌘ ⌥ ↑ | Next / previous actionable agent |
| ⌘ ` | Toggle terminal panel |
| ⌘ B | Toggle sidebar |
| ⌘ 1–9 | Switch to the Nth workspace |
| ⌘ W | Close editor tab |
| ⌘ S | Save file / working-tree diff edit |
| ⌘ ↩ | Commit (focus in message box) |
| ⌘ + / ⌘ − / ⌘ 0 | Zoom in / out / reset |

## Architecture

| Layer | Tech |
|---|---|
| Shell | Tauri 2 (Rust) |
| Git | `git2` (libgit2); network ops shell out to `git` CLI for your ssh/credential helpers |
| Terminals | `portable-pty` → base64 events with ack-based flow control → xterm.js 6 |
| Watcher | `notify` (FSEvents), debounced per repo |
| Search & quick open | `ignore`-crate parallel worktree walks in Rust |
| UI | React 19 + Vite, zustand, CodeMirror 6, `@codemirror/merge` |

Contributor guidance lives in [`AGENTS.md`](AGENTS.md) and
[`CLAUDE.md`](CLAUDE.md). The semantic terminal-agent state model and privacy
boundary are documented in
[`docs/architecture/agent-runtime.md`](docs/architecture/agent-runtime.md),
with task review and checks in
[`docs/architecture/attention-review.md`](docs/architecture/attention-review.md),
isolated ownership in
[`docs/architecture/isolated-agent-tasks.md`](docs/architecture/isolated-agent-tasks.md),
and local automation in
[`docs/architecture/agent-control.md`](docs/architecture/agent-control.md).

## Development

```sh
pnpm install
pnpm tauri dev            # run with the orange DEV icon
pnpm tauri build --debug  # package a debug .app with the DEV icon
pnpm tauri build          # package a release .app / .dmg with the release icon
```

The `pnpm tauri` wrapper automatically applies `src-tauri/tauri.dev.conf.json`
to `dev` and `build --debug`. Release builds continue to use only the base
Tauri config, so they keep the normal app name, bundle identifier, and icon.

## Installing / updating the release build

There's no auto-updater — installing and updating are the same operation:
build, then copy the bundle into `/Applications`.

```sh
pnpm tauri build
rm -rf "/Applications/Talos.app" && ditto \
  "src-tauri/target/release/bundle/macos/Talos.app" \
  "/Applications/Talos.app"
```

Notes:

- **Quit the app first** when updating a running install.
- The `rm -rf` matters: `ditto` *merges* into an existing bundle, so copying
  over an old install can leave stale files behind if something was renamed
  or removed between builds. Deleting first guarantees a clean bundle.
- Settings survive updates — persisted state (workspaces, terminal layouts,
  project colors) lives in WebKit storage under `~/Library/` keyed by bundle
  id, not inside the .app. The dev build (`pnpm tauri dev`) keeps its own
  separate state.
- No Gatekeeper friction: locally built apps aren't quarantined (that only
  applies to downloads).

## License

[MIT](LICENSE) © Kevin Duong
