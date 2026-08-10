import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useStore } from "zustand";
import { open as openDialog, message } from "@tauri-apps/plugin-dialog";
import {
  useActiveWorkspace,
  useWorkspacesStore,
  type Workspace,
} from "../stores/workspaces";
import {
  selectWorkspaceActivity,
  selectWorkspacePathsActivity,
  useAgentTerminalsStore,
} from "../stores/agentTerminals";
import type { ActivityLevel } from "../stores/terminal";
import {
  paletteColor,
  PROJECT_COLOR_NAMES,
  setProjectColorIndex,
  useProjectColorIndex,
} from "../lib/projectColors";
import {
  projectDisplayName,
  setProjectDisplayName,
  useProjectDisplayName,
  useProjectDisplayNames,
} from "../lib/projectNames";
import { copyText } from "../lib/clipboard";
import { ContextMenu } from "./ContextMenu";
import {
  ActivityGlyph,
  IcBranch,
  IcClose,
  IcFolder,
  IcPlus,
  IcSync,
} from "./icons";
import "./Titlebar.css";

/** Parent directory name, for disambiguating same-named repos. */
const parentDir = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "";
};

/** Right-click menu for a workspace tab: rename / copy path / accent color. */
function ProjectTabMenu({
  path,
  x,
  y,
  onClose,
  onRename,
}: {
  path: string;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
}) {
  const colorIndex = useProjectColorIndex(path);
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <button
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        Rename Project…
      </button>
      <button
        onClick={() => {
          void copyText(path);
          onClose();
        }}
      >
        Copy Path
      </button>
      <div className="ctx-menu-sep" />
      <div className="ws-color-label">Project Color</div>
      <div className="ws-color-row">
        {PROJECT_COLOR_NAMES.map((name, i) => (
          <button
            key={name}
            className={`ws-color-swatch ${i === colorIndex ? "selected" : ""}`}
            title={name}
            style={{ background: paletteColor(i) }}
            onClick={() => {
              setProjectColorIndex(path, i);
              onClose();
            }}
          />
        ))}
      </div>
    </ContextMenu>
  );
}

function WorkspaceTab({
  ws,
  active,
  ambiguous,
  renaming,
  onContext,
  onRenameStart,
  onRenameEnd,
  activity,
  groupWorkspaces,
  title,
}: {
  ws: Workspace;
  active: boolean;
  ambiguous: boolean;
  renaming: boolean;
  onContext: (path: string, e: ReactMouseEvent) => void;
  onRenameStart: () => void;
  onRenameEnd: () => void;
  activity: ActivityLevel;
  groupWorkspaces?: Workspace[];
  title?: string;
}) {
  const setActive = useWorkspacesStore((s) => s.setActive);
  const closeWorkspace = useWorkspacesStore((s) => s.closeWorkspace);
  const ref = useRef<HTMLDivElement | null>(null);
  const colorIndex = useProjectColorIndex(ws.path);
  const name = useProjectDisplayName(ws.path);
  const cancelled = useRef(false);

  // An emptied name reverts to the default (the folder basename).
  const commitRename = (value: string) => {
    setProjectDisplayName(ws.path, value);
    onRenameEnd();
  };

  // keep the active tab reachable when the strip overflows (⌘1–9, restore)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      ref={ref}
      className={`ws-tab ${active ? "active" : ""}`}
      title={title ?? ws.path}
      onMouseDown={(e) => {
        // prevent middle-click autoscroll; close on aux click below
        if (e.button === 1) e.preventDefault();
        else if (e.button === 0) setActive(ws.path);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeWorkspace(ws.path);
        }
      }}
      onDoubleClick={onRenameStart}
      onContextMenu={(e) => onContext(ws.path, e)}
    >
      {groupWorkspaces ? (
        <>
          <GroupFolderBadge workspaces={groupWorkspaces} activePath={ws.path} />
          <ActivityGlyph
            activity={activity}
            idle={null}
            color={paletteColor(colorIndex)}
          />
        </>
      ) : (
        /* All three glyph states tinted in the project's color (identity
           carrier). The inline styles outrank Titlebar.css's .ws-tab > svg
           fg-dim rule and the activity classes' default colors. */
        <ActivityGlyph
          activity={activity}
          idle={<IcFolder style={{ color: paletteColor(colorIndex) }} />}
          color={paletteColor(colorIndex)}
        />
      )}
      {renaming ? (
        <input
          className="ws-tab-rename"
          defaultValue={name}
          autoFocus
          onFocus={(e) => {
            cancelled.current = false;
            e.currentTarget.select();
          }}
          // Keep edits out of the tab: no activate-on-mousedown, no
          // keystrokes reaching the global shortcut handler.
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitRename(e.currentTarget.value);
            else if (e.key === "Escape") {
              cancelled.current = true;
              onRenameEnd();
            }
          }}
          onBlur={(e) => {
            if (!cancelled.current) commitRename(e.currentTarget.value);
          }}
        />
      ) : (
        <span className="truncate">
          {name}
          {ambiguous && <span className="ws-tab-dir"> · {parentDir(ws.path)}</span>}
        </span>
      )}
      {!renaming && (
        <button
          className="ws-tab-close"
          title="Close Workspace"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void closeWorkspace(ws.path);
          }}
        >
          <IcClose />
        </button>
      )}
    </div>
  );
}

