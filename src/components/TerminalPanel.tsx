/**
 * The workspace flavor of the generic Dock: plain shells spawned at the
 * workspace root — no activity tracking, no TERM_PROGRAM masquerade, no
 * project badge (every terminal here belongs to the surrounding workspace).
 * Same drag-and-drop grouping/splitting and double-click tab rename as the
 * agent dock; sessions live in the lib/termSessions registry so drops never
 * kill the shell. The workspaces store disposes a workspace's sessions when
 * the workspace closes.
 */
import { memo, useEffect, useRef, useState } from "react";
import { type WorkspaceTerminal } from "../stores/terminal";
import { useWorkspace } from "../stores/workspaces";
import { getSession } from "../lib/termSessions";
import { setTerminalNotifications } from "../lib/agentNotifications";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import {
  agentStateTooltip,
  displayAgentState,
  displayLabel,
} from "../lib/agentState";
import {
  closeWorkspaceTerminal,
  getOrCreateWorkspaceSession,
  openWorkspaceTerminal,
} from "../lib/workspaceSessions";
import { Dock, type DockPaneProps } from "./Dock";
import { ContextMenu } from "./ContextMenu";
import {
  ActivityGlyph,
  IcBell,
  IcClaude,
  IcCodex,
  IcSparkle,
  IcTerminal,
} from "./icons";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";
import "./AgentDock.css";

const TerminalPane = memo(function TerminalPane({
  terminal,
  groupId,
  visible,
  focused,
}: DockPaneProps<WorkspaceTerminal>) {
  // The workspace object (and its terminal store) is stable for the
  // lifetime of the workspace, so capturing it in the one-shot effect is safe.
  const ws = useWorkspace();
  const hostRef = useRef<HTMLDivElement>(null);

  // Mount = attach the (possibly already-running) session; unmount = detach
  // ONLY — drag-and-drop survival depends on this. The PTY dies through
  // closeWorkspaceTerminal (tab ×, shell exit) or workspace close.
  useEffect(() => {
    const session = getOrCreateWorkspaceSession(ws, terminal.id);
    session.attach(hostRef.current!);
    return () => session.detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  useEffect(() => {
    if (visible && document.hasFocus()) getSession(terminal.id)?.acknowledge();
  }, [terminal.id, visible]);

  const runtime = useAgentRuntimeStore((s) => s.states[terminal.id]);
  const display = displayAgentState(runtime);
  const summary =
    display === "working" || display === "starting" || display === "blocked" || display === "done"
      ? displayLabel(display)
      : "";

  return (
    <div
      className={`dock-pane ${focused ? "focused" : ""}`}
      style={{ display: visible ? undefined : "none" }}
      onMouseDown={() => {
        ws.terminal.getState().setActiveTerminal(groupId, terminal.id);
        const session = getSession(terminal.id);
        session?.acknowledge();
        session?.focus();
      }}
    >
      <div className="dock-pane-host" ref={hostRef} />
      {terminal.kind !== "shell" && summary && (
        <div className="agent-badge" title={runtime && agentStateTooltip(runtime)}>
          <span className="agent-badge-state">{summary}</span>
        </div>
      )}
    </div>
  );
});

function TerminalTabIcon({ terminal }: { terminal: WorkspaceTerminal }) {
  const runtime = useAgentRuntimeStore((s) => s.states[terminal.id]);
  if (terminal.kind === "shell") return <IcTerminal />;
  return (
    <span
      className="dock-tab-agent-icon"
      title={
        runtime
          ? agentStateTooltip(runtime)
          : `${terminal.kind === "claude" ? "Claude" : "Codex"} — No Agent`
      }
    >
      {terminal.kind === "claude" ? <IcClaude /> : <IcCodex />}
    </span>
  );
}

function TerminalTabBadge({ terminal }: { terminal: WorkspaceTerminal }) {
  const runtime = useAgentRuntimeStore((s) => s.states[terminal.id]);
  if (terminal.kind === "shell") return null;

  const display = displayAgentState(runtime);
  const showStatus = display !== "idle" && display !== "unknown";
  return (
    <>
      {showStatus && (
        <span
          className="dock-tab-agent-status"
          title={runtime ? agentStateTooltip(runtime) : "No Agent"}
        >
          <ActivityGlyph activity={display} idle={<IcTerminal />} />
        </span>
      )}
      {terminal.notificationsEnabled && <IcBell className="dock-tab-bell" />}
    </>
  );
}

function TerminalEmpty() {
  const ws = useWorkspace();
  return (
    <div className="terminal-empty">
      <div className="terminal-empty-text">No terminals</div>
      <div className="terminal-empty-actions">
        <button
          className="primary-btn"
          onClick={() => openWorkspaceTerminal(ws, "shell")}
        >
          <IcTerminal /> New Shell
        </button>
        <button
          className="primary-btn"
          onClick={() => openWorkspaceTerminal(ws, "claude")}
        >
          <IcSparkle /> Claude Agent
        </button>
        <button
          className="primary-btn"
          onClick={() => openWorkspaceTerminal(ws, "codex")}
        >
          <IcSparkle /> Codex Agent
        </button>
      </div>
    </div>
  );
}

/** One workspace's terminal dock (body only — the shared panel header with
 *  the group switcher lives in Panel.tsx). Stays mounted for the
 *  workspace's lifetime. */
export default function TerminalPanel() {
  const ws = useWorkspace();
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // Auto-create the first terminal exactly once. The ref survives React 19
  // StrictMode's dev double-mount, so we never auto-spawn two tabs — and a
  // user closing the last tab intentionally is not overridden.
  const autoCreated = useRef(false);
  useEffect(() => {
    if (
      !autoCreated.current &&
      Object.keys(ws.terminal.getState().terminals).length === 0
    ) {
      autoCreated.current = true;
      ws.terminal.getState().newTerminal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabled = tabMenu
    ? ws.terminal.getState().terminals[tabMenu.id]?.notificationsEnabled === true
    : false;
  return (
    <>
      <Dock
        store={ws.terminal}
        Pane={TerminalPane}
        TabIcon={TerminalTabIcon}
        TabBadge={TerminalTabBadge}
        Empty={TerminalEmpty}
        onTabContextMenu={(terminal, event) => {
          if (terminal.kind === "shell") return;
          event.preventDefault();
          setTabMenu({ id: terminal.id, x: event.clientX, y: event.clientY });
        }}
        closeTerminal={(id) => closeWorkspaceTerminal(ws.terminal, id)}
      />
      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          <button
            onClick={() => {
              const id = tabMenu.id;
              setTabMenu(null);
              void setTerminalNotifications(id, !enabled).catch(() => {});
            }}
          >
            {enabled ? "Disable Notifications" : "Enable Notifications"}
          </button>
        </ContextMenu>
      )}
    </>
  );
}
