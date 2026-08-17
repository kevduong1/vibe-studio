import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import {
  acceptAgentTask,
  checkStateFor,
  isInboxActionable,
  inboxWaitingAt,
  markAgentTaskFeedback,
  markAgentTaskReviewOpened,
  markAgentTaskReviewed,
  nextActionableId,
  refreshAgentTask,
  retryAgentTaskBaseline,
  setAgentTaskAutoRun,
  setAgentTaskPipeline,
  sortInboxItems,
  useAgentTasksStore,
  type AgentInboxItem,
  type CheckState,
  type ReviewState,
} from "../stores/agentTasks";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { useWorkspacesStore } from "../stores/workspaces";
import { useProjectColorVar } from "../lib/projectColors";
import { projectDisplayName } from "../lib/projectNames";
import { basename } from "../lib/path";
import { agentPaneTitle } from "../lib/agentPaneTitle";
import { displayAgentState, displayLabel, reasonLabel } from "../lib/agentState";
import { focusAgentTerminal, reviewAgentChanges } from "../lib/agentInbox";
import { getSession } from "../lib/termSessions";
import { useNativeOverlay } from "../lib/nativeOverlays";
import {
  isAutoCheckTrusted,
  runAgentTaskPipeline,
  selectablePipelineRoots,
  setAutoCheckTrusted,
} from "../lib/checkPipelines";
import { loadTaskDocument, type TaskDef } from "../lib/tasks";
import { focusCheckNode } from "../lib/checkPipelines";
import { IcInbox } from "./icons";
import "./AttentionInbox.css";

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

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function useWorkspaceTerminalVersion(enabled: boolean): number {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const [version, bump] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribes = workspaces.map((ws) => ws.terminal.subscribe(() => bump((value) => value + 1)));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [enabled, workspaces]);
  return version;
}

function useInboxItems(subscribeTerminals: boolean): AgentInboxItem[] {
  const terminalVersion = useWorkspaceTerminalVersion(subscribeTerminals);
  const runtimes = useAgentRuntimeStore((state) => state.states);
  const tasks = useAgentTasksStore((state) => state.tasks);
  const globals = useAgentTerminalsStore((state) => state.terminals);
  const globalTopics = useAgentTerminalsStore((state) => state.paneTitle);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  return useMemo(() => sortInboxItems(Object.values(runtimes).map((runtime) => {
    const global = globals[runtime.terminalId];
    const ws = workspaces.find((item) => item.path === runtime.workspacePath);
    const local = ws?.terminal.getState().terminals[runtime.terminalId];
    const project = projectDisplayName(runtime.workspacePath);
    const rawTopic = globalTopics[runtime.terminalId] ?? ws?.terminal.getState().paneTitle[runtime.terminalId] ?? "";
    return {
      runtime,
      task: tasks[runtime.terminalId],
      title: global?.title ?? local?.title ?? runtime.kind,
      project,
      topic: agentPaneTitle(runtime.kind, rawTopic, [
        global?.title,
        local?.title,
        project,
        basename(runtime.workspacePath),
      ]),
    };
  })), [runtimes, tasks, globals, globalTopics, workspaces, terminalVersion]);
}

function InboxRow({
  item,
  selected,
  now,
  onSelect,
  onActivate,
}: {
  item: AgentInboxItem;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onActivate: () => void;
}) {
  const projectColor = useProjectColorVar(item.runtime.workspacePath);
  const display = displayAgentState(item.runtime);
  const checkState = item.task ? checkStateFor(item.task) : "not_run";

  return (
    <button
      role="option"
      aria-selected={selected}
      className={`inbox-row accent-scope ${selected ? "selected" : ""}`}
      style={{ "--accent": projectColor } as CSSProperties}
      tabIndex={selected ? 0 : -1}
      onFocus={onSelect}
      onClick={onSelect}
      onDoubleClick={onActivate}
    >
      <span className="inbox-row-top"><strong>{item.runtime.kind === "claude" ? "Claude" : "Codex"}</strong><span>{elapsed(inboxWaitingAt(item), now)}</span></span>
      <span className="inbox-row-title">{item.title} · {item.project}</span>
      {item.topic && <span className="inbox-topic truncate">{item.topic}</span>}
      <span className="inbox-labels">
        <span className={`state-label ${display}`}>{displayLabel(display)}</span>
        {item.task && <span className={`review-label ${item.task.reviewState}`}>{REVIEW_LABEL[item.task.reviewState]}</span>}
        {!!item.task?.latestSnapshot?.conflictedFiles.length && <span className="evidence-label conflicted">Conflicts</span>}
        {checkState !== "not_run" && <span className={`evidence-label ${checkState}`}>{CHECK_LABEL[checkState]}</span>}
      </span>
    </button>
  );
}