const MAX_GROUP_FOLDERS = 4;

function GroupFolderIcon({
  workspace,
  active,
}: {
  workspace: Workspace;
  active: boolean;
}) {
  const colorIndex = useProjectColorIndex(workspace.path);
  return (
    <IcFolder
      className={`ws-tab-folder-icon ${active ? "active" : ""}`}
      style={{ color: paletteColor(colorIndex) }}
    />
  );
}

function GroupFolderBadge({
  workspaces,
  activePath,
}: {
  workspaces: Workspace[];
  activePath: string;
}) {
  // Keep the active member visible even when a large family is capped.
  const ordered = [
    ...workspaces.filter((workspace) => workspace.path === activePath),
    ...workspaces.filter((workspace) => workspace.path !== activePath),
  ];
  const visible = ordered.slice(0, MAX_GROUP_FOLDERS);
  const hidden = workspaces.length - visible.length;
  return (
    <span
      className="ws-tab-folder-stack"
      title={`${workspaces.length} related workspaces`}
    >
      {visible.map((workspace) => (
        <GroupFolderIcon
          key={workspace.path}
          workspace={workspace}
          active={workspace.path === activePath}
        />
      ))}
      {hidden > 0 && <span className="ws-tab-folder-overflow">+{hidden}</span>}
    </span>
  );
}

interface WorkspaceTabCommonProps {
  activePath: string | null;
  nameCounts: Map<string, number>;
  renamingPath: string | null;
  onContext: (path: string, e: ReactMouseEvent) => void;
  onRenameStart: (path: string) => void;
  onRenameEnd: () => void;
}

function SingleWorkspaceTab({
  ws,
  ...props
}: WorkspaceTabCommonProps & { ws: Workspace }) {
  const activity = useAgentTerminalsStore((state) =>
    selectWorkspaceActivity(state, ws.path),
  );
  return (
    <WorkspaceTab
      ws={ws}
      active={ws.path === props.activePath}
      ambiguous={(props.nameCounts.get(projectDisplayName(ws.path)) ?? 0) > 1}
      renaming={ws.path === props.renamingPath}
      onContext={props.onContext}
      onRenameStart={() => props.onRenameStart(ws.path)}
      onRenameEnd={props.onRenameEnd}
      activity={activity}
    />
  );
}

