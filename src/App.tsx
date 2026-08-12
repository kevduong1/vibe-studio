import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getRecentRepos,
  restoreSession,
  useActiveWorkspace,
  useWorkspacesStore,
  WorkspaceContext,
  type Workspace,
} from "./stores/workspaces";
import { useUiStore } from "./stores/ui";
import { closeTabSafely } from "./stores/editor";
import { useProjectColorVar } from "./lib/projectColors";
import { listenTermFileDrops } from "./lib/termFileDrop";
import { initZoom, zoomIn, zoomOut, zoomReset } from "./lib/zoom";
import { loadTasks, sortForPicker, type TaskDef } from "./lib/tasks";
import { runTask } from "./lib/taskRunner";
import TaskPicker from "./components/TaskPicker";
import QuickOpen from "./components/QuickOpen";
import type { AgentLaunchRequest } from "./lib/agentLaunchRequest";
import type { AgentLaunchProfile } from "./stores/agentDefinitions";
import Titlebar from "./components/Titlebar";
import StatusBar from "./components/StatusBar";
import FileExplorer from "./components/FileExplorer";
import SearchPanel from "./components/SearchPanel";
import SourceControl from "./components/SourceControl";
import MemoriesPanel from "./components/MemoriesPanel";
import EditorArea from "./components/EditorArea";
import Panel from "./components/Panel";
import { Resizer } from "./components/Resizer";
import { IcBrain, IcBranch, IcFile, IcSearch, IcTree } from "./components/icons";
import { listenAgentNotificationActivations } from "./lib/agentInbox";
import { listenNativeAgentSessionCapture } from "./lib/nativeAgentSessions";
import { listenAgentControlPlane } from "./lib/agentControlPlane";

const SettingsModal = lazy(() => import("./components/SettingsModal"));
const AgentLaunchDialog = lazy(() => import("./components/AgentLaunchDialog"));
const WorktreeDialog = lazy(() => import("./components/WorktreeDialog"));
const IsolatedTasksPanel = lazy(() => import("./components/IsolatedTasksPanel"));

/** Slim far-left icon strip for switching sidebar panels. */
function ActivityBar() {
  const ws = useActiveWorkspace();
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const setSidebarTab = useUiStore((s) => s.setSidebarTab);
  const active = (tab: string) => sidebarVisible && sidebarTab === tab;

  return (
    <div className="activity-bar">
      <button
        className={`activity-btn ${active("explorer") ? "active" : ""}`}
        title="Explorer"
        onClick={() => setSidebarTab("explorer")}
      >
        <IcFile />
      </button>
      <button
        className={`activity-btn ${active("tasks") ? "active" : ""}`}
        title="Git Worktrees"
        onClick={() => setSidebarTab("tasks")}
      >
        <IcTree />
      </button>
      <button
        className={`activity-btn ${active("search") ? "active" : ""}`}
        title="Search (⌘⇧F)"
        onClick={() => setSidebarTab("search")}
      >
        <IcSearch />
      </button>
      <button
        className={`activity-btn ${active("scm") ? "active" : ""}`}
        title="Source Control"
        onClick={() => setSidebarTab("scm")}
      >
        <IcBranch />
        {ws && <ChangeCountBadge ws={ws} />}
      </button>
      <button
        className={`activity-btn ${active("memories") ? "active" : ""}`}
        title="Project Memories (Claude & Codex)"
        onClick={() => setSidebarTab("memories")}
      >
        <IcBrain />
      </button>
    </div>
  );
}

/** Uncommitted-change count of the active workspace. */
function ChangeCountBadge({ ws }: { ws: Workspace }) {
  const changeCount = useStore(
    ws.repo,
    (s) => (s.status?.staged.length ?? 0) + (s.status?.unstaged.length ?? 0),
  );
  if (changeCount === 0) return null;
  return <span className="badge">{changeCount}</span>;
}