function InboxOverlay({
  items,
  initialView,
  initialMessage,
  onClose,
}: {
  items: AgentInboxItem[];
  initialView: "attention" | "all";
  initialMessage: string | null;
  onClose: () => void;
}) {
  useNativeOverlay();
  const [view, setView] = useState(initialView);
  const visible = view === "attention" ? items.filter(isInboxActionable) : items;
  const [selectedId, setSelectedId] = useState(visible[0]?.runtime.terminalId ?? null);
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [peek, setPeek] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pipelines, setPipelines] = useState<TaskDef[]>([]);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const selected = visible.find((item) => item.runtime.terminalId === selectedId) ?? visible[0];
  const selectedProjectColor = useProjectColorVar(selected?.runtime.workspacePath ?? null);

  useEffect(() => {
    dialogRef.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    for (const item of items) void refreshAgentTask(item.runtime.terminalId);
    return () => window.clearInterval(timer);
  }, []); // opening is the refresh boundary

  useEffect(() => setMessage(initialMessage), [initialMessage]);

  useEffect(() => {
    if (selectedId && !visible.some((item) => item.runtime.terminalId === selectedId)) {
      setSelectedId(visible[0]?.runtime.terminalId ?? null);
    }
  }, [visible, selectedId]);

  useEffect(() => {
    setPeek(null);
    setPipelineError(null);
    setPipelines([]);
    if (!selected) {
      return;
    }
    void refreshAgentTask(selected.runtime.terminalId);
    let current = true;
    void loadTaskDocument(selected.runtime.workspacePath).then((document) => {
      if (current) setPipelines(selectablePipelineRoots(document));
    }, (error) => {
      if (current) {
        setPipelines([]);
        setPipelineError(String(error));
      }
    });
    return () => { current = false; };
  }, [selected?.runtime.terminalId]);

  const activate = async (id: string) => {
    const result = await focusAgentTerminal(id);
    if (result.ok) onClose();
    else setMessage(result.message);
  };

  const familyCount = selected
    ? new Set(useWorkspacesStore.getState().workspaces
        .filter((ws) => ws.tabGroupId === useWorkspacesStore.getState().workspaces.find((item) => item.path === selected.runtime.workspacePath)?.tabGroupId)
        .map((ws) => ws.path)).size
    : 0;
  const pipelineRunning = selected?.task?.checkRuns.some((run) => run.status === "running") ?? false;
  const selectedCheckState = selected?.task ? checkStateFor(selected.task) : "not_run";

  const openReview = async (item: AgentInboxItem) => {
    const result = await reviewAgentChanges(item.runtime.terminalId);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    if (!markAgentTaskReviewOpened(
      item.runtime.terminalId,
      result.review.generation,
      result.review.fingerprint,
    )) {
      setMessage("Changes changed while the review was opening. Open the current evidence again.");
      return;
    }
    onClose();
  };

  return (
    <>
      <div className="inbox-backdrop" onMouseDown={onClose} />
      <div
        className="attention-inbox accent-scope"
        role="dialog"
        aria-label="Agent attention and review inbox"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          const target = event.target as HTMLElement;
          const listNavigation =
            target === event.currentTarget || target.closest(".inbox-list") !== null;
          if (event.key === "Escape") onClose();
          else if (
            listNavigation &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            if (!visible.length) return;
            const index = Math.max(0, visible.findIndex((item) => item.runtime.terminalId === selected?.runtime.terminalId));
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setSelectedId(visible[(index + delta + visible.length) % visible.length].runtime.terminalId);
          } else if (
            (target === event.currentTarget || target.closest(".inbox-row") !== null) &&
            event.key === "Enter" &&
            selected
          ) {
            event.preventDefault();
            void activate(selected.runtime.terminalId);
          }
        }}
      >
        <div className="inbox-head">
          <strong>Agent Inbox</strong>
          <div className="inbox-view-tabs" role="tablist">
            <button role="tab" aria-selected={view === "attention"} className={view === "attention" ? "active" : ""} onClick={() => setView("attention")}>Attention</button>
            <button role="tab" aria-selected={view === "all"} className={view === "all" ? "active" : ""} onClick={() => setView("all")}>All</button>
          </div>
        </div>
        {message && <div className="inbox-message" role="status">{message}</div>}
        <div className="inbox-content">
          <div className="inbox-list" role="listbox" aria-label={`${view} agents`}>
            {visible.length === 0 && <div className="inbox-empty">No agents need attention.</div>}
            {visible.map((item) => <InboxRow
              key={item.runtime.terminalId}
              item={item}
              selected={item.runtime.terminalId === selected?.runtime.terminalId}
              now={now}
              onSelect={() => setSelectedId(item.runtime.terminalId)}
              onActivate={() => void activate(item.runtime.terminalId)}
            />)}
          </div>
          <div
            className="inbox-detail accent-scope"
            style={selectedProjectColor ? ({ "--accent": selectedProjectColor } as CSSProperties) : undefined}
          >
            {!selected ? <div className="inbox-empty">No agent terminals.</div> : <>
              <div className="inbox-detail-title"><strong>{selected.title}</strong><span>{selected.project}</span></div>
              <div className="inbox-detail-meta">
                <span>{selected.runtime.scope === "global" ? "Global terminal" : "Project terminal"}</span>
                {familyCount > 1 && <span className="family-chip">Related workspace</span>}
                <span>{selected.runtime.reason ? reasonLabel(selected.runtime.reason) : "No structured attention reason"}</span>
              </div>
              {selected.topic && <div className="inbox-detail-topic">Topic: {selected.topic}</div>}
              {!selected.task && <div className="inbox-warning">
                {selected.runtime.occupancy === "present"
                  ? "Review details are initializing."
                  : "Start an agent in this dedicated terminal to track review changes and checks."}
              </div>}
              {selected.task && <>
                <div className="review-scope">Review scope: all repository changes since <code>{selected.task.baseHeadCaptured ? (selected.task.baseHead?.slice(0, 8) ?? "unborn repository") : "unavailable"}</code>. Shared working trees cannot attribute files to one agent.</div>
                {selected.task.baselineCapturedLate && <div className="inbox-warning">This baseline was captured after launch, so the review scope may not include earlier changes from this agent.</div>}
                {selected.task.baseline === "failed" && <div className="inbox-warning">Baseline unavailable: {selected.task.baselineError} <button onClick={() => void retryAgentTaskBaseline(selected.runtime.terminalId)}>Retry</button></div>}
                {selected.task.reviewState === "stale" && <div className="inbox-warning">Previously accepted changes have changed. Review the current diff before accepting again.</div>}
                <div className="inbox-review-actions">
                  <button onClick={() => void openReview(selected)}>Review changes</button>
                  <button
                    disabled={selected.task.reviewOpenedFingerprint !== selected.task.latestFingerprint || !selected.task.latestFingerprint}
                    title={selected.task.reviewOpenedFingerprint === selected.task.latestFingerprint ? "Confirm that you inspected the opened evidence" : "Open the current changes before marking them reviewed"}
                    onClick={() => {
                      if (!selected.task?.latestFingerprint) return;
                      if (!markAgentTaskReviewed(
                        selected.runtime.terminalId,
                        selected.task.generation,
                        selected.task.latestFingerprint,
                      )) {
                        setMessage("The review evidence changed. Open the current changes again.");
                      }
                    }}
                  >Mark reviewed</button>
                  <button
                    disabled={selected.task.reviewedFingerprint !== selected.task.latestFingerprint || !selected.task.latestFingerprint}
                    title={selected.task.reviewedFingerprint === selected.task.latestFingerprint ? "Accept the reviewed changes" : "Review the current changes first"}
                    onClick={() => {
                      const selectedTask = selected.task;
                      const fingerprint = selectedTask?.latestFingerprint;
                      if (!selectedTask || !fingerprint) return;
                      if (!acceptAgentTask(
                        selected.runtime.terminalId,
                        selectedTask.generation,
                        fingerprint,
                      )) {
                        setMessage("The review evidence changed. Review the current changes before accepting them.");
                      }
                    }}
                  >Accept</button>
                  <button
                    disabled={!selected.task.latestFingerprint}
                    onClick={() => {
                      const selectedTask = selected.task;
                      const fingerprint = selectedTask?.latestFingerprint;
                      if (!selectedTask || !fingerprint) return;
                      if (!markAgentTaskFeedback(
                        selected.runtime.terminalId,
                        selectedTask.generation,
                        fingerprint,
                      )) {
                        setMessage("The review evidence changed. Review the current changes before requesting revisions.");
                        return;
                      }
                      void activate(selected.runtime.terminalId);
                    }}
                  >Needs changes</button>
                </div>
                <label className="pipeline-select">Check pipeline
                  <select value={selected.task.selectedPipeline ?? ""} onChange={(event) => setAgentTaskPipeline(selected.runtime.terminalId, event.target.value || null)}>
                    <option value="">None</option>
                    {pipelines.map((pipeline) => <option key={pipeline.label} value={pipeline.label}>{pipeline.label}</option>)}
                  </select>
                </label>
                <div className="pipeline-actions">
                  <button disabled={!selected.task.selectedPipeline || pipelineRunning} onClick={() => {
                    if (!selected.task?.selectedPipeline) return;
                    setPipelineError(null);
                    void runAgentTaskPipeline(selected.runtime.terminalId, selected.task.selectedPipeline).catch((error) => setPipelineError(String(error)));
                  }}>{pipelineRunning ? "Checks running…" : "Run checks"}</button>
                  <label><input type="checkbox" checked={selected.task.autoRun} disabled={!selected.task.selectedPipeline} onChange={async (event) => {
                    const enabled = event.target.checked;
                    if (enabled && !isAutoCheckTrusted(selected.runtime.workspacePath)) {
                      const approved = await confirm("Allow this project to run the selected check pipeline automatically after every agent turn? Repository task commands can execute arbitrary code.", { title: "Approve Automatic Checks?", kind: "warning" });
                      if (!approved) return;
                      setAutoCheckTrusted(selected.runtime.workspacePath, true);
                    }
                    setAgentTaskAutoRun(selected.runtime.terminalId, enabled);
                  }} /> Auto-run on turn completion</label>
                  {isAutoCheckTrusted(selected.runtime.workspacePath) && <button onClick={() => {
                    setAutoCheckTrusted(selected.runtime.workspacePath, false);
                    setAgentTaskAutoRun(selected.runtime.terminalId, false);
                  }}>Revoke auto-run approval</button>}
                </div>
                {selected.task.selectedPipeline && <div className={`check-summary ${selectedCheckState}`}>{CHECK_LABEL[selectedCheckState]}</div>}
                {pipelineError && <div className="inbox-warning">{pipelineError}</div>}
                {selected.task.checkRuns.slice().reverse().map((run) => <div className="check-run" key={run.id}>
                  <div><strong>{run.pipelineLabel}</strong> · {run.status}</div>
                  {run.nodes.map((node) => <button key={node.label} disabled={!node.terminalId} onClick={() => node.terminalId && focusCheckNode(node.terminalId)}>{node.label}: {node.status}{node.durationMs != null ? ` (${Math.round(node.durationMs / 100) / 10}s)` : ""}</button>)}
                </div>)}
              </>}
              <div className="peek-actions">
                {peek === null ? <button onClick={() => setPeek(getSession(selected.runtime.terminalId)?.readTail(12, 4096).join("\n") ?? "Terminal no longer available")}>Peek context</button> : <><button onClick={() => setPeek(getSession(selected.runtime.terminalId)?.readTail(12, 4096).join("\n") ?? "Terminal no longer available")}>Refresh</button><button onClick={() => setPeek(null)}>Hide</button></>}
                <button className="primary-btn" onClick={() => void activate(selected.runtime.terminalId)}>Open terminal</button>
              </div>
              {peek !== null && <pre className="inbox-peek">{peek || "(empty terminal tail)"}</pre>}
            </>}
          </div>
        </div>
      </div>
    </>
  );
}

