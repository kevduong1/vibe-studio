/**
 * Persistent global-terminal bottom panel. Each session-only grouping is one
 * tab whose dock tree mounts exactly once, so its terminals live across
 * workspace switches; selecting a grouping never changes the active workspace.
 * Project terminals have a separate lower-sidebar dock in App.tsx.
 */
import { useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  useActiveEditorTabCount,
  useActiveWorkspace,
  useWorkspacesStore,
} from "../stores/workspaces";
import { useUiStore } from "../stores/ui";
import {
  groupingTerminalIds,
  useAgentTerminalsStore,
  type GlobalTermGrouping,
} from "../stores/agentTerminals";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import {
  rollupAgentStates,
  type AgentRollup,
} from "../lib/agentState";
import { closeGlobalGrouping, openGlobalTerminal } from "../lib/agentSessions";
import { useProjectColorVar } from "../lib/projectColors";
import { projectDisplayName } from "../lib/projectNames";
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
      `Close "${g.name}" and its ${count} terminal${count === 1 ? "" : "s"}?\n\nThis will stop every process in the group.`,
      { title: "Close Terminal Group", kind: "warning" },
    ))
  ) {
    closeGlobalGrouping(groupingId);
  }
}

const activateGrouping = (groupingId: string): void => {
  const terminals = useAgentTerminalsStore.getState();
  const grouping = terminals.groupings.find((item) => item.id === groupingId);
  if (!grouping) return;
  terminals.setActiveGrouping(groupingId);
  useUiStore.getState().setPanelVisible(true);
};

interface GroupingWorkspaceStatus {
  workspacePath: string;
  activity: AgentRollup | null;
}

function GroupActivityGlyph({
  workspacePath,
  activity,
}: {
  workspacePath: string;
  activity: Exclude<AgentRollup, "idle">;
}) {
  const color = useProjectColorVar(workspacePath);
  const state =
    activity === "blocked"
      ? "Needs Input"
      : activity === "done"
        ? "Done"
        : "Working";
  return (
    <span
      className="panel-group-activity-glyph"
      title={`${projectDisplayName(workspacePath)} — ${state}`}
    >
      <ActivityGlyph activity={activity} idle={null} color={color} />
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

function GroupProjectStatus({
  item,
}: {
  item: GroupingWorkspaceStatus;
}) {
  return item.activity && item.activity !== "idle" ? (
    <GroupActivityGlyph
      workspacePath={item.workspacePath}
      activity={item.activity}
    />
  ) : (
    <GroupProjectFolder workspacePath={item.workspacePath} />
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
  const workspaceStatuses: GroupingWorkspaceStatus[] = [...byWorkspace].map(
    ([workspacePath, ids]) => ({
      workspacePath,
      activity: rollupAgentStates(ids.map((id) => runtimeStates[id])),
    }),
  );

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
          {workspaceStatuses.length > 0 && (
            <span className="panel-group-projects">
              {workspaceStatuses.map((item) => (
                <GroupProjectStatus
                  key={item.workspacePath}
                  item={item}
                />
              ))}
            </span>
          )}
          {grouping.name}
        </>
      )}
    </div>
  );
}

function PanelHeader() {
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [groupingMenu, setGroupingMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const setPanelVisible = useUiStore((s) => s.setPanelVisible);
  const maximized = useUiStore((s) => s.panelMaximized);
  const togglePanelMaximized = useUiStore((s) => s.togglePanelMaximized);
  const activeWs = useActiveWorkspace();
  const groupings = useAgentTerminalsStore((s) => s.groupings);
  const activeGroupingId = useAgentTerminalsStore((s) => s.activeGroupingId);
  const runtimeStates = useAgentRuntimeStore((state) => state.states);
  const persistentActivity = rollupAgentStates(
    groupings.flatMap((grouping) =>
      groupingTerminalIds(grouping).map((id) => runtimeStates[id]),
    ),
  );

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
      {groupings.map((g) => (
        <GroupingTab
          key={g.id}
          grouping={g}
          front={g.id === activeGroupingId}
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
              title="New Persistent Terminal"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setCreateMenu({ x: r.right, y: r.bottom });
              }}
            >
              <IcPlus />
            </button>
          </>
        )}
        <button
          className={`icon-btn panel-maximize ${maximized ? "active" : ""}`}
          title={
            maximized
              ? "Restore Panel Size · Persistent Terminal Groups"
              : "Maximize Panel Size · Persistent Terminal Groups"
          }
          onClick={togglePanelMaximized}
          aria-pressed={maximized}
        >
          {maximized ? <IcChevronsDown /> : <IcChevronsUp />}
          {persistentActivity !== null && persistentActivity !== "idle" && (
            <span
              className="panel-persistent-activity"
              title={
                persistentActivity === "blocked"
                  ? "Persistent terminal needs input"
                  : persistentActivity === "done"
                    ? "Persistent terminal finished"
                    : "Persistent terminal working"
              }
            >
              <ActivityGlyph activity={persistentActivity} idle={null} />
            </span>
          )}
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
              openGlobalTerminal(activeWs.path, "shell");
            }}
          >
            New Shell
          </button>
          <button
            onClick={() => {
              setCreateMenu(null);
              requestAgentLaunch({ workspacePath: activeWs.path, scope: "global", kind: "claude" });
            }}
          >
            New Claude Agent
          </button>
          <button
            onClick={() => {
              setCreateMenu(null);
              requestAgentLaunch({ workspacePath: activeWs.path, scope: "global", kind: "codex" });
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
  const panelVisible = useUiStore((s) => s.panelVisible);
  const panelHeight = useUiStore((s) => s.panelHeight);
  const setPanelHeight = useUiStore((s) => s.setPanelHeight);
  const maximized = useUiStore((s) => s.panelMaximized);
  const openTabCount = useActiveEditorTabCount();
  const groupings = useAgentTerminalsStore((s) => s.groupings);
  const activeGroupingId = useAgentTerminalsStore((s) => s.activeGroupingId);

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
      <PanelHeader />
      <div className="panel-body">
        {groupings.map((g) => (
          <div
            key={g.id}
            className="panel-group-body"
            style={{
              display:
                g.id === activeGroupingId
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
          >
            <AgentDock groupingId="" />
          </div>
        )}
      </div>
    </div>
  );
}
