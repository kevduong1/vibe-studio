import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { gitWorktreeList, gitWorktreeOpen, type GitWorktree } from "../lib/ipc";
import {
  createIsolatedTask,
  defaultWorktreePath,
  slugifyTaskName,
} from "../lib/isolatedTasks";
import type { AgentKind } from "../lib/agentState";
import { useNativeOverlay } from "../lib/nativeOverlays";
import { setWorktreeRoot } from "../stores/isolatedTasks";
import {
  definitionForProfile,
  launchCommand,
  type AgentLaunchProfile,
} from "../stores/agentDefinitions";
import { useWorkspacesStore, type Workspace } from "../stores/workspaces";
import "./WorktreeDialog.css";

export type WorktreeDialogMode = "create" | "create-agent" | "open";

/** Open the app-level task/worktree dialog from repository-scoped UI such as
 * the Worktrees sidebar. App owns the overlay so switching workspaces during
 * creation cannot hide it inside an inactive workspace tree. */
export const requestNewIsolatedTask = (workspacePath: string): void => {
  window.dispatchEvent(new CustomEvent("vibe:new-isolated-task", {
    detail: { workspacePath },
  }));
};

export default function WorktreeDialog({
  parent,
  mode,
  onClose,
  launchProfile,
}: {
  parent: Workspace;
  mode: WorktreeDialogMode;
  onClose: () => void;
  launchProfile?: AgentLaunchProfile;
}) {
  useNativeOverlay();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [pathEdited, setPathEdited] = useState(false);
  const [agent, setAgent] = useState<AgentKind>("codex");
  const profileDefinition = launchProfile ? definitionForProfile(launchProfile) : null;
  const profileLaunch = launchProfile && profileDefinition
    ? launchCommand(profileDefinition, launchProfile)
    : null;
  const profileError = launchProfile && !profileDefinition
    ? `The launch profile “${launchProfile.name}” references an agent definition that no longer exists.`
    : null;
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const openWorkspace = useWorkspacesStore((state) => state.openWorkspace);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const openPaths = useMemo(
    () => new Set(workspaces.map((workspace) => workspace.path)),
    [workspaces],
  );

  useEffect(() => {
    if (mode !== "open") return;
    let cancelled = false;
    void gitWorktreeList(parent.path).then(
      (items) => !cancelled && setWorktrees(items),
      (reason) => !cancelled && setError(String(reason)),
    );
    return () => {
      cancelled = true;
    };
  }, [mode, parent.path]);

  const updateName = (value: string) => {
    setName(value);
    const slug = slugifyTaskName(value);
    if (!branchEdited) setBranch(`vibe/${slug}`);
    if (!pathEdited) setPath(defaultWorktreePath(parent.path, slug));
  };

  const chooseRoot = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setWorktreeRoot(selected);
    setPath(defaultWorktreePath(parent.path, slugifyTaskName(name)));
    setPathEdited(false);
  };

  const create = async () => {
    if (busyRef.current || !name.trim() || !branch.trim() || !path.trim()) return;
    if (profileError) {
      setError(profileError);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await createIsolatedTask({
        name,
        parentPath: parent.path,
        path,
        branch,
        agentKind:
          mode === "create-agent"
            ? (profileDefinition?.detectionProfile ?? agent)
            : null,
        agentCommand: profileLaunch?.command,
        agentPrelude: profileLaunch?.environmentPrelude,
      });
      onClose();
    } catch (reason) {
      setError(String(reason));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="worktree-dialog-backdrop"
      onMouseDown={() => {
        if (!busyRef.current) onClose();
      }}
    >
      <div
        className="worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={
          mode === "open" ? "Open Worktree" : mode === "create-agent" ? "New Task" : "New Worktree"
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="worktree-dialog-title">
          {mode === "open" ? "Open Worktree" : mode === "create-agent" ? "New Task" : "New Worktree"}
        </div>
        <div className="worktree-dialog-project">From {parent.path}</div>

        {mode === "open" ? (
          <div className="worktree-list">
            {worktrees === null && !error && <div className="worktree-empty">Loading…</div>}
            {worktrees?.filter((item) => !item.main).length === 0 && (
              <div className="worktree-empty">No linked worktrees</div>
            )}
            {worktrees
              ?.filter((item) => !item.main)
              .map((item) => (
                <button
                  key={item.path}
                  className="worktree-list-item"
                  disabled={busy || openPaths.has(item.path)}
                  onClick={() => {
                    if (busyRef.current) return;
                    busyRef.current = true;
                    setBusy(true);
                    setError(null);
                    void gitWorktreeOpen(parent.path, item.path)
                      .then(() => openWorkspace(item.path))
                      .then(onClose, (reason) => {
                        setError(String(reason));
                        busyRef.current = false;
                        setBusy(false);
                      });
                  }}
                >
                  <span>{item.branch ?? "Detached HEAD"}</span>
                  <small>{item.path}{openPaths.has(item.path) ? " — open" : ""}</small>
                </button>
              ))}
          </div>
        ) : (
          <div className="worktree-fields">
            <label>
              Task name
              <input
                autoFocus
                value={name}
                placeholder="Implement settings search"
                onChange={(event) => updateName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                  if (event.key === "Escape" && !busyRef.current) onClose();
                }}
              />
            </label>
            <label>
              Branch
              <input
                value={branch}
                placeholder="vibe/task-name"
                onChange={(event) => {
                  setBranchEdited(true);
                  setBranch(event.target.value);
                }}
              />
            </label>
            <label>
              Checkout path
              <div className="worktree-path-row">
                <input
                  value={path}
                  onChange={(event) => {
                    setPathEdited(true);
                    setPath(event.target.value);
                  }}
                />
                <button type="button" disabled={busy} onClick={() => void chooseRoot()}>Root…</button>
              </div>
            </label>
            {mode === "create-agent" && (
              <label>
                Agent
                {launchProfile ? (
                  <input value={launchProfile.name} readOnly />
                ) : (
                  <select value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>
                    <option value="codex">Codex (codex --yolo)</option>
                    <option value="claude">Claude</option>
                  </select>
                )}
              </label>
            )}
            <div className="worktree-help">
              {mode === "create-agent" && (
                <>Creates and opens a linked worktree, then launches the selected agent. </>
              )}
              Optional setup comes from <code>.vibe/worktrees.json</code>. Each task receives a distinct <code>PORT</code>.
            </div>
          </div>
        )}

        {(error ?? profileError) && <div className="worktree-error">{error ?? profileError}</div>}
        <div className="worktree-dialog-actions">
          <button
            disabled={busy}
            onClick={() => {
              if (!busyRef.current) onClose();
            }}
          >
            Cancel
          </button>
          {mode !== "open" && (
            <button
              className="primary"
              disabled={
                busy ||
                !name.trim() ||
                !branch.trim() ||
                !path.trim() ||
                Boolean(launchProfile && !profileDefinition)
              }
              onClick={() => void create()}
            >
              {busy ? "Creating…" : mode === "create-agent" ? "Create & Launch" : "Create"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
