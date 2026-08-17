import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  archiveIsolatedTask,
  deleteIsolatedTaskRecord,
  dispatchTaskPlanStep,
  keepIsolatedTaskBranch,
  launchReadOnlyReviewAgent,
  MAX_REVIEW_FEEDBACK_COMMENT_CHARS,
  mergeIsolatedTask,
  forkIsolatedTask,
  removeIsolatedTaskWorktree,
  removeWorktreeCheckout,
  restoreTaskCode,
  restoreTaskConversation,
  sendIsolatedTaskFeedback,
} from "../lib/isolatedTasks";
import { reviewAgentChanges } from "../lib/agentInbox";
import {
  gitLog,
  gitWorktreeList,
  gitWorktreeOpen,
  onRepoChanged,
  previewServers,
  type GitWorktree,
} from "../lib/ipc";
import { getWorkspaceLsp, useLspStatusVersionValue } from "../lib/lsp/servers";
import { basename } from "../lib/path";
import { useProjectColorVar } from "../lib/projectColors";
import {
  checkStateFor,
  markAgentTaskReviewOpened,
  useAgentTasksStore,
} from "../stores/agentTasks";
import {
  useIsolatedTasksStore,
  type IsolatedTask,
  type TaskPlanStep,
} from "../stores/isolatedTasks";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useReviewCommentsStore } from "../stores/reviewComments";
import { useWorkspace, useWorkspacesStore } from "../stores/workspaces";
import {
  IcBranch,
  IcCheck,
  IcChevronDown,
  IcChevronRight,
  IcDiff,
  IcPlus,
  IcRefresh,
  IcTerminal,
  IcTrash,
} from "./icons";
import { requestNewIsolatedTask } from "./WorktreeDialog";
import "./IsolatedTasksPanel.css";

const outcomeLabel: Record<IsolatedTask["outcome"], string> = {
  active: "Active",
  applied: "Applied",
  kept: "Branch kept",
  archived: "Archived",
  discarded: "Checkout removed",
};

function worktreeBranch(worktree: GitWorktree): string {
  return worktree.branch ?? (worktree.detached ? "Detached HEAD" : "No branch");
}

