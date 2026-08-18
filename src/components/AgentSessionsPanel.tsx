import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { focusAgentTerminal } from "../lib/agentInbox";
import { requestAgentLaunch } from "../lib/agentLaunchRequest";
import {
  projectAgentSessions,
  type AgentSessionsSection,
} from "../lib/agentSessionsView";
import {
  displayAgentState,
  displayLabel,
  type AgentKind,
} from "../lib/agentState";
import { useProjectColorVar } from "../lib/projectColors";
import {
  selectAgentSubagents,
  useAgentRuntimeStore,
} from "../stores/agentRuntime";
import {
  checkStateFor,
  inboxWaitingAt,
  isInboxActionable,
  type AgentInboxItem,
  type CheckState,
  type ReviewState,
} from "../stores/agentTasks";
import { useUiStore } from "../stores/ui";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  IcChevronRight,
  IcClaude,
  IcCodex,
  IcDiff,
  IcInbox,
  IcPlus,
  IcSparkle,
} from "./icons";
import { useAgentSessionItems } from "./useAgentSessionItems";
import "./AgentSessionsPanel.css";

const REVIEW_LABEL: Record<ReviewState, string> = {
  clean: "Clean",
  unreviewed: "Unreviewed",
  reviewed: "Reviewed",
  feedback: "Feedback",
  stale: "Approval Stale",
  accepted: "Accepted",
};

const CHECK_LABEL: Record<CheckState, string> = {
  not_run: "Not Run",
  running: "Checks Running",
  passed: "Checks Passed",
  failed: "Checks Failed",
  cancelled: "Checks Cancelled",
  stale: "Checks Stale",
};

/** Fallback headline when a session has neither a topic nor a tab title that
 * says anything the project badge does not already say. */
