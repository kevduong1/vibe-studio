import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useStore } from "zustand";
import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getRecentRepos,
  restoreSession,
  useActiveEditorTabCount,
  useActiveWorkspace,
  useWorkspacesStore,
  WorkspaceContext,
  type Workspace,
} from "./stores/workspaces";
import { appExit, onAppExitRequested } from "./lib/ipc";
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
import AgentSessionsPanel from "./components/AgentSessionsPanel";
import SourceControl from "./components/SourceControl";
import MemoriesPanel from "./components/MemoriesPanel";
import EditorArea from "./components/EditorArea";
import Panel from "./components/Panel";
import { Resizer } from "./components/Resizer";
import {
  IcBrain,
  IcBranch,
  IcFile,
  IcFolderOpen,
  IcSparkle,
} from "./components/icons";
import { listenAgentNotificationActivations } from "./lib/agentInbox";
import { listenNativeAgentSessionCapture } from "./lib/nativeAgentSessions";
import { listenAgentControlPlane } from "./lib/agentControlPlane";
import { saveDirtyTabs } from "./lib/editorBuffers";
import { useAgentRuntimeStore } from "./stores/agentRuntime";
import {
  agentAttentionTier,
  useAgentTasksStore,
} from "./stores/agentTasks";

const SettingsModal = lazy(() => import("./components/SettingsModal"));
const AgentLaunchDialog = lazy(() => import("./components/AgentLaunchDialog"));
const WorktreeDialog = lazy(() => import("./components/WorktreeDialog"));