function WorktreeCard({
  worktree,
  repoPath,
  current,
  onWorktreesChanged,
}: {
  worktree: GitWorktree;
  repoPath: string;
  current: boolean;
  onWorktreesChanged: () => void;
}) {
  // Workspace tabs and the project-color picker are keyed by checkout path.
  // Use that same identity here so a worktree keeps its color when opened.
  const projectColor = useProjectColorVar(worktree.path);
  const [operation, setOperation] = useState<"open" | "remove" | null>(null);
  const busy = operation !== null;
  const open = useWorkspacesStore((state) =>
    state.workspaces.some((workspace) => workspace.path === worktree.path),
  );

  const openWorktree = async () => {
    if (busy) return;
    setOperation("open");
    try {
      await gitWorktreeOpen(repoPath, worktree.path);
      await useWorkspacesStore.getState().openWorkspace(worktree.path);
    } catch (error) {
      await message(String(error), { title: "Open Worktree", kind: "error" });
    } finally {
      setOperation(null);
    }
  };

  const removeWorktree = async () => {
    if (busy || worktree.main) return;
    const approved = await confirm(
      `Remove worktree “${basename(worktree.path)}”? The checkout folder will be deleted, but ${worktree.branch ? `the branch “${worktree.branch}”` : "any referenced commits"} will be kept. Git will refuse if the checkout has uncommitted changes.`,
      { title: "Remove Worktree?", kind: "warning" },
    );
    if (!approved) return;
    setOperation("remove");
    try {
      if (await removeWorktreeCheckout(repoPath, worktree.path, worktree.branch)) {
        onWorktreesChanged();
      }
    } catch (error) {
      await message(String(error), { title: "Remove Worktree", kind: "error" });
    } finally {
      setOperation(null);
    }
  };

  return (
    <div
      className={`worktree-card accent-scope ${current ? "current" : ""}`}
      style={{ "--accent": projectColor } as CSSProperties}
    >
      <div className="worktree-card-content">
        <div className="worktree-card-copy">
          <div className="worktree-card-title-row">
            <span className="worktree-card-name">{basename(worktree.path)}</span>
            <span className="worktree-badges">
              {current && <span className="worktree-badge current">Current</span>}
              {!current && open && <span className="worktree-badge">Open</span>}
              {worktree.main && <span className="worktree-badge">Main</span>}
            </span>
          </div>
          <div className="worktree-card-meta">
            <IcBranch />
            <span className="worktree-card-branch">{worktreeBranch(worktree)}</span>
            <span className="worktree-card-separator">·</span>
            <span>{worktree.head ? worktree.head.slice(0, 8) : "Unborn HEAD"}</span>
            {worktree.detached && <span>· Detached</span>}
            {worktree.locked && <span>· Locked</span>}
            {worktree.prunable && <span className="bad">· Prunable</span>}
          </div>
          <div className="worktree-card-path" title={worktree.path}>{worktree.path}</div>
        </div>
        {(!current || !worktree.main) && (
          <div className="worktree-card-actions">
            {!current && (
              <button
                className="worktree-card-action"
                disabled={busy || worktree.prunable}
                title={worktree.prunable ? "This checkout is prunable and cannot be opened" : undefined}
                onClick={() => void openWorktree()}
              >
                {operation === "open" ? "Opening…" : open ? "Switch" : "Open"}
              </button>
            )}
            {!worktree.main && (
              <button
                className="worktree-card-delete"
                disabled={busy}
                title="Remove worktree (branch is kept)"
                aria-label={`Remove worktree ${basename(worktree.path)}`}
                onClick={() => void removeWorktree()}
              >
                <IcTrash />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  worktree,
  current,
  initiallyExpanded,
  onWorktreesChanged,
}: {
  task: IsolatedTask;
  worktree?: GitWorktree;
  current: boolean;
  initiallyExpanded: boolean;
  onWorktreesChanged: () => void;
}) {
  // Live task rows match their worktree's workspace-tab color. A historical
  // row has no checkout identity left, so it falls back to the parent project.
  const projectColor = useProjectColorVar(worktree?.path ?? task.parentWorkspacePath);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [commitCount, setCommitCount] = useState<number | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [commentPath, setCommentPath] = useState("");
  const [commentLine, setCommentLine] = useState(1);
  const [commentBody, setCommentBody] = useState("");
  const [planTitle, setPlanTitle] = useState("");
  const agentTask = useAgentTasksStore(
    (state) => task.agentTerminalId ? state.tasks[task.agentTerminalId] : undefined,
  );
  const runtime = useAgentRuntimeStore((state) =>
    task.agentTerminalId ? state.states[task.agentTerminalId] : undefined,
  );
  const subagentMap = useAgentRuntimeStore((state) => state.subagents);
  const subagents = task.agentTerminalId ? subagentMap[task.agentTerminalId] ?? [] : [];
  const allComments = useReviewCommentsStore((state) => state.comments);
  const comments = useMemo(
    () => allComments.filter((comment) => comment.taskId === task.id),
    [allComments, task.id],
  );
  const outdatedCommentCount = comments.filter((comment) =>
    comment.terminalId !== task.agentTerminalId ||
    comment.generation !== agentTask?.generation ||
    comment.fingerprint !== agentTask?.latestFingerprint
  ).length;
  // Re-render when published diagnostics change; diagnostics() itself is a
  // framework-free snapshot API used by editors and future automation.
  const lspVersion = useLspStatusVersionValue();
  const diagnostics = useMemo(() => {
    const files = agentTask?.latestSnapshot?.changedFiles ?? [];
    const lsp = getWorkspaceLsp(task.worktreePath);
    return files.reduce((count, file) => count + lsp.diagnostics(file).length, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentTask?.latestFingerprint, lspVersion, task.worktreePath]);
  const open = useWorkspacesStore((state) =>
    state.workspaces.some((workspace) => workspace.path === task.worktreePath),
  );
  const checkoutAvailable = Boolean(worktree && !worktree.prunable);
  const checkoutUnavailableTitle = worktree?.prunable
    ? "This worktree is prunable because its checkout path is unavailable"
    : undefined;

  useEffect(() => {
    if (!expanded || task.outcome === "discarded" || !worktree || worktree.prunable) {
      setCommitCount(null);
      setPreviewCount(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      gitLog(task.worktreePath, 200, 0).then((result) => {
        const baseIndex = result.commits.findIndex((commit) => commit.oid === task.baseCommit);
        return baseIndex === -1 ? result.commits.length : baseIndex;
      }),
      previewServers(task.worktreePath).then(
        (servers) => servers.filter((server) => server.projectMatch).length,
      ),
    ]).then(([commits, previews]) => {
      if (!cancelled) {
        setCommitCount(commits);
        setPreviewCount(previews);
      }
    }, () => {
      if (!cancelled) {
        setCommitCount(null);
        setPreviewCount(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, task.baseCommit, task.outcome, task.worktreePath, worktree]);

  const run = async (title: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      onWorktreesChanged();
    } catch (error) {
      await message(String(error), { title, kind: "error" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const review = async () => {
    if (!checkoutAvailable) throw new Error("The task checkout is not available.");
    if (task.agentTerminalId && agentTask) {
      const result = await reviewAgentChanges(task.agentTerminalId);
      if (!result.ok) throw new Error(result.message);
      if (!markAgentTaskReviewOpened(
        task.agentTerminalId,
        result.review.generation,
        result.review.fingerprint,
      )) {
        throw new Error(
          "Changes changed while the review was opening. Open the current evidence again.",
        );
      }
      return;
    }
    await useWorkspacesStore.getState().openWorkspace(task.worktreePath);
  };

  const reviewTurnFile = async (path: string) => {
    if (!agentTask?.turnBaseTree || !checkoutAvailable) return;
    await useWorkspacesStore.getState().openWorkspace(task.worktreePath);
    const workspace = useWorkspacesStore
      .getState()
      .workspaces.find((item) => item.path === task.worktreePath);
    workspace?.editor.getState().openDiff({
      repoPath: task.worktreePath,
      path,
      kind: "checkpoint",
      oid: agentTask.turnBaseTree,
    });
  };

  const patchStep = (stepId: string, patch: Partial<TaskPlanStep>) => {
    const latest = useIsolatedTasksStore.getState().tasks[task.id];
    if (!latest) return;
    useIsolatedTasksStore.getState().patchTask(task.id, {
      plan: latest.plan.map((step) => step.id === stepId ? { ...step, ...patch, id: step.id } : step),
    });
  };

  const addPlanStep = () => {
    const title = planTitle.trim();
    if (!title) return;
    const latest = useIsolatedTasksStore.getState().tasks[task.id];
    if (!latest) return;
    useIsolatedTasksStore.getState().patchTask(task.id, {
      plan: [...latest.plan, {
        id: crypto.randomUUID(),
        title,
        prompt: title,
        status: "draft",
        dispatch: "worktree",
        dependsOn: [],
        candidateCount: 1,
        childTaskIds: [],
      }],
    });
    setPlanTitle("");
  };

  return (
    <div
      className={`isolated-task-card accent-scope outcome-${task.outcome} ${current ? "current" : ""}`}
      style={{ "--accent": projectColor } as CSSProperties}
    >
      <button
        className="isolated-task-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <IcChevronDown /> : <IcChevronRight />}
        <span className="worktree-summary-copy">
          <span className="isolated-task-name">{task.name}</span>
          <span className="worktree-summary-meta">
            {worktree ? worktreeBranch(worktree) : task.branch} · {task.worktreePath}
          </span>
        </span>
        <span className="worktree-badges">
          {current && <span className="worktree-badge current">Current</span>}
          {!current && open && worktree && <span className="worktree-badge">Open</span>}
          {worktree && <span className="worktree-badge">{worktree.main ? "Main" : "Linked"}</span>}
          <span className="worktree-badge task">Task</span>
          <span className="isolated-task-outcome">{outcomeLabel[task.outcome]}</span>
          {!worktree && task.outcome !== "discarded" && <span className="worktree-badge bad">Not linked</span>}
        </span>
      </button>
      {expanded && (
        <div className="isolated-task-body">
          <div className="isolated-task-branch"><IcBranch /> {worktree ? worktreeBranch(worktree) : task.branch}</div>
          {worktree && (worktree.locked || worktree.prunable || worktree.detached) && (
            <div className="worktree-flags">
              {worktree.detached && <span>Detached</span>}
              {worktree.locked && <span>Locked</span>}
              {worktree.prunable && <span className="bad">Prunable</span>}
            </div>
          )}
          <div className="isolated-task-evidence">
            <span><IcDiff /> {agentTask?.latestSnapshot?.changedFiles.length ?? 0} files</span>
            <span>{agentTask?.latestTurnChangedFiles.length ?? 0} latest turn</span>
            <span className={agentTask?.latestSnapshot?.conflictedFiles.length ? "bad" : ""}>
              {agentTask?.latestSnapshot?.conflictedFiles.length ?? 0} conflicts
            </span>
            <span><IcCheck /> {agentTask ? checkStateFor(agentTask).replace("_", " ") : "no checks"}</span>
            <span>{diagnostics} diagnostics</span>
            <span>{commitCount ?? "—"} commits</span>
            <span>{previewCount ?? "—"} previews</span>
          </div>
          {(agentTask?.latestSnapshot?.head || worktree?.head) && (
            <div className="isolated-task-head">HEAD {(agentTask?.latestSnapshot?.head ?? worktree?.head)?.slice(0, 8)} · base {task.baseCommit.slice(0, 8)}</div>
          )}
          {runtime && (
            <div className="isolated-task-agent">
              <IcTerminal /> {runtime.kind} · {runtime.lifecycle} · {subagents.length} child agent{subagents.length === 1 ? "" : "s"}
            </div>
          )}
          <div className="isolated-task-path">{task.worktreePath}</div>
          {agentTask?.turnBaseTree && agentTask.latestTurnChangedFiles.length > 0 && (
            <div className="isolated-task-turn-files">
              <span>Latest turn</span>
              {agentTask.latestTurnChangedFiles.map((file) => (
                <button
                  key={file}
                  disabled={!checkoutAvailable}
                  title={checkoutUnavailableTitle}
                  onClick={() => void run("Open Turn Diff", () => reviewTurnFile(file))}
                >{file}</button>
              ))}
            </div>
          )}
          <div className="isolated-task-plan">
            <div className="isolated-task-plan-title">Plan</div>
            {task.plan.map((step) => {
              const dependenciesReady = step.dependsOn.every((id) =>
                task.plan.find((candidate) => candidate.id === id)?.status === "completed",
              );
              return (
                <div className="isolated-task-plan-step" key={step.id}>
                  <input
                    className="isolated-task-plan-name"
                    value={step.title}
                    aria-label="Plan step title"
                    onChange={(event) => patchStep(step.id, { title: event.target.value })}
                  />
                  <textarea
                    value={step.prompt}
                    aria-label="Plan step prompt"
                    onChange={(event) => patchStep(step.id, { prompt: event.target.value })}
                  />
                  <div className="isolated-task-plan-controls">
                    <select
                      value={step.status}
                      aria-label="Plan step status"
                      onChange={(event) => patchStep(step.id, { status: event.target.value as TaskPlanStep["status"] })}
                    >
                      <option value="draft">Draft</option>
                      <option value="approved">Approved</option>
                      <option value="running">Running</option>
                      <option value="completed">Completed</option>
                      <option value="blocked">Blocked</option>
                    </select>
                    <select
                      value={step.dispatch}
                      aria-label="Plan step dispatch"
                      onChange={(event) => patchStep(step.id, { dispatch: event.target.value as TaskPlanStep["dispatch"] })}
                    >
                      <option value="worktree">New worktree</option>
                      <option value="queue">Queue for agent</option>
                      <option value="steer">Steer now</option>
                    </select>
                    {step.dispatch === "worktree" && (
                      <select
                        value={step.candidateCount}
                        aria-label="Candidate count"
                        onChange={(event) => patchStep(step.id, { candidateCount: Number(event.target.value) })}
                      >
                        <option value={1}>1 candidate</option>
                        <option value={2}>Best of 2</option>
                        <option value={3}>Best of 3</option>
                        <option value={4}>Best of 4</option>
                      </select>
                    )}
                    <button
                      disabled={busy || step.status !== "approved" || !dependenciesReady}
                      onClick={() => void run("Dispatch Plan Step", () => dispatchTaskPlanStep(task, step))}
                    >Dispatch</button>
                    <button
                      title="Remove plan step"
                      onClick={() => useIsolatedTasksStore.getState().patchTask(task.id, {
                        plan: task.plan.filter((candidate) => candidate.id !== step.id).map((candidate) => ({
                          ...candidate,
                          dependsOn: candidate.dependsOn.filter((id) => id !== step.id),
                        })),
                      })}
                    >×</button>
                  </div>
                  {task.plan.length > 1 && (
                    <div className="isolated-task-plan-deps">
                      <span>Depends on</span>
                      {task.plan.filter((candidate) => candidate.id !== step.id).map((candidate) => (
                        <label key={candidate.id}>
                          <input
                            type="checkbox"
                            checked={step.dependsOn.includes(candidate.id)}
                            onChange={(event) => patchStep(step.id, {
                              dependsOn: event.target.checked
                                ? [...step.dependsOn, candidate.id]
                                : step.dependsOn.filter((id) => id !== candidate.id),
                            })}
                          />
                          {candidate.title}
                        </label>
                      ))}
                    </div>
                  )}
                  {step.childTaskIds.length > 0 && (
                    <div className="isolated-task-plan-children">
                      {step.childTaskIds.length} isolated candidate{step.childTaskIds.length === 1 ? "" : "s"} created — compare them as separate task cards.
                    </div>
                  )}
                </div>
              );
            })}
            <div className="isolated-task-plan-add">
              <input
                value={planTitle}
                placeholder="Add plan step"
                onChange={(event) => setPlanTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addPlanStep();
                }}
              />
              <button disabled={!planTitle.trim()} onClick={addPlanStep}>Add</button>
            </div>
          </div>
          {agentTask && agentTask.latestSnapshot && (
            <div className="isolated-task-comments">
              <div className="isolated-task-comment-entry">
                <select value={commentPath} onChange={(event) => setCommentPath(event.target.value)}>
                  <option value="">File…</option>
                  {agentTask.latestSnapshot.changedFiles.map((file) => <option key={file} value={file}>{file}</option>)}
                </select>
                <input
                  type="number"
                  min={1}
                  value={commentLine}
                  aria-label="Line"
                  onChange={(event) => setCommentLine(Math.max(1, Number(event.target.value) || 1))}
                />
                <input
                  value={commentBody}
                  maxLength={MAX_REVIEW_FEEDBACK_COMMENT_CHARS}
                  placeholder="Line comment"
                  onChange={(event) => setCommentBody(event.target.value)}
                />
                <button
                  disabled={
                    !commentPath ||
                    !commentBody.trim() ||
                    !task.agentTerminalId ||
                    !agentTask.latestFingerprint
                  }
                  onClick={() => {
                    const terminalId = task.agentTerminalId;
                    const fingerprint = agentTask.latestFingerprint;
                    if (!terminalId || !fingerprint) return;
                    const latest = useAgentTasksStore.getState().tasks[terminalId];
                    const latestTaskOwner = useIsolatedTasksStore.getState().tasks[task.id];
                    if (
                      !latest ||
                      latestTaskOwner?.agentTerminalId !== terminalId ||
                      latest.generation !== agentTask.generation ||
                      latest.latestFingerprint !== fingerprint
                    ) {
                      void message(
                        "Review evidence changed before this comment was added. Review the current changes and try again.",
                        { title: "Add Review Comment", kind: "warning" },
                      );
                      return;
                    }
                    useReviewCommentsStore.getState().add({
                      taskId: task.id,
                      terminalId,
                      generation: agentTask.generation,
                      fingerprint,
                      path: commentPath,
                      line: commentLine,
                      body: commentBody.trim(),
                    });
                    setCommentBody("");
                  }}
                >Add</button>
              </div>
              {comments.map((comment) => (
                <div key={comment.id} className="isolated-task-comment">
                  <span>{comment.path}:{comment.line}</span>
                  <span>
                    {comment.body}
                    {(comment.terminalId !== task.agentTerminalId ||
                      comment.generation !== agentTask.generation ||
                      comment.fingerprint !== agentTask.latestFingerprint) && " · Outdated evidence"}
                  </span>
                  <button onClick={() => useReviewCommentsStore.getState().remove(comment.id)}>×</button>
                </div>
              ))}
              {comments.length > 0 && (
                <button
                  className="isolated-task-send-feedback"
                  disabled={busy || outdatedCommentCount > 0}
                  title={outdatedCommentCount > 0
                    ? "Remove outdated comments before sending feedback"
                    : undefined}
                  onClick={() => void run("Send Review Feedback", () => sendIsolatedTaskFeedback(task))}
                >
                  Send review feedback ({comments.length} pending{outdatedCommentCount > 0 ? `, ${outdatedCommentCount} outdated` : ""})
                </button>
              )}
            </div>
          )}
          <div className="isolated-task-actions">
            {task.outcome !== "discarded" && worktree && (
              <button disabled={busy || !checkoutAvailable} title={checkoutUnavailableTitle} onClick={() => void run("Review Task", review)}>
                {open ? "Compare Changes" : "Open & Compare"}
              </button>
            )}
            {task.outcome === "archived" && worktree && (
              <button disabled={busy || !checkoutAvailable} title={checkoutUnavailableTitle} onClick={() => void run("Restore Code", () => restoreTaskCode(task))}>Restore Code</button>
            )}
            {task.outcome === "archived" && worktree && (
              <button disabled={busy || !checkoutAvailable} title={checkoutUnavailableTitle} onClick={() => void run("Restore Conversation", () => restoreTaskConversation(task))}>Restore Conversation</button>
            )}
            {task.outcome !== "discarded" && (
              <button disabled={busy} onClick={() => void run("Fork Task", async () => { await forkIsolatedTask(task); })}>Fork</button>
            )}
            {task.outcome === "active" && worktree && (
              <button disabled={busy || !checkoutAvailable} title={checkoutUnavailableTitle} onClick={() => void run("Apply Task", () => mergeIsolatedTask(task))}>Apply / Merge</button>
            )}
            {task.outcome !== "discarded" && worktree && (
              <button disabled={busy || !checkoutAvailable} title={checkoutUnavailableTitle} onClick={() => void run("Launch Review Agent", async () => {
                launchReadOnlyReviewAgent(task);
              })}>Read-only Review Agent</button>
            )}
            {task.outcome === "active" && (
              <button disabled={busy} onClick={() => void run("Keep Task Branch", async () => {
                await keepIsolatedTaskBranch(task);
              })}>Keep Branch</button>
            )}
            {task.outcome !== "discarded" && task.outcome !== "archived" && (
              <button disabled={busy} onClick={() => void run("Archive Task", () => archiveIsolatedTask(task))}>Archive</button>
            )}
            {task.outcome !== "discarded" && worktree && !worktree.main && (
              <button className="danger" disabled={busy} onClick={() => void run("Remove Worktree", async () => {
                if (!(await confirm(
                  `Remove the worktree for “${task.name}”? The checkout folder will be deleted and the task will move to Removed tasks. The branch “${task.branch}” will be kept.`,
                  { title: "Remove Task Worktree?", kind: "warning" },
                ))) return;
                await removeIsolatedTaskWorktree(task);
              })}>Remove Worktree…</button>
            )}
            <button className="danger" disabled={busy} onClick={() => void run("Delete Task Record", async () => {
              if (!(await confirm(
                worktree
                  ? `Permanently delete the task record “${task.name}”? Its stored plan, review links, and history will be removed. The worktree and branch will remain.`
                  : `Permanently delete the task record “${task.name}”? Its stored plan, review links, and history will be removed.`,
                { title: "Delete Task Record?", kind: "warning" },
              ))) return;
              deleteIsolatedTaskRecord(task);
            })}>Delete Task Record…</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IsolatedTasksPanel() {
  const ws = useWorkspace();
  const [query, setQuery] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSequence = useRef(0);
  const taskMap = useIsolatedTasksStore((state) => state.tasks);
  const tasks = useMemo(() => Object.values(taskMap), [taskMap]);

  const refreshWorktrees = useCallback(async (showProgress = true) => {
    const sequence = ++refreshSequence.current;
    if (showProgress) setRefreshing(true);
    try {
      const items = await gitWorktreeList(ws.path);
      if (sequence !== refreshSequence.current) return;
      setWorktrees(items);
      setLoadError(null);
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      setLoadError(String(error));
    } finally {
      if (sequence === refreshSequence.current) setRefreshing(false);
    }
  }, [ws.path]);

  useEffect(() => {
    setWorktrees(null);
    void refreshWorktrees(false);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onRepoChanged((change) => {
      if (change.repoPath === ws.path && change.gitChanged) void refreshWorktrees(false);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {
      // The manual refresh still works if the optional watcher listener could
      // not be installed (for example while the app is tearing down).
    });
    return () => {
      disposed = true;
      refreshSequence.current += 1;
      unlisten?.();
    };
  }, [refreshWorktrees, ws.path]);

  const normalized = query.trim().toLowerCase();
  const worktreePaths = useMemo(
    () => new Set((worktrees ?? []).map((worktree) => worktree.path)),
    [worktrees],
  );
  const repositoryTasks = useMemo(() => {
    // Follow persisted parent links transitively so historical grandchildren
    // remain visible even when an intermediate parent checkout was removed
    // outside Talos. Live worktree paths seed the repository family.
    const relatedPaths = new Set(worktreePaths);
    const relatedTaskIds = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (
          relatedTaskIds.has(task.id) ||
          (!relatedPaths.has(task.parentWorkspacePath) && !relatedPaths.has(task.worktreePath))
        ) continue;
        relatedTaskIds.add(task.id);
        relatedPaths.add(task.worktreePath);
        changed = true;
      }
    }
    return tasks.filter((task) => relatedTaskIds.has(task.id));
  }, [tasks, worktreePaths]);
  const repoPath = worktrees?.find((worktree) => worktree.main)?.path ?? ws.path;
  const taskForPath = useMemo(() => {
    const matches = new Map<string, IsolatedTask>();
    for (const task of repositoryTasks) {
      if (task.outcome === "discarded") continue;
      const existing = matches.get(task.worktreePath);
      if (!existing || existing.updatedAt < task.updatedAt) matches.set(task.worktreePath, task);
    }
    return matches;
  }, [repositoryTasks]);
  const matchesQuery = (worktree: GitWorktree, task?: IsolatedTask): boolean =>
    !normalized || [
      worktree.path,
      worktree.branch ?? "",
      worktree.head ?? "",
      worktree.main ? "main" : "linked",
      worktree.detached ? "detached" : "",
      worktree.locked ? "locked" : "",
      worktree.prunable ? "prunable" : "",
      task?.name ?? "",
      task?.outcome ?? "",
    ].some((value) => value.toLowerCase().includes(normalized));
  const visibleWorktrees = (worktrees ?? [])
    .filter((worktree) => matchesQuery(worktree, taskForPath.get(worktree.path)))
    .sort((left, right) =>
      Number(right.main) - Number(left.main) ||
      worktreeBranch(left).localeCompare(worktreeBranch(right)) ||
      left.path.localeCompare(right.path),
    );
  const removedTasks = repositoryTasks
    .filter((task) => !worktreePaths.has(task.worktreePath))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const visibleRemovedTasks = removedTasks
    .filter((task) =>
      !normalized || [task.name, task.branch, task.worktreePath, task.outcome]
        .some((value) => value.toLowerCase().includes(normalized)),
    );
  const hasVisibleRemovedTasks = showRemoved && visibleRemovedTasks.length > 0;

  return (
    <div className="isolated-tasks-panel">
      <div className="sidebar-header worktree-sidebar-header">
        <span>Worktrees</span>
        <span className="worktree-count">{worktrees?.length ?? "—"}</span>
        <button
          className="worktree-new-task"
          title="Create an isolated worktree and launch an agent"
          onClick={() => requestNewIsolatedTask(ws.path)}
        >
          <IcPlus />
          <span>New Task</span>
        </button>
        <button
          className={`worktree-refresh ${refreshing ? "refreshing" : ""}`}
          title="Refresh worktrees"
          aria-label="Refresh worktrees"
          disabled={refreshing}
          onClick={() => void refreshWorktrees()}
        >
          <IcRefresh />
        </button>
      </div>
      <div className="isolated-task-filter">
        <input value={query} placeholder="Search worktrees" onChange={(event) => setQuery(event.target.value)} />
      </div>
      {removedTasks.length > 0 && (
        <button
          className={`worktree-removed-toggle ${showRemoved ? "active" : ""}`}
          title="Task records retained after their Git worktree was removed"
          onClick={() => setShowRemoved(!showRemoved)}
        >
          {showRemoved ? <IcChevronDown /> : <IcChevronRight />}
          <span>{showRemoved ? "Hide" : "Show"} {removedTasks.length} removed task{removedTasks.length === 1 ? "" : "s"}</span>
        </button>
      )}
      {loadError && (
        <div className="worktree-load-error">
          <span>{loadError}</span>
          <button onClick={() => void refreshWorktrees()}>Retry</button>
        </div>
      )}
      {worktrees === null && !loadError ? (
        <div className="isolated-tasks-empty">Loading repository worktrees…</div>
      ) : visibleWorktrees.length === 0 && !hasVisibleRemovedTasks ? (
        <div className="isolated-tasks-empty">
          {normalized
            ? `No worktrees${showRemoved ? " or removed tasks" : ""} match this search.`
            : "Git returned no worktrees for this repository."}
        </div>
      ) : (
        <div className="isolated-task-list">
          {visibleWorktrees.map((worktree) => {
            const task = taskForPath.get(worktree.path);
            return task ? (
              <TaskCard
                key={task.id}
                task={task}
                worktree={worktree}
                current={worktree.path === ws.path}
                initiallyExpanded={worktree.path === ws.path}
                onWorktreesChanged={() => void refreshWorktrees(false)}
              />
            ) : (
              <WorktreeCard
                key={worktree.path}
                worktree={worktree}
                repoPath={repoPath}
                current={worktree.path === ws.path}
                onWorktreesChanged={() => void refreshWorktrees(false)}
              />
            );
          })}
          {showRemoved && visibleRemovedTasks.length > 0 && (
            <div className="worktree-history">
              <div className="worktree-history-title">Removed tasks · Git checkout no longer exists</div>
              {visibleRemovedTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  current={false}
                  initiallyExpanded={false}
                  onWorktreesChanged={() => void refreshWorktrees(false)}
                />
              ))}
            </div>
          )}
          {showRemoved && visibleRemovedTasks.length === 0 && (
            <div className="worktree-history-empty">No removed tasks match this search.</div>
          )}
        </div>
      )}
    </div>
  );
}
