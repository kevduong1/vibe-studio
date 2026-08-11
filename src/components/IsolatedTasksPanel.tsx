import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  archiveIsolatedTask,
  discardIsolatedTask,
  dispatchTaskPlanStep,
  keepIsolatedTaskBranch,
  launchReadOnlyReviewAgent,
  mergeIsolatedTask,
  forkIsolatedTask,
  restoreTaskCode,
  restoreTaskConversation,
  sendIsolatedTaskFeedback,
} from "../lib/isolatedTasks";
import { reviewAgentChanges } from "../lib/agentInbox";
import { gitLog, previewServers } from "../lib/ipc";
import { getWorkspaceLsp, useLspStatusVersionValue } from "../lib/lsp/servers";
import { useProjectColorVar } from "../lib/projectColors";
import { checkStateFor, useAgentTasksStore } from "../stores/agentTasks";
import {
  useIsolatedTasksStore,
  type IsolatedTask,
  type TaskPlanStep,
} from "../stores/isolatedTasks";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useReviewCommentsStore } from "../stores/reviewComments";
import { useWorkspace, useWorkspacesStore } from "../stores/workspaces";
import { IcBranch, IcCheck, IcChevronDown, IcChevronRight, IcDiff, IcTerminal } from "./icons";
import "./IsolatedTasksPanel.css";

const outcomeLabel: Record<IsolatedTask["outcome"], string> = {
  active: "Active",
  applied: "Applied",
  kept: "Branch kept",
  archived: "Archived",
  discarded: "Checkout removed",
};

