/**
 * The Global Terminals flavor of the generic Dock: panes attach registry
 * sessions spawned in their bound project's directory (TERM_PROGRAM
 * masquerade + activity tracking), wear a session-topic badge (the cleaned
 * live OSC 0/2 title, hidden until one is useful; tabs rename via the Dock's
 * double-click), highlight when their
 * project is the active workspace, and clicking them switches the app to
 * that project (reopening it if it was closed → "disconnected" ⊘ until
 * then). Right-click a tab for the per-terminal notifications toggle
 * (lib/agentNotifications — system notification + sound on attention);
 * enabled tabs wear a bell next to the activity glyph.
 */
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  agentTitleBase,
  groupingDockStore,
  useAgentTerminalsStore,
  type AgentTerminal,
} from "../stores/agentTerminals";
import {
  setAgentPaneVisibility,
  useAgentRuntimeStore,
} from "../stores/agentRuntime";
import {
  agentStateTooltip,
  displayAgentState,
  displayLabel,
} from "../lib/agentState";
import { switchToProject, useWorkspacesStore } from "../stores/workspaces";
import {
  closeAgentTerminal,
  getOrCreateAgentSession,
  openGlobalTerminal,
} from "../lib/agentSessions";
import { getSession } from "../lib/termSessions";
import { setTerminalNotifications } from "../lib/agentNotifications";
import { copyText } from "../lib/clipboard";
import { useProjectColorVar } from "../lib/projectColors";
import { basename } from "../lib/path";
import { agentPaneTitle } from "../lib/agentPaneTitle";
import { Dock, type DockPaneProps } from "./Dock";
import { ContextMenu } from "./ContextMenu";
import { AgentSubagents } from "./AgentSubagents";
import { requestAgentLaunch } from "../lib/agentLaunchRequest";
import {
  ActivityGlyph,
  IcBell,
  IcClaude,
  IcCodex,
  IcDisconnected,
  IcSparkle,
  IcTerminal,
} from "./icons";
import "./AgentDock.css";

const useConnected = (workspacePath: string): boolean =>
  useWorkspacesStore((s) => s.workspaces.some((w) => w.path === workspacePath));

// ---------------------------------------------------------------------------
// Badge overlay (live session topic — hidden until the agent sets a title)
// ---------------------------------------------------------------------------

