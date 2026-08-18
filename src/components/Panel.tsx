/**
 * Global bottom panel, hoisted out of the workspace trees so it can host two
 * kinds of tab: "Project Terminals" (leftmost — the active workspace's
 * tabbed terminals; every workspace's body stays mounted, display:none, same
 * survival rule as the workspace views) and any number of global terminal
 * groupings (each a session-only dock tree mounted exactly once, so its
 * terminals live across workspace switches; "+" adds a grouping, double-click
 * renames it, right-click closes it).
 */
import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  switchToProject,
  useActiveEditorTabCount,
  useActiveWorkspace,
  useWorkspacesStore,
  WorkspaceContext,
} from "../stores/workspaces";
import {
  useEffectivePanelGroup,
  useUiStore,
  type PanelGroup,
} from "../stores/ui";
import {
  groupingTerminalIds,
  useAgentTerminalsStore,
  type GlobalTermGrouping,
} from "../stores/agentTerminals";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import {
  rollupAgentStates,
  ROLLUP_PRIORITY,
  type AgentRollup,
} from "../lib/agentState";
import { closeGlobalGrouping, openGlobalTerminal } from "../lib/agentSessions";
import { useProjectColorVar } from "../lib/projectColors";
import { projectDisplayName } from "../lib/projectNames";
import { openWorkspaceTerminal } from "../lib/workspaceSessions";
import TerminalPanel from "./TerminalPanel";
import AgentDock from "./AgentDock";
import { Resizer } from "./Resizer";
import { ContextMenu } from "./ContextMenu";
import { requestAgentLaunch } from "../lib/agentLaunchRequest";
import {
  ActivityGlyph,
  IcChevronDown,
  IcChevronsDown,
  IcChevronsUp,
  IcFolder,
  IcPlus,
  IcSplit,
} from "./icons";
import "./Panel.css";

/** Close a grouping, confirming first when it still has terminals. */
async function closeGroupingSafely(groupingId: string): Promise<void> {
  const g = useAgentTerminalsStore
    .getState()
    .groupings.find((x) => x.id === groupingId);
  if (!g) return;
  const count = groupingTerminalIds(g).length;
  if (
    count === 0 ||
    (await confirm(
      `Close "${g.name}" and its ${count} terminal${count === 1 ? "" : "s"}?`,
      { title: "Close Terminal Group", kind: "warning" },
    ))
  ) {
    const wasActive =
      useAgentTerminalsStore.getState().activeGroupingId === groupingId;
    closeGlobalGrouping(groupingId);
    if (wasActive && effectiveAgentSide()) {
      restoreGroupingWorkspace(
        useAgentTerminalsStore.getState().activeGroupingId,
      );
    }
  }
}

const effectiveAgentSide = (): boolean => {
  const hasWorkspaces = useWorkspacesStore.getState().workspaces.length > 0;
  return !hasWorkspaces || useUiStore.getState().panelGroup === "agent";
};

const restoreGroupingWorkspace = (groupingId: string | null): void => {
  const grouping = useAgentTerminalsStore
    .getState()
    .groupings.find((item) => item.id === groupingId);
  const path = grouping?.lastActiveWorkspacePath;
  if (path && path !== useWorkspacesStore.getState().activePath) {
    void switchToProject(path);
  }
};

const activateGrouping = (groupingId: string): void => {
  const terminals = useAgentTerminalsStore.getState();
  const grouping = terminals.groupings.find((item) => item.id === groupingId);
  if (!grouping) return;
  const currentWorkspace = useWorkspacesStore.getState().activePath;
  if (!grouping.lastActiveWorkspacePath && currentWorkspace) {
    terminals.setGroupingWorkspace(groupingId, currentWorkspace);
  }
  terminals.setActiveGrouping(groupingId);
  useUiStore.getState().setPanelGroup("agent");
  restoreGroupingWorkspace(groupingId);
};

interface GroupingWorkspaceActivity {
  workspacePath: string;
  activity: Exclude<AgentRollup, "idle">;
}