const AGENT_NAME: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function AgentSessionRow({
  item,
  now,
  onOpen,
}: {
  item: AgentInboxItem;
  now: number;
  onOpen: (terminalId: string) => void;
}) {
  const projectColor = useProjectColorVar(item.runtime.workspacePath);
  const childCount = useAgentRuntimeStore(
    (state) => selectAgentSubagents(state, item.runtime.terminalId).length,
  );
  const display = displayAgentState(item.runtime);
  const checkState = item.task ? checkStateFor(item.task) : "not_run";
  // Dedicated tabs default to the project basename, so a bare title would
  // just repeat the project badge; fall back to the agent's own name instead.
  const primary =
    item.topic ||
    (item.title !== item.project ? item.title : AGENT_NAME[item.runtime.kind]);
  const titleNote =
    item.title !== primary && item.title !== item.project ? item.title : null;
  const changedFiles = item.task?.latestSnapshot?.changedFiles.length ?? 0;

  return (
    <button
      className="agent-session-row accent-scope"
      style={{ "--accent": projectColor } as CSSProperties}
      onClick={() => onOpen(item.runtime.terminalId)}
      title={`Open ${item.title} in ${item.project}`}
    >
      <span className="agent-session-icon" aria-hidden="true">
        {item.runtime.kind === "claude" ? <IcClaude /> : <IcCodex />}
      </span>
      <span className="agent-session-row-body">
        <span className="agent-session-row-top">
          <strong className="truncate">{primary}</strong>
          <span className="agent-session-elapsed">
            {elapsed(inboxWaitingAt(item), now)}
          </span>
        </span>
        <span className="agent-session-location">
          <span className="agent-session-project truncate">{item.project}</span>
          {titleNote && (
            <span className="agent-session-tab truncate">{titleNote}</span>
          )}
        </span>
        <span className="agent-session-chips">
          <span className={`agent-session-chip lifecycle ${display}`}>
            {displayLabel(display)}
          </span>
          {item.task && (
            <span className={`agent-session-chip review ${item.task.reviewState}`}>
              {REVIEW_LABEL[item.task.reviewState]}
            </span>
          )}
          {changedFiles > 0 && (
            <span
              className="agent-session-chip changes"
              title={`${changedFiles} changed ${
                changedFiles === 1 ? "file" : "files"
              } since this agent started`}
            >
              <IcDiff />
              {changedFiles} {changedFiles === 1 ? "file" : "files"}
            </span>
          )}
          {!!item.task?.latestSnapshot?.conflictedFiles.length && (
            <span className="agent-session-chip evidence conflicted">Conflicts</span>
          )}
          {checkState !== "not_run" && (
            <span className={`agent-session-chip evidence ${checkState}`}>
              {CHECK_LABEL[checkState]}
            </span>
          )}
          {childCount > 0 && (
            <span className="agent-session-child-count">
              {childCount} child {childCount === 1 ? "agent" : "agents"}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function AgentSessionSection({
  section,
  now,
  quietExpanded,
  onToggleQuiet,
  onOpen,
}: {
  section: AgentSessionsSection;
  now: number;
  quietExpanded: boolean;
  onToggleQuiet: () => void;
  onOpen: (terminalId: string) => void;
}) {
  const quiet = section.id === "quiet";
  const expanded = !quiet || quietExpanded;
  const listId = `agent-session-section-${section.id}`;

  return (
    <section className={`agent-session-section ${section.id}`}>
      {quiet ? (
        <button
          className="agent-session-section-head collapsible"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggleQuiet}
        >
          <IcChevronRight className={expanded ? "expanded" : ""} />
          <span>{section.label}</span>
          <span className="agent-session-section-count">{section.items.length}</span>
        </button>
      ) : (
        <div className="agent-session-section-head">
          <span>{section.label}</span>
          <span className="agent-session-section-count">{section.items.length}</span>
        </div>
      )}
      {expanded && (
        <div id={listId} className="agent-session-section-list">
          {section.items.map((item) => (
            <AgentSessionRow
              key={item.runtime.terminalId}
              item={item}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Global sidebar census of semantic agent sessions across both terminal
 * docks. Review/check mutations remain in the detailed review overlay. */
export default function AgentSessionsPanel() {
  const items = useAgentSessionItems(true);
  const view = useUiStore((state) => state.agentSessionsView);
  const quietExpanded = useUiStore(
    (state) => state.agentSessionsQuietExpanded,
  );
  const setView = useUiStore((state) => state.setAgentSessionsView);
  const toggleQuiet = useUiStore((state) => state.toggleAgentSessionsQuiet);
  const activePath = useWorkspacesStore((state) => state.activePath);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const routeSequence = useRef(0);
  const actionableCount = items.filter(isInboxActionable).length;
  const sections = useMemo(
    () => projectAgentSessions(items, view),
    [items, view],
  );
  const visibleSections = useMemo(
    () => sections.filter((section) => section.items.length > 0),
    [sections],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const openSession = (terminalId: string) => {
    const sequence = ++routeSequence.current;
    setRoutingError(null);
    void focusAgentTerminal(terminalId).then((result) => {
      // focusAgentTerminal acknowledges only after it has activated the exact
      // pane and acquired its session. Listing or hovering never acknowledges.
      if (sequence === routeSequence.current && result.ok === false) {
        setRoutingError(result.message);
      }
    });
  };

  return (
    <div className="agent-sessions-panel">
      <div className="agent-sessions-header">
        <span className="agent-sessions-title">Agent Sessions</span>
        <div className="agent-sessions-actions">
          <button
            className="icon-btn"
            title="Open full agent review details"
            aria-label="Open full agent review details"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("talos:open-agent-inbox"))
            }
          >
            <IcInbox />
          </button>
          <button
            className="icon-btn"
            disabled={!activePath}
            title={
              activePath
                ? "New global agent session"
                : "Open a project to start an agent session"
            }
            aria-label="New global agent session"
            onClick={() =>
              activePath &&
              requestAgentLaunch({
                workspacePath: activePath,
                scope: "global",
                kind: "claude",
              })
            }
          >
            <IcPlus />
          </button>
        </div>
      </div>

      <div
        className="agent-sessions-view-switch"
        role="group"
        aria-label="Agent session view"
      >
        <button
          className={view === "all" ? "active" : ""}
          aria-pressed={view === "all"}
          onClick={() => setView("all")}
        >
          All
          <span>{items.length}</span>
        </button>
        <button
          className={view === "attention" ? "active" : ""}
          aria-pressed={view === "attention"}
          onClick={() => setView("attention")}
        >
          Attention
          <span className={actionableCount > 0 ? "actionable" : ""}>
            {actionableCount}
          </span>
        </button>
      </div>

      {routingError && (
        <div className="agent-sessions-error" role="status">
          {routingError}
        </div>
      )}

      <div className="agent-sessions-scroll">
        {visibleSections.length === 0 ? (
          <div className="agent-sessions-empty">
            <span className="agent-sessions-empty-icon" aria-hidden="true">
              {view === "attention" ? <IcInbox /> : <IcSparkle />}
            </span>
            <strong>
              {view === "attention"
                ? "No sessions need attention"
                : "No agent sessions"}
            </strong>
            <span>
              {view === "attention"
                ? "Questions, finished turns, and review work will appear here."
                : "Live Claude and Codex sessions from every project will appear here."}
            </span>
          </div>
        ) : (
          visibleSections.map((section) => (
            <AgentSessionSection
              key={section.id}
              section={section}
              now={now}
              quietExpanded={quietExpanded}
              onToggleQuiet={toggleQuiet}
              onOpen={openSession}
            />
          ))
        )}
      </div>
    </div>
  );
}