function AgentBadge({
  terminal,
  connected,
}: {
  terminal: AgentTerminal;
  connected: boolean;
}) {
  const projectColor = useProjectColorVar(terminal.workspacePath);
  // The session's cleaned live OSC 0/2 topic. No title yet (fresh shell,
  // agent not running) = no badge; the
  // tab keeps the stable project name. Clicks fall through to the pane
  // (focus + switch-to-project), so the badge is display-only.
  const rawTopic = useAgentTerminalsStore((s) => s.paneTitle[terminal.id]);
  const runtime = useAgentRuntimeStore((s) => s.states[terminal.id]);
  const topic = agentPaneTitle(
    runtime?.kind ?? (terminal.kind === "shell" ? "claude" : terminal.kind),
    rawTopic ?? "",
    [terminal.title, agentTitleBase(terminal.workspacePath), basename(terminal.workspacePath)],
  );
  const display = displayAgentState(runtime);
  const semantic =
    display === "working" || display === "starting" || display === "blocked" || display === "done"
      ? displayLabel(display)
      : "";
  if (!topic && !semantic) return null;

  return (
    <div
      className="agent-badge"
      // Project identity: a soft project-tinted outline (softened in CSS).
      style={{ "--project-color": projectColor } as CSSProperties}
      title={`${runtime ? agentStateTooltip(runtime) : "No Agent"}${topic ? `\nTopic: ${topic}` : ""}\n${terminal.workspacePath}${connected ? "" : " — project not open"}`}
    >
      {!connected && <IcDisconnected className="agent-badge-disconnected" />}
      <span className="agent-badge-state">{semantic}</span>
      {semantic && topic && <span className="agent-badge-separator">·</span>}
      {topic && <span className="truncate">{topic}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dock flavor components
// ---------------------------------------------------------------------------

const AgentPane = memo(function AgentPane({
  terminal,
  visible,
  focused,
}: DockPaneProps<AgentTerminal>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const connected = useConnected(terminal.workspacePath);
  // Highlight every terminal of the project currently active up top.
  const activeProject = useWorkspacesStore(
    (s) => s.activePath === terminal.workspacePath,
  );
  const runtime = useAgentRuntimeStore((s) => s.states[terminal.id]);

  // Mount = attach the (possibly already-running) session; unmount = detach
  // ONLY. Disposal happens exclusively through closeAgentTerminal — drag
  // survival depends on this. getOrCreate is idempotent, so StrictMode's
  // double mount shares one session/shell.
  useEffect(() => {
    const session = getOrCreateAgentSession(terminal);
    session.attach(hostRef.current!);
    return () => session.detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  // Acknowledge on REAL visibility, the same predicate the evidence side
  // uses: the dock-tab flag says nothing about the panel being hidden,
  // maximized away, or showing the other group — all display:none. The
  // host's ResizeObserver is what fires on an actual reveal (⌘`), and a
  // tab flip behind a hidden panel leaves offsetParent null, so a Done
  // nobody saw stays unseen.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const isWatched = () => host.offsetParent !== null && document.hasFocus();
    const ack = () => {
      if (isWatched()) getSession(terminal.id)?.acknowledge();
    };
    ack();
    const ro = new ResizeObserver(ack);
    ro.observe(host);
    // The runtime's ambient sweep has no DOM of its own; this is the only
    // live answer to "can the user see it right now".
    const unwatch = setAgentPaneVisibility(terminal.id, isWatched);
    return () => {
      unwatch();
      ro.disconnect();
    };
  }, [terminal.id]);

  return (
    <div
      className={`dock-pane ${focused ? "focused" : ""} ${
        activeProject ? "active-project" : ""
      }`}
      style={{ display: visible ? undefined : "none" }}
      onMouseDown={() => {
        // Clicking an agent terminal pulls its project to the front
        // (reopening it when it was closed — fire-and-forget).
        void switchToProject(terminal.workspacePath);
        // By id — panes know their group but not their grouping.
        useAgentTerminalsStore.getState().setActiveTerminalById(terminal.id);
        const session = getSession(terminal.id);
        session?.acknowledge();
        session?.focus();
      }}
    >
      <div className="dock-pane-host" ref={hostRef} />
      <AgentBadge terminal={terminal} connected={connected} />
      {(terminal.kind !== "shell" || runtime?.occupancy === "present") && (
        <AgentSubagents terminalId={terminal.id} />
      )}
    </div>
  );
});

function AgentTabIcon({ terminal }: { terminal: AgentTerminal }) {
  const projectColor = useProjectColorVar(terminal.workspacePath);
  const runtime = useAgentRuntimeStore((s) => s.states[terminal.id]);
  const kind = terminal.kind === "shell" && runtime?.occupancy === "present"
    ? runtime.kind
    : terminal.kind;
  if (kind === "shell") {
    return <IcTerminal style={{ color: projectColor }} />;
  }
  return (
    <span
      className="dock-tab-agent-icon"
      title={
        runtime
          ? agentStateTooltip(runtime)
        : `${kind === "claude" ? "Claude" : "Codex"} — No Agent`
      }
    >
      {kind === "claude" ? (
        <IcClaude style={{ color: projectColor }} />
      ) : (
        <IcCodex style={{ color: projectColor }} />
      )}
    </span>
  );
}

function AgentTabBadge({ terminal }: { terminal: AgentTerminal }) {
  const connected = useConnected(terminal.workspacePath);
  const runtime = useAgentRuntimeStore((s) => s.states[terminal.id]);
  const agentPresent = terminal.kind !== "shell" || runtime?.occupancy === "present";
  const activity = agentPresent ? displayAgentState(runtime) : "absent";
  const showStatus = activity !== "idle" && activity !== "unknown";
  const projectColor = useProjectColorVar(terminal.workspacePath);
  // Live store read (AgentTabMenu pattern) — the toggle must reflect
  // immediately, independent of how the Dock memoizes the terminal prop.
  const notify = useAgentTerminalsStore(
    (s) => s.terminals[terminal.id]?.notificationsEnabled ?? false,
  );
  return (
    <>
      {agentPresent && showStatus && (
        <span
          className="dock-tab-agent-status"
          title={
            runtime
              ? agentStateTooltip(runtime)
              : `${terminal.kind === "claude" ? "Claude" : "Codex"} — No Agent`
          }
        >
          <ActivityGlyph
            activity={activity}
            idle={<IcTerminal />}
            color={projectColor}
          />
        </span>
      )}
      {notify && <IcBell className="dock-tab-bell" />}
      {!connected && <IcDisconnected className="dock-tab-disconnected" />}
    </>
  );
}

/** Tab right-click menu. Holds only the terminal id — enabled state is a
 *  live store read, never a snapshot from the right-click moment. */
function AgentTabMenu({
  terminalId,
  x,
  y,
  onClose,
}: {
  terminalId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const enabled = useAgentTerminalsStore(
    (s) => s.terminals[terminalId]?.notificationsEnabled ?? false,
  );
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <button onClick={() => {
        const tail = getSession(terminalId)?.readTail(50, 16_384).join("\n") ?? "";
        void copyText(tail);
        onClose();
      }}>Copy Last 50 Lines</button>
      <button onClick={() => {
        const tail = getSession(terminalId)?.readTail(12, 4096).join("\n") ?? "Terminal no longer available";
        window.dispatchEvent(new CustomEvent("talos:open-agent-inbox", { detail: { message: tail } }));
        onClose();
      }}>Open Last 12 Lines</button>
      <div className="ctx-menu-sep" />
      <button
        onClick={() => {
          onClose();
          // The flag is set synchronously inside; only the opportunistic
          // banner-authorization tail can reject (exotic — swallow it).
          void setTerminalNotifications(terminalId, !enabled).catch(() => {});
        }}
      >
        {enabled ? "Disable Notifications" : "Enable Notifications"}
      </button>
    </ContextMenu>
  );
}

function AgentEmpty() {
  const activePath = useWorkspacesStore((s) => s.activePath);
  return (
    <div className="terminal-empty">
      <div className="terminal-empty-text">
        {activePath
          ? "No global terminals"
          : "No global terminals — open a project to create one"}
      </div>
      <div className="terminal-empty-actions">
        <button
          className="primary-btn"
          disabled={!activePath}
          onClick={() => activePath && openGlobalTerminal(activePath, "shell")}
        >
          <IcTerminal /> New Shell
        </button>
        <button
          className="primary-btn"
          disabled={!activePath}
          onClick={() => activePath && requestAgentLaunch({ workspacePath: activePath, scope: "global", kind: "claude" })}
        >
          <IcSparkle /> Claude Agent
        </button>
        <button
          className="primary-btn"
          disabled={!activePath}
          onClick={() => activePath && requestAgentLaunch({ workspacePath: activePath, scope: "global", kind: "codex" })}
        >
          <IcSparkle /> Codex Agent
        </button>
      </div>
    </div>
  );
}

/** One grouping's dock body (the Panel mounts one per grouping, hidden with
 *  display:none while another tab is in front — terminals stay alive). */
export default function AgentDock({ groupingId }: { groupingId: string }) {
  const [tabMenu, setTabMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  return (
    <>
      <Dock
        store={groupingDockStore(groupingId)}
        Pane={AgentPane}
        TabIcon={AgentTabIcon}
        TabBadge={AgentTabBadge}
        Empty={AgentEmpty}
        tabTooltip={(t) =>
          `${t.kind === "shell" ? "Shell" : t.kind === "claude" ? "Claude" : "Codex"} — ${t.workspacePath}`
        }
        defaultTitle={(t) => agentTitleBase(t.workspacePath)}
        onSelectTerminal={(t) => void switchToProject(t.workspacePath)}
        onTabContextMenu={(t, e) => {
          e.preventDefault();
          const runtime = useAgentRuntimeStore.getState().states[t.id];
          const notificationsEnabled =
            useAgentTerminalsStore.getState().terminals[t.id]?.notificationsEnabled === true;
          if (
            t.kind !== "shell" ||
            runtime?.occupancy === "present" ||
            notificationsEnabled
          )
            setTabMenu({ id: t.id, x: e.clientX, y: e.clientY });
        }}
        closeTerminal={closeAgentTerminal}
      />
      {/* Sibling, not child: ContextMenu is position:fixed and its backdrop
          must sit outside the tab's event handlers (Titlebar pattern). */}
      {tabMenu && (
        <AgentTabMenu
          terminalId={tabMenu.id}
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
        />
      )}
    </>
  );
}