function GroupActivityGlyph({
  item,
}: {
  item: GroupingWorkspaceActivity;
}) {
  const color = useProjectColorVar(item.workspacePath);
  const state =
    item.activity === "blocked"
      ? "Needs Input"
      : item.activity === "done"
        ? "Done"
        : "Working";
  return (
    <span
      className="panel-group-activity-glyph"
      title={`${projectDisplayName(item.workspacePath)} — ${state}`}
    >
      <ActivityGlyph activity={item.activity} idle={null} color={color} />
    </span>
  );
}

function GroupProjectFolder({ workspacePath }: { workspacePath: string }) {
  const color = useProjectColorVar(workspacePath);
  return (
    <span
      className="panel-group-project-folder"
      title={`${projectDisplayName(workspacePath)}\n${workspacePath}`}
    >
      <IcFolder style={{ color }} />
    </span>
  );
}

/** One grouping's panel tab: click fronts it, double-click renames inline.
 *  The right-click menu lives in PanelHeader (ContextMenu must be a sibling
 *  of the tab — its backdrop clicks would bubble into these handlers). */
function GroupingTab({
  grouping,
  front,
  editing,
  onStartEdit,
  onEndEdit,
  onMenu,
}: {
  grouping: GlobalTermGrouping;
  front: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const cancelled = useRef(false);
  const runtimeStates = useAgentRuntimeStore((state) => state.states);
  const terminals = useAgentTerminalsStore((state) => state.terminals);
  const byWorkspace = new Map<string, string[]>();
  for (const id of groupingTerminalIds(grouping)) {
    const workspacePath = terminals[id]?.workspacePath;
    if (!workspacePath) continue;
    byWorkspace.set(workspacePath, [...(byWorkspace.get(workspacePath) ?? []), id]);
  }
  const activities: GroupingWorkspaceActivity[] = [...byWorkspace]
    .map(([workspacePath, ids]) => ({
      workspacePath,
      activity: rollupAgentStates(ids.map((id) => runtimeStates[id])),
    }))
    .filter(
      (item): item is GroupingWorkspaceActivity =>
        item.activity !== null && item.activity !== "idle",
    )
    .sort((a, b) => ROLLUP_PRIORITY[b.activity] - ROLLUP_PRIORITY[a.activity]);
  const workspacePaths = [...byWorkspace.keys()];

  const commit = (value: string) => {
    // renameGrouping trims and ignores empty — the old name just stays.
    useAgentTerminalsStore.getState().renameGrouping(grouping.id, value);
    onEndEdit();
  };

  return (
    <div
      className={`panel-group-tab panel-grouping-tab ${front ? "active" : ""}`}
      onMouseDown={(e) => {
        if (e.button !== 0 || editing) return;
        activateGrouping(grouping.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation(); // rename, not the header's maximize toggle
        if (!editing) onStartEdit();
      }}
      // While renaming, right-clicks stay on the input's native menu.
      onContextMenu={(e) => {
        if (!editing) onMenu(e);
      }}
    >
      {editing ? (
        <input
          className="panel-tab-rename"
          defaultValue={grouping.name}
          autoFocus
          onFocus={(e) => {
            cancelled.current = false;
            e.currentTarget.select();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit(e.currentTarget.value);
            else if (e.key === "Escape") {
              cancelled.current = true;
              onEndEdit();
            }
          }}
          onBlur={(e) => {
            if (!cancelled.current) commit(e.currentTarget.value);
          }}
        />
      ) : (
        <>
          {workspacePaths.length > 0 && (
            <span className="panel-group-projects">
              {workspacePaths.map((workspacePath) => (
                <GroupProjectFolder
                  key={workspacePath}
                  workspacePath={workspacePath}
                />
              ))}
            </span>
          )}
          {grouping.name}
          {activities.length > 0 && (
            <span className="panel-group-activities">
              {activities.map((item) => (
                <GroupActivityGlyph key={item.workspacePath} item={item} />
              ))}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function PanelHeader({ group }: { group: PanelGroup }) {
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [groupingMenu, setGroupingMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const setPanelGroup = useUiStore((s) => s.setPanelGroup);
  const setPanelVisible = useUiStore((s) => s.setPanelVisible);
  const maximized = useUiStore((s) => s.panelMaximized);
  const togglePanelMaximized = useUiStore((s) => s.togglePanelMaximized);
  const hasWorkspaces = useWorkspacesStore((s) => s.workspaces.length > 0);
  const activeWs = useActiveWorkspace();
  const groupings = useAgentTerminalsStore((s) => s.groupings);
  const activeGroupingId = useAgentTerminalsStore((s) => s.activeGroupingId);

  return (
    <div
      className="panel-header"
      // VS Code-style: double-click the header toggles maximize — but not on
      // the action buttons, where a fast double press (e.g. New Terminal
      // twice) is a legitimate gesture. (Grouping tabs stopPropagation —
      // their double-click is the rename.)
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".panel-actions")) return;
        togglePanelMaximized();
      }}
    >
      {hasWorkspaces && (
        <button
          className={`panel-group-tab ${group === "terminal" ? "active" : ""}`}
          onClick={() => setPanelGroup("terminal")}
        >
          Project Terminals
        </button>
      )}
      {groupings.map((g) => (
        <GroupingTab
          key={g.id}
          grouping={g}
          front={group === "agent" && g.id === activeGroupingId}
          editing={renamingId === g.id}
          onStartEdit={() => setRenamingId(g.id)}
          onEndEdit={() => setRenamingId(null)}
          onMenu={(e) => {
            e.preventDefault();
            setGroupingMenu({ id: g.id, x: e.clientX, y: e.clientY });
          }}
        />
      ))}
      <button
        className="icon-btn panel-group-add"
        title="New Terminal Group"
        onClick={() => {
          const id = useAgentTerminalsStore.getState().newGrouping();
          const path = useWorkspacesStore.getState().activePath;
          if (path) {
            useAgentTerminalsStore.getState().setGroupingWorkspace(id, path);
          }
          activateGrouping(id);
        }}
      >
        <IcPlus />
      </button>

      <div className="panel-header-spacer" />

      <div className="panel-actions">
        {activeWs && (
          <>
            <button
              className="icon-btn"
              title={`New ${group === "agent" ? "Global" : "Project"} Terminal`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setCreateMenu({ x: r.right, y: r.bottom });
              }}
            >
              <IcPlus />
            </button>
            {group === "terminal" && (
              <button
                className="icon-btn"
                title="Split Project Terminal"
                onClick={() => activeWs.terminal.getState().splitActive()}
              >
                <IcSplit />
              </button>
            )}
          </>
        )}
        <button
          className="icon-btn"
          title={maximized ? "Restore Panel Size" : "Maximize Panel Size"}
          onClick={togglePanelMaximized}
        >
          {maximized ? <IcChevronsDown /> : <IcChevronsUp />}
        </button>
        <button
          className="icon-btn"
          title="Hide Panel"
          onClick={() => setPanelVisible(false)}
        >
          <IcChevronDown />
        </button>
      </div>
      {createMenu && activeWs && (
        <ContextMenu
          x={createMenu.x}
          y={createMenu.y}
          onClose={() => setCreateMenu(null)}
        >
          <button
            onClick={() => {
              setCreateMenu(null);
              if (group === "agent") openGlobalTerminal(activeWs.path, "shell");
              else openWorkspaceTerminal(activeWs, "shell");
            }}
          >
            New Shell
          </button>
          <button
            onClick={() => {
              setCreateMenu(null);
              requestAgentLaunch({ workspacePath: activeWs.path, scope: group === "agent" ? "global" : "workspace", kind: "claude" });
            }}
          >
            New Claude Agent
          </button>
          <button
            onClick={() => {
              setCreateMenu(null);
              requestAgentLaunch({ workspacePath: activeWs.path, scope: group === "agent" ? "global" : "workspace", kind: "codex" });
            }}
          >
            New Codex Agent
          </button>
        </ContextMenu>
      )}
      {groupingMenu && (
        <ContextMenu
          x={groupingMenu.x}
          y={groupingMenu.y}
          onClose={() => setGroupingMenu(null)}
        >
          <button
            onClick={() => {
              setRenamingId(groupingMenu.id);
              setGroupingMenu(null);
            }}
          >
            Rename Group
          </button>
          <div className="ctx-menu-sep" />
          <button
            onClick={() => {
              const id = groupingMenu.id;
              setGroupingMenu(null);
              void closeGroupingSafely(id);
            }}
          >
            Close Group
          </button>
        </ContextMenu>
      )}
    </div>
  );
}

export default function Panel() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activePath = useWorkspacesStore((s) => s.activePath);
  const panelVisible = useUiStore((s) => s.panelVisible);
  const panelHeight = useUiStore((s) => s.panelHeight);
  const setPanelHeight = useUiStore((s) => s.setPanelHeight);
  const maximized = useUiStore((s) => s.panelMaximized);
  const openTabCount = useActiveEditorTabCount();
  const group = useEffectivePanelGroup();
  const groupings = useAgentTerminalsStore((s) => s.groupings);
  const activeGroupingId = useAgentTerminalsStore((s) => s.activeGroupingId);

  // Remember workspace navigation only while a global group is actually in
  // front. Group switches are handled explicitly so a closed repo can reopen
  // without the old workspace overwriting the target group's memory mid-load.
  useEffect(
    () =>
      useWorkspacesStore.subscribe((state, previous) => {
        if (
          state.activePath === previous.activePath ||
          !state.activePath ||
          !effectiveAgentSide()
        ) {
          return;
        }
        const terminals = useAgentTerminalsStore.getState();
        if (terminals.activeGroupingId) {
          terminals.setGroupingWorkspace(
            terminals.activeGroupingId,
            state.activePath,
          );
        }
      }),
    [],
  );

  // With nothing to show (welcome screen, no global groupings) the panel
  // disappears entirely; it is still MOUNTED either way — terminals hide
  // with display:none, never by unmounting (that would kill their PTYs).
  const shown = panelVisible && (workspaces.length > 0 || groupings.length > 0);
  // Same deal without the explicit toggle: with no editor tab open App.tsx
  // hides the editor card, so the panel is the only card in the column.
  const full = maximized || openTabCount === 0;

  return (
    <div
      className="app-panel"
      style={{
        // Filling = own the whole center column (App.tsx hides the editor area).
        height: shown ? (full ? "100%" : panelHeight) : 0,
        display: shown ? undefined : "none",
      }}
    >
      {!full && (
        <Resizer
          direction="horizontal"
          onDelta={(d) => setPanelHeight(useUiStore.getState().panelHeight - d)}
        />
      )}
      <PanelHeader group={group} />
      <div className="panel-body">
        {workspaces.map((ws) => (
          <WorkspaceContext.Provider key={ws.path} value={ws}>
            <div
              className="panel-group-body"
              style={{
                display:
                  group === "terminal" && ws.path === activePath
                    ? undefined
                    : "none",
              }}
            >
              <TerminalPanel />
            </div>
          </WorkspaceContext.Provider>
        ))}
        {groupings.map((g) => (
          <div
            key={g.id}
            className="panel-group-body"
            style={{
              display:
                group === "agent" && g.id === activeGroupingId
                  ? undefined
                  : "none",
            }}
          >
            <AgentDock groupingId={g.id} />
          </div>
        ))}
        {groupings.length === 0 && (
          // Placeholder empty dock (its create buttons make the first
          // grouping on demand) so the global side isn't a blank void.
          <div
            className="panel-group-body"
            style={{ display: group === "agent" ? undefined : "none" }}
          >
            <AgentDock groupingId="" />
          </div>
        )}
      </div>
    </div>
  );
}