function TaskCard({ task, initiallyExpanded }: { task: IsolatedTask; initiallyExpanded: boolean }) {
  const projectColor = useProjectColorVar(task.parentWorkspacePath);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [commitCount, setCommitCount] = useState<number | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [commentPath, setCommentPath] = useState("");
  const [commentLine, setCommentLine] = useState(1);
  const [commentBody, setCommentBody] = useState("");
  const [planTitle, setPlanTitle] = useState("");
  const agentTasks = useAgentTasksStore((state) => state.tasks);
  const agentTask = useMemo(
    () => Object.values(agentTasks).find((candidate) => candidate.isolatedTaskId === task.id),
    [agentTasks, task.id],
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

  useEffect(() => {
    if (!expanded || task.outcome === "discarded") return;
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
  }, [expanded, task.baseCommit, task.outcome, task.worktreePath]);

  const run = async (title: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      await message(String(error), { title, kind: "error" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const review = async () => {
    if (task.agentTerminalId && agentTask) {
      const result = await reviewAgentChanges(task.agentTerminalId);
      if (!result.ok) throw new Error(result.message);
      return;
    }
    await useWorkspacesStore.getState().openWorkspace(task.worktreePath);
  };

  const reviewTurnFile = async (path: string) => {
    if (!agentTask?.turnBaseTree) return;
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
      className={`isolated-task-card accent-scope outcome-${task.outcome}`}
      style={{ "--accent": projectColor } as CSSProperties}
    >
      <button className="isolated-task-summary" onClick={() => setExpanded(!expanded)}>
        {expanded ? <IcChevronDown /> : <IcChevronRight />}
        <span className="isolated-task-name">{task.name}</span>
        <span className="isolated-task-outcome">{outcomeLabel[task.outcome]}</span>
      </button>
      {expanded && (
        <div className="isolated-task-body">
          <div className="isolated-task-branch"><IcBranch /> {task.branch}</div>
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
          {agentTask?.latestSnapshot?.head && (
            <div className="isolated-task-head">HEAD {agentTask.latestSnapshot.head.slice(0, 8)} · base {task.baseCommit.slice(0, 8)}</div>
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
                <button key={file} onClick={() => void run("Open Turn Diff", () => reviewTurnFile(file))}>{file}</button>
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
                  placeholder="Line comment"
                  onChange={(event) => setCommentBody(event.target.value)}
                />
                <button
                  disabled={!commentPath || !commentBody.trim()}
                  onClick={() => {
                    useReviewCommentsStore.getState().add({
                      taskId: task.id,
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
                  <span>{comment.body}</span>
                  <button onClick={() => useReviewCommentsStore.getState().remove(comment.id)}>×</button>
                </div>
              ))}
              {comments.length > 0 && (
                <button
                  className="isolated-task-send-feedback"
                  disabled={busy}
                  onClick={() => void run("Send Review Feedback", () => sendIsolatedTaskFeedback(task))}
                >Send {comments.length} comment{comments.length === 1 ? "" : "s"} to agent</button>
              )}
            </div>
          )}
          <div className="isolated-task-actions">
            {task.outcome !== "discarded" && (
              <button disabled={busy} onClick={() => void run("Review Task", review)}>
                {open ? "Compare Changes" : "Open & Compare"}
              </button>
            )}
            {task.outcome === "archived" && (
              <button disabled={busy} onClick={() => void run("Restore Code", () => restoreTaskCode(task))}>Restore Code</button>
            )}
            {task.outcome === "archived" && (
              <button disabled={busy} onClick={() => void run("Restore Conversation", () => restoreTaskConversation(task))}>Restore Conversation</button>
            )}
            {task.outcome !== "discarded" && (
              <button disabled={busy} onClick={() => void run("Fork Task", async () => { await forkIsolatedTask(task); })}>Fork</button>
            )}
            {task.outcome === "active" && (
              <button disabled={busy} onClick={() => void run("Apply Task", () => mergeIsolatedTask(task))}>Apply / Merge</button>
            )}
            {task.outcome !== "discarded" && (
              <button disabled={busy} onClick={() => void run("Launch Review Agent", async () => {
                launchReadOnlyReviewAgent(task);
              })}>Read-only Review Agent</button>
            )}
            {task.outcome === "active" && (
              <button disabled={busy} onClick={() => void run("Keep Task Branch", async () => {
                keepIsolatedTaskBranch(task);
              })}>Keep Branch</button>
            )}
            {task.outcome !== "discarded" && task.outcome !== "archived" && (
              <button disabled={busy} onClick={() => void run("Archive Task", () => archiveIsolatedTask(task))}>Archive</button>
            )}
            {task.outcome !== "discarded" && task.cleanupProvenance === "created-by-vibe" && (
              <button className="danger" disabled={busy} onClick={() => void run("Discard Task", async () => {
                if (!(await confirm(
                  `Discard “${task.name}” and remove its checkout? The branch “${task.branch}” will be kept.`,
                  { title: "Discard Isolated Task?", kind: "warning" },
                ))) return;
                await discardIsolatedTask(task);
              })}>Discard…</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function IsolatedTasksPanel() {
  const ws = useWorkspace();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const taskMap = useIsolatedTasksStore((state) => state.tasks);
  const tasks = useMemo(() => Object.values(taskMap), [taskMap]);
  const currentTask = tasks.find((task) => task.worktreePath === ws.path);
  const parentPath = currentTask?.parentWorkspacePath ?? ws.path;
  const normalized = query.trim().toLowerCase();
  const relevant = tasks
    .filter((task) => showAll || task.parentWorkspacePath === parentPath)
    .filter((task) =>
      !normalized || [task.name, task.branch, task.worktreePath, task.parentWorkspacePath, task.outcome]
        .some((value) => value.toLowerCase().includes(normalized)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const initiallyExpandedTaskId = currentTask?.id
    ?? relevant.find((task) => task.outcome === "active")?.id
    ?? relevant[0]?.id;
  const groups = new Map<string, IsolatedTask[]>();
  for (const task of relevant) {
    groups.set(task.parentWorkspacePath, [...(groups.get(task.parentWorkspacePath) ?? []), task]);
  }
  return (
    <div className="isolated-tasks-panel">
      <div className="sidebar-header">
        <span>Isolated Tasks</span>
      </div>
      <div className="isolated-task-filter">
        <input value={query} placeholder="Search tasks and archive" onChange={(event) => setQuery(event.target.value)} />
        <button className={showAll ? "active" : ""} onClick={() => setShowAll(!showAll)}>{showAll ? "All projects" : "This project"}</button>
      </div>
      {relevant.length === 0 ? (
        <div className="isolated-tasks-empty">Create one from the titlebar + menu with New Worktree + Agent.</div>
      ) : (
        <div className="isolated-task-list">
          {[...groups].map(([project, projectTasks]) => (
            <div className="isolated-task-project" key={project}>
              {showAll && <div className="isolated-task-project-title">{project}</div>}
              {projectTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  initiallyExpanded={task.id === initiallyExpandedTaskId}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