function Welcome() {
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const [recent] = useState(getRecentRepos);

  // window.alert is a silent no-op in WKWebView — use the dialog plugin.
  const showOpenError = (e: unknown) =>
    void message(`Not a git repository:\n${e}`, {
      title: "Cannot open folder",
      kind: "error",
    });

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") {
      try {
        await openWorkspace(dir);
      } catch (e) {
        showOpenError(e);
      }
    }
  };

  return (
    <div className="welcome">
      <h1>Vibe Studio</h1>
      <div>Open a git repository to get started</div>
      <button className="open-btn" onClick={pickFolder}>
        Open Folder…
      </button>
      {recent.length > 0 && (
        <div className="recent">
          <div className="label">Recent</div>
          {recent.map((p) => (
            <button
              key={p}
              onClick={() => void openWorkspace(p).catch(showOpenError)}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One workspace's sidebar content / editor surface. EVERY workspace's pair
 * stays mounted; inactive ones are hidden with display:none so editor
 * buffers and explorer state are exactly as the user left them when
 * switching back. (Terminals live in the global bottom panel —
 * components/Panel.tsx.)
 */
function WorkspaceSidebarContent({ visible }: { visible: boolean }) {
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  return (
    <div
      className="app-sidebar-content"
      style={{ display: visible ? undefined : "none" }}
    >
      {sidebarTab === "explorer" ? (
        <FileExplorer />
      ) : sidebarTab === "search" ? (
        <SearchPanel />
      ) : sidebarTab === "tasks" ? (
        <Suspense fallback={<div className="sidebar-empty">Loading worktrees…</div>}>
          <IsolatedTasksPanel />
        </Suspense>
      ) : sidebarTab === "memories" ? (
        <MemoriesPanel />
      ) : (
        <SourceControl />
      )}
    </div>
  );
}

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

/** Survives StrictMode's dev double-mount (App is mounted once). */
let sessionRestored = false;

export default function App() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activePath = useWorkspacesStore((s) => s.activePath);

  // Reopen last session's workspaces on launch (VSCode-style).
  useEffect(() => {
    if (sessionRestored) return;
    sessionRestored = true;
    void restoreSession();
  }, []);

  // Native file drops onto terminal panes paste the shell-quoted paths
  // (image attachments for agent CLIs, plain paths for shells).
  useEffect(() => listenTermFileDrops(), []);
  useEffect(() => listenNativeAgentSessionCapture(), []);
  useEffect(() => listenAgentControlPlane(), []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAgentNotificationActivations().then((value) => {
      if (disposed) value();
      else unlisten = value;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Restore the persisted zoom level (the webview always opens at 1).
  useEffect(() => initZoom(), []);

  const togglePanel = useUiStore((s) => s.togglePanel);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // ⌘⇧B task picker (null = closed). The lone default build task runs
  // without the picker; everything else (or a parse error) opens it.
  const [taskPick, setTaskPick] = useState<{
    ws: Workspace;
    tasks: TaskDef[];
    error: string | null;
  } | null>(null);

  // The picker is workspace-bound: if its workspace closes or another one
  // becomes active underneath it (titlebar click — keyboard shortcuts are
  // swallowed by the picker itself), a pick would run the task in an
  // invisible dock. Drop the picker instead. runTask's own liveness check
  // backstops the no-picker (lone default build) path.
  useEffect(() => {
    if (taskPick && taskPick.ws.path !== activePath) setTaskPick(null);
  }, [taskPick, activePath]);

  // ⌘P quick open (null = closed). Workspace-bound like the task picker:
  // its file list belongs to one workspace, so navigating away drops it.
  const [quickOpen, setQuickOpen] = useState<Workspace | null>(null);
  useEffect(() => {
    if (quickOpen && quickOpen.path !== activePath) setQuickOpen(null);
  }, [quickOpen, activePath]);

  // ⌘, settings. NOT workspace-bound: settings are global and must work
  // with zero workspaces open.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentLaunch, setAgentLaunch] = useState<AgentLaunchRequest | null>(null);
  const [profileWorktree, setProfileWorktree] = useState<{
    parent: Workspace;
    profile: AgentLaunchProfile;
  } | null>(null);
  const [newTaskWorkspace, setNewTaskWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    const onLaunch = (event: Event) => {
      setAgentLaunch((event as CustomEvent<AgentLaunchRequest>).detail);
    };
    window.addEventListener("vibe:launch-agent", onLaunch);
    const onWorktree = (event: Event) => {
      const detail = (event as CustomEvent<{ workspacePath: string; profile: AgentLaunchProfile }>).detail;
      const parent = useWorkspacesStore
        .getState()
        .workspaces.find((workspace) => workspace.path === detail.workspacePath);
      if (parent) setProfileWorktree({ parent, profile: detail.profile });
    };
    window.addEventListener("vibe:new-worktree-agent", onWorktree);
    const onNewTask = (event: Event) => {
      const detail = (event as CustomEvent<{ workspacePath: string }>).detail;
      const parent = useWorkspacesStore
        .getState()
        .workspaces.find((workspace) => workspace.path === detail.workspacePath);
      if (parent) setNewTaskWorkspace(parent);
    };
    window.addEventListener("vibe:new-isolated-task", onNewTask);
    return () => {
      window.removeEventListener("vibe:launch-agent", onLaunch);
      window.removeEventListener("vibe:new-worktree-agent", onWorktree);
      window.removeEventListener("vibe:new-isolated-task", onNewTask);
    };
  }, []);

  // global keyboard shortcuts
  useEffect(() => {
    const runBuildTask = async (ws: Workspace) => {
      let tasks: TaskDef[] = [];
      let error: string | null = null;
      try {
        tasks = await loadTasks(ws.path);
      } catch (e) {
        error = String(e);
      }
      const defaults = tasks.filter((t) => t.isDefaultBuild);
      if (defaults.length === 1) runTask(ws, defaults[0]);
      else setTaskPick({ ws, tasks: sortForPicker(tasks), error });
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "`") {
        e.preventDefault();
        togglePanel();
      } else if (e.key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key.toLowerCase() === "b" && e.shiftKey) {
        // ⌘⇧B: run the (.vscode/tasks.json) build task, VS Code-style
        e.preventDefault();
        const { workspaces, activePath } = useWorkspacesStore.getState();
        const ws = workspaces.find((w) => w.path === activePath);
        if (ws) void runBuildTask(ws);
      } else if (e.key.toLowerCase() === "f" && e.shiftKey) {
        // ⌘⇧F: workspace search — reveal the sidebar + focus the query input
        e.preventDefault();
        useUiStore.getState().showSearch();
      } else if (e.key === "p" && !e.shiftKey && !e.altKey) {
        // ⌘P: quick-open a file by fuzzy name
        e.preventDefault(); // WKWebView would otherwise open the print dialog
        const { workspaces, activePath } = useWorkspacesStore.getState();
        const ws = workspaces.find((w) => w.path === activePath);
        if (ws) setQuickOpen(ws);
      } else if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        const { workspaces, activePath } = useWorkspacesStore.getState();
        const ws = workspaces.find((w) => w.path === activePath);
        const activeTabId = ws?.editor.getState().activeTabId;
        if (ws && activeTabId) void closeTabSafely(ws.editor, activeTabId);
      } else if (e.key >= "1" && e.key <= "9" && !e.shiftKey && !e.altKey) {
        // ⌘1…⌘9: jump to the Nth workspace tab
        const { workspaces, setActive } = useWorkspacesStore.getState();
        const ws = workspaces[Number(e.key) - 1];
        if (ws) {
          e.preventDefault();
          setActive(ws.path);
        }
      } else if (e.key === "=" || e.key === "+") {
        // ⌘+ zoom in ("=" is the physical ⌘+ key; "+" covers ⌘⇧= and numpad)
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        zoomReset();
      } else if (e.key === ",") {
        // ⌘,: settings (macOS convention)
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, toggleSidebar]);

  const hasWorkspaces = workspaces.length > 0;
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const panelMaximized = useUiStore((s) => s.panelMaximized);

  // The whole accent family (commit button, rings, selections — derived from
  // --accent via color-mix in theme.css) follows the active project's color.
  const accentVar = useProjectColorVar(activePath);
  const accentStyle = accentVar
    ? ({ "--accent": accentVar } as CSSProperties)
    : undefined;

  return (
    <div className="app" style={accentStyle}>
      <Titlebar />
      <div className="app-main">
        {hasWorkspaces && <ActivityBar />}
        {/* Sidebar spans the full app height; the bottom panel sits beside
            it, under the editor column only. */}
        {hasWorkspaces && sidebarVisible && (
          <div className="app-sidebar" style={{ width: sidebarWidth }}>
            {workspaces.map((ws) => (
              <WorkspaceContext.Provider key={ws.path} value={ws}>
                <WorkspaceSidebarContent visible={ws.path === activePath} />
              </WorkspaceContext.Provider>
            ))}
            <Resizer
              direction="vertical"
              onDelta={(d) =>
                setSidebarWidth(useUiStore.getState().sidebarWidth + d)
              }
            />
          </div>
        )}
        <div className="app-center">
          {hasWorkspaces ? (
            // Hidden (not unmounted) while the panel is maximized — editor
            // buffers/scroll state follow the workspace-switch survival rule.
            <div
              className="app-editor-area"
              style={{ display: panelMaximized ? "none" : undefined }}
            >
              {workspaces.map((ws) => (
                <WorkspaceContext.Provider key={ws.path} value={ws}>
                  <WorkspaceEditor visible={ws.path === activePath} />
                </WorkspaceContext.Provider>
              ))}
            </div>
          ) : (
            <Welcome />
          )}
          {/* Mounted in a stable position for either branch above, so the
              docks (and their shells) survive the 0↔N workspace transition. */}
          <Panel />
        </div>
      </div>
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
      {taskPick && (
        <TaskPicker
          tasks={taskPick.tasks}
          error={taskPick.error}
          onRun={(t) => {
            setTaskPick(null);
            runTask(taskPick.ws, t);
          }}
          onClose={() => setTaskPick(null)}
        />
      )}
      {quickOpen && (
        <QuickOpen ws={quickOpen} onClose={() => setQuickOpen(null)} />
      )}
      <Suspense fallback={null}>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
        {agentLaunch && (
          <AgentLaunchDialog request={agentLaunch} onClose={() => setAgentLaunch(null)} />
        )}
        {profileWorktree && (
          <WorktreeDialog
            parent={profileWorktree.parent}
            mode="create-agent"
            launchProfile={profileWorktree.profile}
            onClose={() => setProfileWorktree(null)}
          />
        )}
        {newTaskWorkspace && (
          <WorktreeDialog
            parent={newTaskWorkspace}
            mode="create-agent"
            onClose={() => setNewTaskWorkspace(null)}
          />
        )}
      </Suspense>
    </div>
  );
}
