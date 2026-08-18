import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { confirm, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { useEditor, useRepo, useWorkspace } from "../stores/workspaces";
import {
  gitGenerateCommitMessage,
  gitListRefs,
  type FileStatus,
  type RefLabel,
} from "../lib/ipc";
import { statusColor, statusLetter, statusPaths } from "../lib/status";
import { basename, dirname } from "../lib/path";
import { ContextMenu } from "./ContextMenu";
import GitGraph from "./GitGraph";
import {
  IcApply,
  IcBox,
  IcBranch,
  IcCheck,
  IcChevronDown,
  IcChevronRight,
  IcDiscard,
  IcFile,
  IcFilter,
  IcMinus,
  IcPlus,
  IcPop,
  IcPull,
  IcPush,
  IcRefresh,
  IcRemote,
  IcSparkle,
  IcSpinner,
  IcSync,
  IcTrash,
  IcTree,
} from "./icons";
import "./SourceControl.css";

const IsolatedTasksPanel = lazy(() => import("./IsolatedTasksPanel"));

/* ----------------------------------------------------------------------- */
/* Collapsible section                                                      */
/* ----------------------------------------------------------------------- */

function Section({
  title,
  count,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`sc-section ${open ? "open" : ""}`}>
      <div className="sc-section-header" onClick={onToggle}>
        <span className={`sc-chevron ${open ? "open" : ""}`}>
          <IcChevronRight />
        </span>
        <span className="sc-section-title truncate">{title}</span>
        {count !== undefined && <span className="sc-badge">{count}</span>}
        {actions && (
          <span
            className="sc-section-actions"
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </span>
        )}
      </div>
      {open && children}
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* File row                                                                 */
/* ----------------------------------------------------------------------- */

function FileRow({ file, staged }: { file: FileStatus; staged: boolean }) {
  const ws = useWorkspace();
  const openDiff = useEditor((s) => s.openDiff);
  const previewDiff = useEditor((s) => s.previewDiff);
  const openFile = useEditor((s) => s.openFile);
  const color = statusColor(file.status);
  const name = basename(file.path);
  const dir = dirname(file.path);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const onRowClick = () => {
    previewDiff({
      repoPath: ws.path,
      path: file.path,
      kind: staged ? "staged" : "worktree",
      status: file.status,
      origPath: file.origPath,
    });
  };

  const onOpenFile = () => {
    openFile(`${ws.path}/${file.path}`);
  };

  const onOpenDiff = () => {
    openDiff({
      repoPath: ws.path,
      path: file.path,
      kind: staged ? "staged" : "worktree",
      status: file.status,
      origPath: file.origPath,
    });
  };

  const onDiscard = async () => {
    const verb =
      file.status === "?"
        ? `Are you sure you want to DELETE ${name}?`
        : `Are you sure you want to discard changes in ${name}?`;
    const ok = await confirm(`${verb}\nThis is irreversible!`, {
      title: "Discard Changes",
      kind: "warning",
    });
    if (ok) await ws.repo.getState().discard(statusPaths(file));
  };

  return (
    <>
      <div
        className="sc-row sc-file-row"
        title={file.path}
        onClick={onRowClick}
        onDoubleClick={onOpenDiff}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span
          className={`sc-file-name truncate${file.status === "D" ? " deleted" : ""}`}
          style={{ color }}
        >
          {name}
        </span>
        <span className="sc-file-dir truncate">{dir}</span>
        <span className="sc-row-actions" onClick={(e) => e.stopPropagation()}>
          {file.status !== "D" && (
            <button className="icon-btn" title="Open File" onClick={onOpenFile}>
              <IcFile />
            </button>
          )}
          {!staged && (
            <button
              className="icon-btn"
              title="Discard Changes"
              onClick={() => void onDiscard()}
            >
              <IcDiscard />
            </button>
          )}
          {staged ? (
            <button
              className="icon-btn"
              title="Unstage Changes"
              onClick={() => void ws.repo.getState().unstage(statusPaths(file))}
            >
              <IcMinus />
            </button>
          ) : (
            <button
              className="icon-btn"
              title="Stage Changes"
              onClick={() => void ws.repo.getState().stage(statusPaths(file))}
            >
              <IcPlus />
            </button>
          )}
        </span>
        <span className="sc-file-letter" style={{ color }}>
          {statusLetter(file.status)}
        </span>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            disabled={file.status === "D"}
            title={
              file.status === "D"
                ? "Deleted file has no working-tree file"
                : undefined
            }
            onClick={() => {
              onOpenFile();
              setMenu(null);
            }}
          >
            Open File
          </button>
          <button
            onClick={() => {
              onOpenDiff();
              setMenu(null);
            }}
          >
            Open Changes
          </button>
          <div className="ctx-menu-sep" />
          {!staged && (
            <button
              onClick={() => {
                setMenu(null);
                void onDiscard();
              }}
            >
              Discard Changes…
            </button>
          )}
          <button
            onClick={() => {
              setMenu(null);
              const action = staged
                ? ws.repo.getState().unstage
                : ws.repo.getState().stage;
              void action(statusPaths(file));
            }}
          >
            {staged ? "Unstage Changes" : "Stage Changes"}
          </button>
        </ContextMenu>
      )}
    </>
  );
}