/** Slim far-left icon strip for switching sidebar panels. */
function ActivityBar() {
  const ws = useActiveWorkspace();
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const setSidebarTab = useUiStore((s) => s.setSidebarTab);
  const runtimes = useAgentRuntimeStore((state) => state.states);
  const tasks = useAgentTasksStore((state) => state.tasks);
  const actionableCount = useMemo(
    () => Object.values(runtimes).filter(
      (runtime) => agentAttentionTier(runtime, tasks[runtime.terminalId]) <= 3,
    ).length,
    [runtimes, tasks],
  );
  const active = (tab: string) => sidebarVisible && sidebarTab === tab;

  return (
    <nav className="activity-bar" aria-label="Sidebar views">
      <button
        className={`activity-btn ${active("sessions") ? "active" : ""}`}
        title="Agent Sessions (⌘⇧I) · Global"
        aria-label={`Agent Sessions, global${actionableCount ? `, ${actionableCount} need attention` : ""}`}
        aria-pressed={active("sessions")}
        onClick={() => setSidebarTab("sessions")}
      >
        <IcSparkle />
        {actionableCount > 0 && (
          <span className="badge attention" aria-hidden="true">
            {actionableCount > 99 ? "99+" : actionableCount}
          </span>
        )}
      </button>
      {ws && <div className="activity-divider" role="separator" aria-orientation="horizontal" />}
      {ws && <button
        className={`activity-btn ${active("explorer") ? "active" : ""}`}
        title="Explorer"
        aria-pressed={active("explorer")}
        onClick={() => setSidebarTab("explorer")}
      >
        <IcFile />
      </button>}
      {ws && <button
        className={`activity-btn ${active("scm") ? "active" : ""}`}
        title="Source Control"
        aria-pressed={active("scm")}
        onClick={() => setSidebarTab("scm")}
      >
        <IcBranch />
        <ChangeCountBadge ws={ws} />
      </button>}
      {ws && <button
        className={`activity-btn ${active("memories") ? "active" : ""}`}
        title="Project Memories (Claude & Codex)"
        aria-pressed={active("memories")}
        onClick={() => setSidebarTab("memories")}
      >
        <IcBrain />
      </button>}
    </nav>
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
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden="true">
          <IcSparkle />
        </div>
        <div className="welcome-kicker">Talos</div>
        <h1>Build with focus.</h1>
        <p>Open a Git repository and pick up exactly where you left off.</p>
        <button className="open-btn" onClick={pickFolder}>
          <IcFolderOpen />
          Open Repository…
        </button>
        {recent.length > 0 && (
          <div className="recent">
            <div className="label">Recent workspaces</div>
            {recent.map((p) => (
              <button
                key={p}
                title={p}
                onClick={() => void openWorkspace(p).catch(showOpenError)}
              >
                <IcBranch />
                <span className="truncate">{p}</span>
              </button>
            ))}
          </div>
        )}
      </div>
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

  // Window-close and native macOS Cmd+Q safety. Both native requests are held
  // synchronously, share this prompt/save routine, then exit through the
  // explicitly approved Rust command.
  useEffect(() => {
    let disposed = false;
    let resolving = false;
    let unlistenClose: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    const appWindow = getCurrentWindow();
    const resolveExit = async () => {
      if (resolving) return;
      resolving = true;
      const dirtyWorkspaces = useWorkspacesStore
        .getState()
        .workspaces.filter((workspace) =>
          Object.values(workspace.editor.getState().dirty).some(Boolean),
        );
      try {
        if (dirtyWorkspaces.length > 0) {
          const count = dirtyWorkspaces.reduce(
            (sum, workspace) =>
              sum + Object.values(workspace.editor.getState().dirty).filter(Boolean).length,
            0,
          );
          const result = await message(
            `${count} unsaved ${count === 1 ? "file has" : "files have"} changes.`,
            {
              title: "Quit Talos?",
              kind: "warning",
              buttons: {
                yes: count === 1 ? "Save and Quit" : "Save All and Quit",
                no: "Quit Without Saving",
                cancel: "Cancel",
              },
            },
          );
          if (disposed || result === "Cancel") return;
          if (result === "Save and Quit" || result === "Save All and Quit") {
            for (const workspace of dirtyWorkspaces) {
              if (!(await saveDirtyTabs(workspace.editor))) return;
            }
            if (
              useWorkspacesStore
                .getState()
                .workspaces.some((workspace) =>
                  Object.values(workspace.editor.getState().dirty).some(Boolean),
                )
            ) return;
          }
        }
        await appExit();
      } catch (error) {
        console.error("Failed to resolve application exit", error);
      } finally {
        resolving = false;
      }
    };
    void appWindow.onCloseRequested((event) => {
      event.preventDefault();
      void resolveExit();
    }).then((fn) => {
      if (disposed) fn();
      else unlistenClose = fn;
    });
    void onAppExitRequested(() => void resolveExit()).then((fn) => {
      if (disposed) fn();
      else unlistenExit = fn;
    });
    return () => {
      disposed = true;
      unlistenClose?.();
      unlistenExit?.();
    };
  }, []);

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
    window.addEventListener("talos:launch-agent", onLaunch);
    const onWorktree = (event: Event) => {
      const detail = (event as CustomEvent<{ workspacePath: string; profile: AgentLaunchProfile }>).detail;
      const parent = useWorkspacesStore
        .getState()
        .workspaces.find((workspace) => workspace.path === detail.workspacePath);
      if (parent) setProfileWorktree({ parent, profile: detail.profile });
    };
    window.addEventListener("talos:new-worktree-agent", onWorktree);
    const onNewTask = (event: Event) => {
      const detail = (event as CustomEvent<{ workspacePath: string }>).detail;
      const parent = useWorkspacesStore
        .getState()
        .workspaces.find((workspace) => workspace.path === detail.workspacePath);
      if (parent) setNewTaskWorkspace(parent);
    };
    window.addEventListener("talos:new-isolated-task", onNewTask);
    return () => {
      window.removeEventListener("talos:launch-agent", onLaunch);
      window.removeEventListener("talos:new-worktree-agent", onWorktree);
      window.removeEventListener("talos:new-isolated-task", onNewTask);
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
      const { workspaces, activePath } = useWorkspacesStore.getState();
      const activeWorkspace = workspaces.find((workspace) => workspace.path === activePath);
      if (e.key === "Tab" && e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        activeWorkspace?.editor.getState().activateRelative(e.shiftKey ? -1 : 1);
      } else if (
        e.metaKey &&
        e.shiftKey &&
        (e.key === "[" || e.key === "]")
      ) {
        e.preventDefault();
        activeWorkspace?.editor.getState().activateRelative(e.key === "[" ? -1 : 1);
      } else if (e.key.toLowerCase() === "t" && e.shiftKey) {
        e.preventDefault();
        activeWorkspace?.editor.getState().reopenClosedTab();
      } else if (e.key === "`") {
        e.preventDefault();
        togglePanel();
      } else if (e.key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key.toLowerCase() === "b" && e.shiftKey) {
        // ⌘⇧B: run the (.vscode/tasks.json) build task, VS Code-style
        e.preventDefault();
        if (activeWorkspace) void runBuildTask(activeWorkspace);
      } else if (e.key.toLowerCase() === "f" && e.shiftKey) {
        // ⌘⇧F: workspace search — reveal the sidebar + focus the query input
        e.preventDefault();
        useUiStore.getState().showSearch();
      } else if (e.key === "p" && !e.shiftKey && !e.altKey) {
        // ⌘P: quick-open a file by fuzzy name
        e.preventDefault(); // WKWebView would otherwise open the print dialog
        if (activeWorkspace) setQuickOpen(activeWorkspace);
      } else if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        const activeTabId = activeWorkspace?.editor.getState().activeTabId;
        if (activeWorkspace && activeTabId) {
          void closeTabSafely(activeWorkspace.editor, activeTabId);
        }
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
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const panelMaximized = useUiStore((s) => s.panelMaximized);
  const panelVisible = useUiStore((s) => s.panelVisible);
  // Nothing open in the editor card = give the whole center column to the
  // terminal card (Panel.tsx grows to match). With the panel hidden the
  // editor card stays, so its empty state still greets an empty workspace.
  const openTabCount = useActiveEditorTabCount();
  const editorHidden = panelMaximized || (panelVisible && openTabCount === 0);

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
        <ActivityBar />
        {/* Sidebar spans the full app height; the bottom panel sits beside
            it, under the editor column only. */}
        {sidebarVisible && (hasWorkspaces || sidebarTab === "sessions") && (
          <div className="app-sidebar" style={{ width: sidebarWidth }}>
            {sidebarTab === "sessions" ? (
              <AgentSessionsPanel />
            ) : (
              workspaces.map((ws) => (
                <WorkspaceContext.Provider key={ws.path} value={ws}>
                  <WorkspaceSidebarContent visible={ws.path === activePath} />
                </WorkspaceContext.Provider>
              ))
            )}
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
            // Hidden (not unmounted) while the panel owns the column — editor
            // buffers/scroll state follow the workspace-switch survival rule.
            <div
              className="app-editor-area"
              style={{ display: editorHidden ? "none" : undefined }}
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