export default function AttentionInbox() {
  const [open, setOpen] = useState(false);
  const items = useInboxItems(open);
  const actionable = items.filter(isInboxActionable);
  const [initialView, setInitialView] = useState<"attention" | "all">("all");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [initialMessage, setInitialMessage] = useState<string | null>(null);

  const openInbox = () => {
    setInitialMessage(null);
    setInitialView(actionable.length ? "attention" : "all");
    setOpen(true);
  };

  useEffect(() => {
    const listener = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message ?? null;
      setInitialMessage(message);
      setInitialView(actionable.length ? "attention" : "all");
      setOpen(true);
    };
    window.addEventListener("vibe:open-agent-inbox", listener);
    return () => window.removeEventListener("vibe:open-agent-inbox", listener);
  }, [actionable.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        openInbox();
      } else if (mod && event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const id = nextActionableId(items, focusedId, event.key === "ArrowDown" ? 1 : -1);
        if (id) {
          setFocusedId(id);
          void focusAgentTerminal(id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focusedId, actionable.length]);

  return <div className="attention-inbox-wrap">
    <button className={`icon-btn attention-inbox-toggle ${open ? "active" : ""}`} title="Agent Inbox (⌘⇧I)" onClick={openInbox} aria-label="Agent Inbox">
      <IcInbox />
      {actionable.length > 0 && <span className="inbox-count">{actionable.length > 99 ? "99+" : actionable.length}</span>}
    </button>
    {open && <InboxOverlay items={items} initialView={initialView} initialMessage={initialMessage} onClose={() => setOpen(false)} />}
  </div>;
}