/* ----------------------------------------------------------------------- */
/* SourceControl                                                            */
/* ----------------------------------------------------------------------- */

const MAX_INPUT_HEIGHT = 6 * 18 + 12; // 6 lines * line-height + padding

function SourceControlChanges() {
  const ws = useWorkspace();
  const { status, stashes, syncing } = useRepo(
    useShallow((s) => ({
      status: s.status,
      stashes: s.stashes,
      syncing: s.syncing,
    })),
  );
  const {
    refresh,
    fetch: fetchRemote,
    pull,
    push,
  } = useRepo(
    useShallow((s) => ({
      refresh: s.refresh,
      fetch: s.fetch,
      pull: s.pull,
      push: s.push,
    })),
  );

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const branch = status?.branch.name ?? "";

  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [stashesOpen, setStashesOpen] = useState(false);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [stashInputOpen, setStashInputOpen] = useState(false);
  const [stashMsg, setStashMsg] = useState("");

  // commit-graph branch filter dropdown (refs fetched on open). Rendered as a
  // viewport-clamped fixed overlay: the Commits header sits at the bottom of
  // the panel inside an overflow:hidden container, so an absolute dropdown
  // would be clipped (and its backdrop would still eat clicks).
  const logFilter = useRepo((s) => s.logFilter);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterRefs, setFilterRefs] = useState<RefLabel[] | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const [filterPos, setFilterPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });

  const taRef = useRef<HTMLTextAreaElement>(null);
  const stashInputRef = useRef<HTMLInputElement>(null);

  // auto-grow the commit textarea between 1 and 6 lines
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [commitMsg]);

  useEffect(() => {
    if (stashInputOpen) stashInputRef.current?.focus();
  }, [stashInputOpen]);

  const doCommit = useCallback(
    async (amend: boolean, andPush: boolean) => {
      const msg = commitMsg.trim();
      // an empty message + amend keeps the prior commit message
      if ((!msg && !amend) || busy) return;
      const store = ws.repo.getState();
      if (!store.status) return;
      setBusy(true);
      try {
        if (!amend && store.status.staged.length === 0) {
          if (store.status.unstaged.length === 0) {
            await messageDialog("There are no changes to commit.", {
              title: "Source Control",
            });
            return;
          }
          const proceed = await confirm(
            "There are no staged changes to commit.\n\nWould you like to stage all your changes and commit them directly?",
            { title: "Source Control", kind: "warning" },
          );
          if (!proceed) return;
          if (!(await store.stage(store.status.unstaged.flatMap(statusPaths))))
            return;
        }
        const ok = await store.commit(msg, amend);
        if (!ok) return;
        setCommitMsg("");
        if (andPush) await ws.repo.getState().push();
      } finally {
        setBusy(false);
      }
    },
    [commitMsg, busy, ws],
  );

  const onGenerateMsg = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    try {
      setCommitMsg(await gitGenerateCommitMessage(ws.path));
      taRef.current?.focus();
    } catch (e) {
      await messageDialog(String(e), { title: "Generate Commit Message" });
    } finally {
      setGenerating(false);
    }
  }, [generating, ws]);

  const onCommitKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey && e.key === "Enter") {
      e.preventDefault();
      void doCommit(false, false);
    }
  };

  const onStageAll = () =>
    void ws.repo.getState().stage(unstaged.flatMap(statusPaths));
  const onUnstageAll = () =>
    void ws.repo.getState().unstage(staged.flatMap(statusPaths));

  const onDiscardAll = async () => {
    const n = unstaged.length;
    if (n === 0) return;
    const ok = await confirm(
      `Are you sure you want to discard ALL ${n} ${n === 1 ? "change" : "changes"}?\nThis is irreversible!`,
      { title: "Discard All Changes", kind: "warning" },
    );
    if (ok) await ws.repo.getState().discard(unstaged.flatMap(statusPaths));
  };

  const revealStashInput = () => {
    setStashesOpen(true);
    setStashInputOpen(true);
  };

  const onStashKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const msg = stashMsg.trim();
      setStashInputOpen(false);
      setStashMsg("");
      void ws.repo.getState().stashSave(msg || null, true);
    } else if (e.key === "Escape") {
      setStashInputOpen(false);
      setStashMsg("");
    }
  };

  const onStashDrop = async (oid: string, index: number) => {
    const ok = await confirm(
      `Are you sure you want to delete stash@{${index}}?`,
      { title: "Drop Stash", kind: "warning" },
    );
    if (ok) await ws.repo.getState().stashDrop(oid);
  };

  const openFilter = async () => {
    // seed a position from the button so the menu paints in roughly the right
    // spot before the layout-effect clamps it
    const r = filterBtnRef.current?.getBoundingClientRect();
    if (r) setFilterPos({ left: r.right - 230, top: r.bottom + 4 });
    setFilterQuery("");
    setFilterRefs(null);
    setFilterOpen(true);
    try {
      setFilterRefs(await gitListRefs(ws.path));
    } catch {
      setFilterRefs([]);
    }
  };

  // clamp the open dropdown into the viewport, flipping above the button when
  // there's no room below (re-runs as the ref list arrives and changes height)
  useLayoutEffect(() => {
    if (!filterOpen) return;
    const btn = filterBtnRef.current?.getBoundingClientRect();
    const menu = filterMenuRef.current?.getBoundingClientRect();
    if (!btn || !menu) return;
    const left = Math.max(4, Math.min(btn.right - menu.width, window.innerWidth - menu.width - 4));
    let top = btn.bottom + 4;
    if (top + menu.height > window.innerHeight - 4) {
      const above = btn.top - menu.height - 4;
      top = above >= 4 ? above : Math.max(4, window.innerHeight - menu.height - 4);
    }
    if (Math.abs(left - filterPos.left) > 0.5 || Math.abs(top - filterPos.top) > 0.5) {
      setFilterPos({ left, top });
    }
  }, [filterOpen, filterRefs, filterQuery, filterPos.left, filterPos.top]);

  const pickFilter = (refName: string | null) => {
    setFilterOpen(false);
    void ws.repo.getState().setLogFilter(refName);
  };

  const canCommit = commitMsg.trim().length > 0 && !busy;
  const noChanges = staged.length === 0 && unstaged.length === 0;

  return (
    <div className="source-control">
      {/* panel header */}
      <div className="sc-header">
        <span className="sc-header-title truncate">Source Control</span>
        <button
          className="icon-btn"
          title="Refresh"
          disabled={syncing}
          onClick={() => void refresh()}
        >
          <IcRefresh />
        </button>
        <button
          className="icon-btn"
          title="Fetch"
          disabled={syncing}
          onClick={() => void fetchRemote()}
        >
          <IcSync />
        </button>
        <button
          className="icon-btn"
          title="Pull"
          disabled={syncing}
          onClick={() => void pull()}
        >
          <IcPull />
        </button>
        <button
          className="icon-btn"
          title="Push"
          disabled={syncing}
          onClick={() => void push()}
        >
          <IcPush />
        </button>
      </div>

      {/* commit box */}
      <div className="sc-commit-box">
        <div className="sc-commit-input-wrap">
          <textarea
            ref={taRef}
            className="commit-input"
            rows={1}
            placeholder={`Message (Cmd+Enter to commit on "${branch}")`}
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={onCommitKeyDown}
            spellCheck={false}
          />
          <button
            className="icon-btn sc-generate-btn"
            title={
              staged.length === 0
                ? "Generate Commit Message (stage changes first)"
                : "Generate Commit Message from Staged Changes (Claude)"
            }
            disabled={generating || staged.length === 0}
            onClick={() => void onGenerateMsg()}
          >
            {generating ? <IcSpinner className="activity-busy" /> : <IcSparkle />}
          </button>
        </div>
        <div className="sc-commit-row">
          <button
            className="primary-btn sc-commit-btn"
            disabled={!canCommit}
            onClick={() => void doCommit(false, false)}
          >
            <IcCheck />
            Commit
          </button>
          <button
            className="sc-commit-caret"
            title="More Commit Actions…"
            disabled={busy}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IcChevronDown />
          </button>
          {menuOpen && (
            <>
              <div
                className="sc-menu-backdrop"
                onMouseDown={() => setMenuOpen(false)}
              />
              <div className="sc-menu">
                <button
                  disabled={!canCommit}
                  onClick={() => {
                    setMenuOpen(false);
                    void doCommit(false, false);
                  }}
                >
                  Commit
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    void doCommit(true, false);
                  }}
                >
                  Commit (Amend)
                </button>
                <button
                  disabled={!canCommit}
                  onClick={() => {
                    setMenuOpen(false);
                    void doCommit(false, true);
                  }}
                >
                  Commit &amp; Push
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* changes */}
      <div className="sc-changes">
        {noChanges ? (
          <div className="sc-empty">
            <IcCheck />
            <span>No changes</span>
          </div>
        ) : (
          <>
            {staged.length > 0 && (
              <Section
                title="Staged Changes"
                count={staged.length}
                open={stagedOpen}
                onToggle={() => setStagedOpen((v) => !v)}
                actions={
                  <button
                    className="icon-btn"
                    title="Unstage All Changes"
                    onClick={onUnstageAll}
                  >
                    <IcMinus />
                  </button>
                }
              >
                {staged.map((f) => (
                  <FileRow key={f.path} file={f} staged />
                ))}
              </Section>
            )}
            <Section
              title="Changes"
              count={unstaged.length}
              open={changesOpen}
              onToggle={() => setChangesOpen((v) => !v)}
              actions={
                <>
                  <button
                    className="icon-btn"
                    title="Stash Changes"
                    onClick={revealStashInput}
                  >
                    <IcBox />
                  </button>
                  <button
                    className="icon-btn"
                    title="Discard All Changes"
                    onClick={() => void onDiscardAll()}
                  >
                    <IcDiscard />
                  </button>
                  <button
                    className="icon-btn"
                    title="Stage All Changes"
                    onClick={onStageAll}
                  >
                    <IcPlus />
                  </button>
                </>
              }
            >
              {unstaged.map((f) => (
                <FileRow key={f.path} file={f} staged={false} />
              ))}
            </Section>
          </>
        )}
      </div>

      {/* stashes */}
      <div className="sc-stashes">
        <Section
          title="Stashes"
          count={stashes.length}
          open={stashesOpen}
          onToggle={() => setStashesOpen((v) => !v)}
          actions={
            <button
              className="icon-btn"
              title="Stash Changes"
              onClick={revealStashInput}
            >
              <IcPlus />
            </button>
          }
        >
          {stashInputOpen && (
            <div className="sc-stash-input-row">
              <input
                ref={stashInputRef}
                className="text-input"
                placeholder="Stash message (Enter)"
                value={stashMsg}
                onChange={(e) => setStashMsg(e.target.value)}
                onKeyDown={onStashKeyDown}
                onBlur={() => setStashInputOpen(false)}
              />
            </div>
          )}
          <div className="sc-stash-list">
            {stashes.map((st) => (
              <div
                key={st.oid}
                className="sc-row sc-stash-row"
                title={st.message}
              >
                <span className="sc-stash-icon">
                  <IcBox />
                </span>
                <span className="sc-stash-label truncate">
                  {`stash@{${st.index}}: ${st.message}`}
                </span>
                <span
                  className="sc-row-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="icon-btn"
                    title="Apply Stash"
                    onClick={() => void ws.repo.getState().stashApply(st.oid)}
                  >
                    <IcApply />
                  </button>
                  <button
                    className="icon-btn"
                    title="Pop Stash"
                    onClick={() => void ws.repo.getState().stashPop(st.oid)}
                  >
                    <IcPop />
                  </button>
                  <button
                    className="icon-btn"
                    title="Drop Stash"
                    onClick={() => void onStashDrop(st.oid, st.index)}
                  >
                    <IcTrash />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* commits graph */}
      <div className={`sc-commits ${commitsOpen ? "open" : ""}`}>
        <div
          className="sc-section-header"
          onClick={() => setCommitsOpen((v) => !v)}
        >
          <span className={`sc-chevron ${commitsOpen ? "open" : ""}`}>
            <IcChevronRight />
          </span>
          <span className="sc-section-title truncate">Commits</span>
          {logFilter && (
            <span
              className="sc-badge sc-filter-badge truncate"
              title={`Showing only ${logFilter}`}
            >
              {logFilter}
            </span>
          )}
          <span
            className={`sc-section-actions${logFilter ? " pinned" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              ref={filterBtnRef}
              className={`icon-btn${logFilter ? " active" : ""}`}
              title="Filter by Branch"
              onClick={() => (filterOpen ? setFilterOpen(false) : void openFilter())}
            >
              <IcFilter />
            </button>
          </span>
        </div>
        {filterOpen && (
          <>
            <div
              className="sc-menu-backdrop"
              onMouseDown={() => setFilterOpen(false)}
            />
            <div
              ref={filterMenuRef}
              className="sc-filter-menu"
              style={{ left: filterPos.left, top: filterPos.top }}
            >
              <input
                className="text-input"
                placeholder="Filter branches…"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setFilterOpen(false);
                }}
                autoFocus
                spellCheck={false}
              />
              <div className="sc-filter-list">
                <button
                  className={logFilter === null ? "checked" : ""}
                  onClick={() => pickFilter(null)}
                >
                  <IcBranch />
                  <span className="truncate">All Branches</span>
                </button>
                {filterRefs === null ? (
                  <div className="sc-filter-empty">loading…</div>
                ) : (
                  filterRefs
                    .filter((r) =>
                      r.name.toLowerCase().includes(filterQuery.toLowerCase()),
                    )
                    .map((r) => (
                      <button
                        key={`${r.kind}:${r.name}`}
                        className={logFilter === r.name ? "checked" : ""}
                        title={r.name}
                        onClick={() => pickFilter(r.name)}
                      >
                        {r.kind === "remote" ? <IcRemote /> : <IcBranch />}
                        <span className="truncate">{r.name}</span>
                      </button>
                    ))
                )}
              </div>
            </div>
          </>
        )}
        {commitsOpen && (
          <div className="sc-graph-wrap">
            <GitGraph />
          </div>
        )}
      </div>
    </div>
  );
}

type SourceControlView = "changes" | "worktrees";

/** Source Control owns Git changes and repository worktrees as sibling tabs.
 * Both panes stay mounted so draft commit messages, filters, and expanded task
 * cards survive tab switches. */
export default function SourceControl() {
  const [view, setView] = useState<SourceControlView>("changes");
  return (
    <div className="source-control-shell">
      <div className="sc-view-tabs" role="tablist" aria-label="Source Control views">
        <button
          className={view === "changes" ? "active" : ""}
          role="tab"
          aria-selected={view === "changes"}
          onClick={() => setView("changes")}
        >
          <IcBranch />
          Changes
        </button>
        <button
          className={view === "worktrees" ? "active" : ""}
          role="tab"
          aria-selected={view === "worktrees"}
          onClick={() => setView("worktrees")}
        >
          <IcTree />
          Worktrees
        </button>
      </div>
      <div
        className="sc-view-pane"
        role="tabpanel"
        style={{ display: view === "changes" ? undefined : "none" }}
      >
        <SourceControlChanges />
      </div>
      <div
        className="sc-view-pane"
        role="tabpanel"
        style={{ display: view === "worktrees" ? undefined : "none" }}
      >
        <Suspense fallback={<div className="sidebar-empty">Loading worktrees…</div>}>
          <IsolatedTasksPanel />
        </Suspense>
      </div>
    </div>
  );
}