function WorkspaceTabFamily({
  workspaces,
  expanded,
  onExpandedChange,
  ...props
}: WorkspaceTabCommonProps & {
  workspaces: Workspace[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const paths = workspaces.map((workspace) => workspace.path);
  const familyActivity = useAgentTerminalsStore((state) =>
    selectWorkspacePathsActivity(state, paths),
  );
  const representative =
    workspaces.find((workspace) => workspace.path === props.activePath) ?? workspaces[0];
  const familyTitle = workspaces.map((workspace) => workspace.path).join("\n");

  return (
    <div
      className={`ws-tab-family ${expanded ? "expanded" : ""}`}
      onMouseEnter={() => onExpandedChange(true)}
      onMouseLeave={() => onExpandedChange(false)}
    >
      {expanded ? (
        workspaces.map((workspace) => (
          <SingleWorkspaceTab key={workspace.path} ws={workspace} {...props} />
        ))
      ) : (
        <WorkspaceTab
          ws={representative}
          active={workspaces.some((workspace) => workspace.path === props.activePath)}
          ambiguous={
            (props.nameCounts.get(projectDisplayName(representative.path)) ?? 0) > 1
          }
          renaming={false}
          onContext={props.onContext}
          onRenameStart={() => props.onRenameStart(representative.path)}
          onRenameEnd={props.onRenameEnd}
          activity={familyActivity}
          groupWorkspaces={workspaces}
          title={familyTitle}
        />
      )}
    </div>
  );
}

/** Branch pill + fetch button for the active workspace. */
function ActiveRepoControls({ ws }: { ws: Workspace }) {
  const status = useStore(ws.repo, (s) => s.status);
  const syncing = useStore(ws.repo, (s) => s.syncing);
  const branch = status?.branch ?? null;

  return (
    <>
      {branch && (
        <span className="titlebar-branch-pill" data-tauri-drag-region>
          <IcBranch />
          <span className="truncate">{branch.name}</span>
          {(branch.ahead > 0 || branch.behind > 0) && (
            <span className="titlebar-aheadbehind">
              {branch.ahead > 0 && <span>{branch.ahead}&#8593;</span>}
              {branch.behind > 0 && <span>{branch.behind}&#8595;</span>}
            </span>
          )}
        </span>
      )}
      <button
        className={`icon-btn ${syncing ? "titlebar-syncing" : ""}`}
        title="Fetch from remote"
        disabled={syncing}
        onClick={() => void ws.repo.getState().fetch()}
      >
        <IcSync />
      </button>
    </>
  );
}

export default function Titlebar() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activePath = useWorkspacesStore((s) => s.activePath);
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const active = useActiveWorkspace();
  const displayName = useProjectDisplayNames();
  // Rendered as a sibling of the tab strip (not inside the tab) so backdrop
  // and item clicks don't bubble into the tab's activate-on-mousedown.
  const [tabMenu, setTabMenu] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  // Lifted out of the tab so the context menu's Rename item can start an
  // inline edit on any tab.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      await openWorkspace(dir);
    } catch (e) {
      await message(String(e), { title: "Open Repository", kind: "error" });
    }
  };

  const nameCounts = new Map<string, number>();
  for (const ws of workspaces) {
    const name = displayName(ws.path);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  // Stable first-seen order, without changing the underlying workspace list
  // or any path-keyed behavior outside this header presentation.
  const tabGroups: { id: string; workspaces: Workspace[] }[] = [];
  for (const workspace of workspaces) {
    const existing = tabGroups.find((group) => group.id === workspace.tabGroupId);
    if (existing) existing.workspaces.push(workspace);
    else tabGroups.push({ id: workspace.tabGroupId, workspaces: [workspace] });
  }

  const commonTabProps: WorkspaceTabCommonProps = {
    activePath,
    nameCounts,
    renamingPath,
    onContext: (path, event) => {
      event.preventDefault();
      setTabMenu({ path, x: event.clientX, y: event.clientY });
    },
    onRenameStart: setRenamingPath,
    onRenameEnd: () => setRenamingPath(null),
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-tabs">
        {tabGroups.map((group) =>
          group.workspaces.length === 1 ? (
            <SingleWorkspaceTab
              key={group.id}
              ws={group.workspaces[0]}
              {...commonTabProps}
            />
          ) : (
            <WorkspaceTabFamily
              key={group.id}
              workspaces={group.workspaces}
              expanded={
                expandedGroupId === group.id ||
                group.workspaces.some(
                  (workspace) =>
                    workspace.path === renamingPath || workspace.path === tabMenu?.path,
                )
              }
              onExpandedChange={(expanded) =>
                setExpandedGroupId(expanded ? group.id : null)
              }
              {...commonTabProps}
            />
          ),
        )}
        <button
          className="icon-btn ws-tab-add"
          title="Open Repository…"
          onClick={() => void pickFolder()}
        >
          <IcPlus />
        </button>
      </div>

      {workspaces.length === 0 && (
        <div className="titlebar-center">Vibe Studio</div>
      )}

      <div className="titlebar-right">
        {active && <ActiveRepoControls ws={active} />}
      </div>

      {tabMenu && (
        <ProjectTabMenu
          path={tabMenu.path}
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          onRename={() => setRenamingPath(tabMenu.path)}
        />
      )}
    </div>
  );
}
