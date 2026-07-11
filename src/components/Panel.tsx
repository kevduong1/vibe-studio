/**
 * Global bottom panel, hoisted out of the workspace trees so it can host two
 * kinds of tab: "Project Terminals" (leftmost — the active workspace's
 * tabbed terminals; every workspace's body stays mounted, display:none, same
 * survival rule as the workspace views) and any number of global terminal
 * groupings (each a persistent dock tree mounted exactly once, so its
 * terminals live across workspace switches; "+" adds a grouping, double-click
 * renames it, right-click closes it).
 */
import { useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
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
import { aggregateActivity } from "../stores/terminal";
import { closeGlobalGrouping, openGlobalTerminal } from "../lib/agentSessions";
import { openWorkspaceTerminal } from "../lib/workspaceSessions";
import TerminalPanel from "./TerminalPanel";
import AgentDock from "./AgentDock";
import { Resizer } from "./Resizer";
import { ContextMenu } from "./ContextMenu";
import {
  IcChevronDown,
  IcChevronsDown,
  IcChevronsUp,
  IcDot,
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
    closeGlobalGrouping(groupingId);
  }
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
  const setPanelGroup = useUiStore((s) => s.setPanelGroup);
  // Surface a waiting agent in this grouping while another tab is in front.
  const attention = useAgentTerminalsStore(
    (s) =>
      aggregateActivity(s.paneActivity, groupingTerminalIds(grouping)) ===
      "attention",
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
        useAgentTerminalsStore.getState().setActiveGrouping(grouping.id);
        setPanelGroup("agent");
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
          {grouping.name}
          {!front && attention && (
            <IcDot className="activity-attention panel-group-dot" />
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
          useAgentTerminalsStore.getState().newGrouping();
          setPanelGroup("agent");
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
              if (group === "agent") openGlobalTerminal(activeWs.path, "claude");
              else openWorkspaceTerminal(activeWs, "claude");
            }}
          >
            New Claude Agent
          </button>
          <button
            onClick={() => {
              setCreateMenu(null);
              if (group === "agent") openGlobalTerminal(activeWs.path, "codex");
              else openWorkspaceTerminal(activeWs, "codex");
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
  const group = useEffectivePanelGroup();
  const groupings = useAgentTerminalsStore((s) => s.groupings);
  const activeGroupingId = useAgentTerminalsStore((s) => s.activeGroupingId);

  // With nothing to show (welcome screen, no global groupings) the panel
  // disappears entirely; it is still MOUNTED either way — terminals hide
  // with display:none, never by unmounting (that would kill their PTYs).
  const shown = panelVisible && (workspaces.length > 0 || groupings.length > 0);

  return (
    <div
      className="app-panel"
      style={{
        // Maximized = fill the center column (App.tsx hides the editor area).
        height: shown ? (maximized ? "100%" : panelHeight) : 0,
        display: shown ? undefined : "none",
      }}
    >
      {!maximized && (
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
