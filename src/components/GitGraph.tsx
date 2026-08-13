/**
 * Commit graph list: colored rail lanes + dots on the left, then ref pills,
 * commit summary, author and relative time. Virtualized by hand (no deps):
 * a flat item array (commit / file / loadmore rows) rendered as an absolutely
 * positioned visible slice inside one scroll container.
 *
 * Interactions: click expands a commit's files; ⌘-click / shift-click build a
 * multi-selection; right-click opens a context menu (checkout refs / detached,
 * create branch, cherry-pick selection, squash selection, rebase onto commit
 * or picked branch, reset soft/mixed/hard, copy SHA). Eligibility is
 * pre-checked here against the loaded window for menu enablement, but the
 * backend re-validates authoritatively (git_squash, git_rebase).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useRepo, useWorkspace } from "../stores/workspaces";
import {
  gitCommitFiles,
  gitListRefs,
  gitWorktreeList,
  type CommitFile,
  type GitWorktree,
  type RefLabel,
  type ResetMode,
} from "../lib/ipc";
import {
  assignedProjectColorIndex,
  paletteColor,
  useProjectColorsVersion,
  useProjectColorVar,
} from "../lib/projectColors";
import { copyText } from "../lib/clipboard";
import { statusColor } from "../lib/status";
import { computeGraph, type GraphRow } from "../lib/graphLayout";
import { ContextMenu } from "./ContextMenu";
import { IcBranch, IcRemote, IcTag } from "./icons";
import "./GitGraph.css";

const ROW = 24;
const OVERSCAN = 10;
const LANE_W = 12;
const LANE_X0 = 7;
const MAX_PILLS = 2;

function relTime(timestamp: number): string {
  const s = Math.floor(Date.now() / 1000) - timestamp;
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

// shared static pill icon elements (one element per kind, reused across rows)
const PILL_ICON: Record<RefLabel["kind"], ReactNode> = {
  local: <IcBranch />,
  remote: <IcRemote />,
  tag: <IcTag />,
};

// ---------------------------------------------------------------------------
// Create-branch popover (fixed-position overlay; menu = shared ContextMenu)
// ---------------------------------------------------------------------------

function BranchPopover({
  x,
  y,
  oid,
  onClose,
}: {
  x: number;
  y: number;
  oid: string;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [switchTo, setSwitchTo] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  // submit reads fresh name/switchTo via refs so the window-level key handler
  // never closes over stale state
  const stateRef = useRef({ name, switchTo });
  stateRef.current = { name, switchTo };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(() => {
    const { name: n, switchTo: s } = stateRef.current;
    if (!n.trim()) return;
    onClose();
    void ws.repo.getState().createBranch(n.trim(), oid, s);
  }, [onClose, oid, ws]);

  // Enter/Escape work even after focus leaves the input (e.g. after clicking
  // the checkbox), which a bare input onKeyDown would miss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submit]);

  return (
    <>
      <div className="ctx-menu-backdrop" onMouseDown={onClose} />
      <div
        className="gg-popover"
        style={{
          left: Math.max(4, Math.min(x, window.innerWidth - 248)),
          top: Math.max(4, Math.min(y, window.innerHeight - 96)),
        }}
      >
        <input
          ref={inputRef}
          className="text-input"
          placeholder={`New branch at ${oid.slice(0, 7)}…`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />
        {/* keep input focus when toggling the checkbox so Enter still submits */}
        <label
          className="gg-popover-row"
          onMouseDown={(e) => e.preventDefault()}
        >
          <input
            type="checkbox"
            checked={switchTo}
            onChange={(e) => setSwitchTo(e.target.checked)}
          />
          Switch to new branch
        </label>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rebase branch picker (fixed-position overlay, like BranchPopover)
// ---------------------------------------------------------------------------

function RebasePopover({
  x,
  y,
  branch,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  /** Current branch name (placeholder label + self-exclusion). */
  branch: string;
  onPick: (refName: string) => void;
  onClose: () => void;
}) {
  const repoPath = useRepo((s) => s.repoPath);
  const [refs, setRefs] = useState<RefLabel[] | null>(null); // null = loading
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    gitListRefs(repoPath).then(
      (r) => {
        if (alive) setRefs(r);
      },
      () => {
        if (alive) setRefs([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [repoPath]);

  const shown = (refs ?? []).filter(
    (r) =>
      // rebasing a branch onto itself is a guaranteed no-op
      !(r.kind === "local" && r.name === branch) &&
      r.name.toLowerCase().includes(query.toLowerCase()),
  );

  // Focus never leaves the input (clicking a row closes the popover), so a
  // bare input onKeyDown suffices — no window-level handler needed here.
  return (
    <>
      <div className="ctx-menu-backdrop" onMouseDown={onClose} />
      <div
        className="gg-popover"
        style={{
          left: Math.max(4, Math.min(x, window.innerWidth - 248)),
          top: Math.max(4, Math.min(y, window.innerHeight - 320)),
        }}
      >
        <input
          className="text-input"
          placeholder={`Rebase ${branch} onto…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter" && shown.length > 0) onPick(shown[0].name);
          }}
          autoFocus
          spellCheck={false}
        />
        <div className="gg-popover-list">
          {refs === null ? (
            <div className="gg-popover-empty">loading…</div>
          ) : shown.length === 0 ? (
            <div className="gg-popover-empty">no matching branches</div>
          ) : (
            shown.map((r) => (
              <button
                key={`${r.kind}:${r.name}`}
                title={r.name}
                onClick={() => onPick(r.name)}
              >
                {PILL_ICON[r.kind]}
                <span className="truncate">{r.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rail (the lane/dot SVG at the left of a commit row)
// ---------------------------------------------------------------------------

function Rail({ row }: { row: GraphRow }) {
  let maxLane = row.lane;
  for (const p of row.passLanes) if (p.lane > maxLane) maxLane = p.lane;
  for (const c of row.connectors) {
    if (c.fromLane > maxLane) maxLane = c.fromLane;
    if (c.toLane > maxLane) maxLane = c.toLane;
  }
  const width = (maxLane + 1) * LANE_W + 6;
  const x = (lane: number) => LANE_X0 + lane * LANE_W;
  const cx = x(row.lane);
  const color = row.color;

  const els: ReactNode[] = [];
  row.passLanes.forEach((p, i) => {
    const px = x(p.lane);
    els.push(
      <line
        key={`p${i}`}
        x1={px}
        y1={0}
        x2={px}
        y2={ROW}
        stroke={p.color}
        strokeWidth={2}
      />,
    );
  });
  row.connectors.forEach((c, i) => {
    const xf = x(c.fromLane);
    const xt = x(c.toLane);
    let d: string;
    if (c.kind === "merge-in") {
      // from the top edge curving into the dot
      d = `M ${xf} 0 C ${xf} 7, ${xt} 5, ${xt} 12`;
    } else if (c.kind === "branch-out") {
      // from the dot curving out to a lane at the bottom edge
      d = `M ${xf} 12 C ${xf} 19, ${xt} 17, ${xt} ${ROW}`;
    } else {
      // shift: gentle diagonal, top -> bottom
      d = `M ${xf} 0 C ${xf} 9, ${xt} 15, ${xt} ${ROW}`;
    }
    els.push(
      <path
        key={`c${i}`}
        d={d}
        fill="none"
        stroke={c.color}
        strokeWidth={2}
      />,
    );
  });
  if (row.linkUp) {
    els.push(
      <line key="u" x1={cx} y1={0} x2={cx} y2={12} stroke={color} strokeWidth={2} />,
    );
  }
  if (row.linkDown) {
    els.push(
      <line key="d" x1={cx} y1={12} x2={cx} y2={ROW} stroke={color} strokeWidth={2} />,
    );
  }
  if (row.commit.isHead) {
    els.push(
      <circle
        key="ring"
        cx={cx}
        cy={12}
        r={4.5}
        fill="var(--bg-sidebar)"
        stroke={color}
        strokeWidth={2}
      />,
      <circle key="dot" cx={cx} cy={12} r={2} fill={color} />,
    );
  } else {
    els.push(<circle key="dot" cx={cx} cy={12} r={3.5} fill={color} />);
  }

  return (
    <svg className="gg-rail" width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`}>
      {els}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ref pills
// ---------------------------------------------------------------------------

const KIND_ORDER: Record<RefLabel["kind"], number> = { local: 0, remote: 1, tag: 2 };

function RefPills({
  refs,
  isHead,
  branchColors,
}: {
  refs: RefLabel[];
  isHead: boolean;
  /** Local branch name -> project color, for branches checked out somewhere. */
  branchColors: Map<string, string>;
}) {
  if (refs.length === 0) return null;
  const sorted =
    refs.length > 1
      ? refs.slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
      : refs;
  const shown = sorted.slice(0, MAX_PILLS);
  const extra = sorted.length - shown.length;
  // the first local pill on the HEAD commit gets the filled style
  const headIdx = isHead ? shown.findIndex((r) => r.kind === "local") : -1;
  return (
    <>
      {shown.map((r, i) => {
        // Only local pills carry a checkout's project color; --pill-accent
        // falls back to --accent in CSS for every other pill.
        const tint = r.kind === "local" ? branchColors.get(r.name) : undefined;
        return (
        <span
          key={`${r.kind}:${r.name}`}
          className={`gg-pill ${i === headIdx ? "head" : r.kind}`}
          title={r.name}
          style={tint ? ({ "--pill-accent": tint } as CSSProperties) : undefined}
        >
          {PILL_ICON[r.kind]}
          <span className="truncate">{r.name}</span>
        </span>
        );
      })}
      {extra > 0 && <span className="gg-pill more">+{extra}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Rows (memoized: stable props -> zero re-renders while scrolling)
// ---------------------------------------------------------------------------

const CommitRow = memo(function CommitRow({
  row,
  top,
  expanded,
  selected,
  branchColors,
  onSelect,
  onContext,
}: {
  row: GraphRow;
  top: number;
  expanded: boolean;
  selected: boolean;
  branchColors: Map<string, string>;
  /** Plain click toggles file expansion; ⌘/shift clicks build the selection. */
  onSelect: (oid: string, e: ReactMouseEvent) => void;
  onContext: (oid: string, e: ReactMouseEvent) => void;
}) {
  const c = row.commit;
  const title = `${c.oid}\n${c.author} <${c.email}>\n${new Date(
    c.timestamp * 1000,
  ).toISOString()}`;
  return (
    <div
      className={`gg-row${expanded ? " expanded" : ""}${selected ? " selected" : ""}`}
      style={{ top }}
      title={title}
      onClick={(e) => onSelect(c.oid, e)}
      onContextMenu={(e) => onContext(c.oid, e)}
    >
      <Rail row={row} />
      <RefPills refs={c.refs} isHead={c.isHead} branchColors={branchColors} />
      <span className="gg-summary truncate">{c.summary}</span>
      <span className="gg-author truncate">{c.author}</span>
      <span className="gg-time">{relTime(c.timestamp)}</span>
    </div>
  );
});

const FileRow = memo(function FileRow({
  file,
  oid,
  top,
  repoPath,
}: {
  /** null while the commit's file list is being fetched. */
  file: CommitFile | null;
  oid: string;
  top: number;
  repoPath: string;
}) {
  const ws = useWorkspace();
  if (!file) {
    return (
      <div className="gg-file loading" style={{ top }}>
        loading…
      </div>
    );
  }
  const open = () =>
    ws.editor.getState().openDiff({
      repoPath,
      path: file.path,
      kind: "commit",
      oid,
      status: file.status,
      origPath: file.origPath,
    });
  return (
    <div className="gg-file" style={{ top }} title={file.path} onClick={open}>
      <span className="gg-file-status" style={{ color: statusColor(file.status) }}>
        {file.status}
      </span>
      <span className="gg-file-path truncate">
        {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
      </span>
    </div>
  );
});

const LoadMoreRow = memo(function LoadMoreRow({
  top,
  onClick,
}: {
  top: number;
  onClick: () => void;
}) {
  return (
    <div className="gg-loadmore" style={{ top }} onClick={onClick}>
      Load more commits
    </div>
  );
});

// ---------------------------------------------------------------------------
// GitGraph
// ---------------------------------------------------------------------------

type Item =
  | { type: "commit"; row: GraphRow }
  | { type: "file"; oid: string; file: CommitFile | null }
  | { type: "error"; oid: string }
  | { type: "loadmore" };

export default function GitGraph() {
  const ws = useWorkspace();
  const repoPath = useRepo((s) => s.repoPath);
  const commits = useRepo((s) => s.commits);
  const hasMoreLog = useRepo((s) => s.hasMoreLog);
  const loadMoreLog = useRepo((s) => s.loadMoreLog);
  const branchName = useRepo((s) => s.status?.branch.name);
  const detached = useRepo((s) => s.status?.branch.detached ?? false);

  // Linked checkouts of THIS repository, so a branch someone else is sitting
  // in shows up in that checkout's project color. Refetched with the log (the
  // repo store only reloads it on git-affecting changes) under a seq guard.
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  useEffect(() => {
    if (!repoPath) {
      setWorktrees([]);
      return;
    }
    let live = true;
    void gitWorktreeList(repoPath)
      .then((list) => {
        if (live) setWorktrees(list);
      })
      // A worktree-list failure only costs the extra coloring.
      .catch(() => {
        if (live) setWorktrees([]);
      });
    return () => {
      live = false;
    };
  }, [repoPath, commits]);

  const colorsVersion = useProjectColorsVersion();
  const activeColor = useProjectColorVar(ws.path);
  // Branch name -> project color: every linked checkout that already HAS a
  // color, then this workspace's own branch (the active project always wins
  // over whatever its own worktree entry says).
  const branchColors = useMemo(() => {
    void colorsVersion;
    const m = new Map<string, string>();
    for (const wt of worktrees) {
      if (!wt.branch) continue;
      const index = assignedProjectColorIndex(wt.path);
      if (index !== undefined) m.set(wt.branch, paletteColor(index));
    }
    if (branchName && !detached) m.set(branchName, activeColor);
    return m;
  }, [worktrees, branchName, detached, activeColor, colorsVersion]);

  // The same colors keyed by the commit each checkout sits on, for the rail:
  // a lane takes its color where it OPENS, so this only lands on branch tips.
  const layout = useMemo(() => {
    const tips = new Map<string, string>();
    for (const wt of worktrees) {
      if (!wt.head || !wt.branch) continue;
      const color = branchColors.get(wt.branch);
      if (color) tips.set(wt.head, color);
    }
    const head = commits.find((c) => c.isHead);
    if (head) tips.set(head.oid, activeColor);
    return computeGraph(commits, (oid, index) =>
      tips.get(oid) ?? `var(--graph-${index})`,
    );
  }, [commits, worktrees, branchColors, activeColor]);
  const byOid = useMemo(
    () => new Map(commits.map((c) => [c.oid, c])),
    [commits],
  );
  const orderIndex = useMemo(() => {
    const m = new Map<string, number>();
    commits.forEach((c, i) => m.set(c.oid, i));
    return m;
  }, [commits]);
  // HEAD's first-parent chain within the loaded window (oid -> depth). Topo
  // sorting puts parents after children, so within the window the chain is
  // gap-free; empty when HEAD itself isn't loaded (e.g. filtered log).
  const headChain = useMemo(() => {
    const m = new Map<string, number>();
    let cur = commits.find((c) => c.isHead);
    let depth = 0;
    while (cur && !m.has(cur.oid)) {
      m.set(cur.oid, depth++);
      cur = cur.parents.length > 0 ? byOid.get(cur.parents[0]) : undefined;
    }
    return m;
  }, [commits, byOid]);

  // single expanded commit + per-oid file cache ("error" = fetch failed)
  const [expandedOid, setExpandedOid] = useState<string | null>(null);
  const [fileCache, setFileCache] = useState<Map<string, CommitFile[] | "error">>(
    () => new Map(),
  );
  const inflight = useRef<Set<string>>(new Set());

  // multi-selection (⌘/shift clicks) + context menu / create-branch popover
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; oid: string } | null>(
    null,
  );
  const [branchPopover, setBranchPopover] = useState<{
    x: number;
    y: number;
    oid: string;
  } | null>(null);
  // carries no oid: it rebases the CURRENT branch, so (unlike branchPopover)
  // it is not pruned when commits leave the loaded log window
  const [rebasePopover, setRebasePopover] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // virtualization state
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);

  // reset view state when switching repositories
  useEffect(() => {
    setExpandedOid(null);
    setFileCache(new Map());
    inflight.current.clear();
    setScrollTop(0);
    setSelected(new Set());
    anchorRef.current = null;
    setMenu(null);
    setBranchPopover(null);
    setRebasePopover(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [repoPath]);

  // drop selection/menu entries whose commits left the log (refresh, squash)
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const oid of prev) {
        if (byOid.has(oid)) next.add(oid);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (anchorRef.current && !byOid.has(anchorRef.current)) {
      anchorRef.current = null;
    }
    setMenu((prev) => (prev && !byOid.has(prev.oid) ? null : prev));
    setBranchPopover((prev) => (prev && !byOid.has(prev.oid) ? null : prev));
  }, [byOid]);

  // fetch the expanded commit's files once, cache forever (per oid)
  useEffect(() => {
    if (!expandedOid || !repoPath) return;
    if (fileCache.has(expandedOid) || inflight.current.has(expandedOid)) return;
    inflight.current.add(expandedOid);
    gitCommitFiles(repoPath, expandedOid)
      .then((files) => {
        setFileCache((prev) => new Map(prev).set(expandedOid, files));
      })
      .catch(() => {
        setFileCache((prev) => new Map(prev).set(expandedOid, "error"));
      })
      .finally(() => {
        inflight.current.delete(expandedOid);
      });
  }, [expandedOid, repoPath, fileCache]);

  // observe viewport height (re-attach when leaving the empty state, since
  // the scroll element does not exist while "No commits yet" is shown)
  const empty = commits.length === 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    // quantize to row boundaries so scrolling within a row skips the
    // re-render entirely (overscan absorbs the sub-row error)
    const q = Math.floor(e.currentTarget.scrollTop / ROW) * ROW;
    setScrollTop((prev) => (prev === q ? prev : q));
  }, []);

  const toggleExpand = useCallback((oid: string) => {
    // drop a cached fetch failure so re-expanding retries
    setFileCache((prev) => {
      if (prev.get(oid) !== "error") return prev;
      const next = new Map(prev);
      next.delete(oid);
      return next;
    });
    setExpandedOid((prev) => (prev === oid ? null : oid));
  }, []);

  // plain click: expand files (clears selection); ⌘: toggle; shift: range
  const handleSelectClick = useCallback(
    (oid: string, e: ReactMouseEvent) => {
      if (e.shiftKey) {
        const a = anchorRef.current
          ? orderIndex.get(anchorRef.current)
          : undefined;
        const b = orderIndex.get(oid);
        if (a !== undefined && b !== undefined) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          setSelected(new Set(commits.slice(lo, hi + 1).map((c) => c.oid)));
        } else {
          anchorRef.current = oid;
          setSelected(new Set([oid]));
        }
        return;
      }
      if (e.metaKey) {
        anchorRef.current = oid;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(oid)) next.delete(oid);
          else next.add(oid);
          return next;
        });
        return;
      }
      anchorRef.current = oid;
      setSelected((prev) => (prev.size > 0 ? new Set<string>() : prev));
      toggleExpand(oid);
    },
    [commits, orderIndex, toggleExpand],
  );

  // right-click joins the existing selection or starts a fresh one
  const handleContext = useCallback((oid: string, e: ReactMouseEvent) => {
    e.preventDefault();
    anchorRef.current = oid;
    setSelected((prev) => (prev.has(oid) ? prev : new Set([oid])));
    setBranchPopover(null);
    setRebasePopover(null);
    setMenu({ x: e.clientX, y: e.clientY, oid });
  }, []);

  /**
   * Local pre-check mirroring git_squash's rules against the loaded window:
   * single-parent commits forming a contiguous run on HEAD's first-parent
   * chain. Returns a disabled-reason or null (= allowed / unknown, in which
   * case the backend's authoritative validation decides).
   */
  const squashCheck = (oids: string[]): string | null => {
    for (const oid of oids) {
      const c = byOid.get(oid);
      if (!c) continue; // beyond the loaded window — backend validates
      if (c.parents.length > 1) return "merge commits cannot be squashed";
      if (c.parents.length === 0) return "the root commit cannot be squashed";
    }
    if (headChain.size === 0) return null; // HEAD not loaded (filtered log)
    const pos: number[] = [];
    for (const oid of oids) {
      const p = headChain.get(oid);
      if (p === undefined) {
        // a loaded commit off the chain is ineligible; an unloaded one (the
        // parent extension one past the window) is left to the backend
        if (byOid.has(oid)) return "commits must be on the current branch";
        continue;
      }
      pos.push(p);
    }
    pos.sort((x, y) => x - y);
    for (let i = 1; i < pos.length; i++) {
      if (pos[i] !== pos[i - 1] + 1) return "selection must be contiguous";
    }
    return null;
  };

  const runSquash = async (oids: string[]) => {
    setMenu(null);
    const ok = await confirm(
      `Squash ${oids.length} commits into one?\nThis rewrites the current branch's history.`,
      { title: "Squash Commits", kind: "warning" },
    );
    if (!ok) return;
    if (await ws.repo.getState().squash(oids)) {
      setSelected(new Set());
      anchorRef.current = null;
    }
  };

  /** `onto` is an oid or branch name; `label` is what the confirm shows. */
  const runRebase = async (onto: string, label: string) => {
    setMenu(null);
    const ok = await confirm(
      `Rebase ${branchName} onto ${label}?\nThis rewrites the current branch's history.`,
      { title: "Rebase", kind: "warning" },
    );
    if (!ok) return;
    // the rebase rewrote (replaced) any selected oids — drop the selection
    if (await ws.repo.getState().rebase(onto)) {
      setSelected(new Set());
      anchorRef.current = null;
    }
  };

  const runReset = async (oid: string, mode: ResetMode) => {
    setMenu(null);
    if (mode === "hard") {
      const ok = await confirm(
        `Hard reset ${detached ? "HEAD" : branchName} to ${oid.slice(0, 7)}?\nAll uncommitted changes will be LOST!`,
        { title: "Reset (Hard)", kind: "warning" },
      );
      if (!ok) return;
    }
    // no selection clearing: the prune effect drops commits that left the log
    await ws.repo.getState().reset(oid, mode);
  };

  /** `oids` arrives in display order (newest-first); git applies oldest-first. */
  const runCherryPick = async (oids: string[]) => {
    setMenu(null);
    if (await ws.repo.getState().cherryPick([...oids].reverse())) {
      setSelected(new Set());
      anchorRef.current = null;
    }
  };

  const handleLoadMore = useCallback(() => {
    void loadMoreLog();
  }, [loadMoreLog]);

  // flat item list: commit rows, file rows under the expanded commit, tail
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const row of layout) {
      out.push({ type: "commit", row });
      if (expandedOid === row.commit.oid) {
        const files = fileCache.get(expandedOid);
        if (files === undefined) {
          out.push({ type: "file", oid: expandedOid, file: null });
        } else if (files === "error") {
          out.push({ type: "error", oid: expandedOid });
        } else {
          for (const f of files) out.push({ type: "file", oid: expandedOid, file: f });
        }
      }
    }
    if (hasMoreLog) out.push({ type: "loadmore" });
    return out;
  }, [layout, expandedOid, fileCache, hasMoreLog]);

  if (empty) {
    return (
      <div className="git-graph accent-scope">
        <div className="gg-empty">No commits yet</div>
      </div>
    );
  }

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW) + OVERSCAN);
  const visible: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const it = items[i];
    const top = i * ROW;
    if (it.type === "commit") {
      visible.push(
        <CommitRow
          key={it.row.commit.oid}
          row={it.row}
          top={top}
          expanded={it.row.commit.oid === expandedOid}
          selected={selected.has(it.row.commit.oid)}
          branchColors={branchColors}
          onSelect={handleSelectClick}
          onContext={handleContext}
        />,
      );
    } else if (it.type === "file") {
      visible.push(
        <FileRow
          key={it.file ? `${it.oid}:${it.file.path}` : `${it.oid}:loading`}
          file={it.file}
          oid={it.oid}
          top={top}
          repoPath={repoPath ?? ""}
        />,
      );
    } else if (it.type === "error") {
      visible.push(
        <div
          key={`${it.oid}:error`}
          className="gg-file loading"
          style={{ top, color: "var(--danger)" }}
        >
          Failed to load files
        </div>,
      );
    } else {
      visible.push(<LoadMoreRow key="loadmore" top={top} onClick={handleLoadMore} />);
    }
  }

  // ---- context menu items (rebuilt per open; cheap) ----
  const renderMenuItems = (m: { x: number; y: number; oid: string }) => {
    const c = byOid.get(m.oid);
    if (!c) return null;
    const close = () => setMenu(null);
    const repo = () => ws.repo.getState();
    // selection in display order (newest -> oldest); only acts on the
    // multi-selection when the clicked commit is part of it
    const sel = commits.filter((k) => selected.has(k.oid)).map((k) => k.oid);
    const target = sel.includes(c.oid) ? sel : [c.oid];

    const items: ReactNode[] = [];
    for (const r of c.refs) {
      // the checked-out branch needs no checkout entry
      if (r.kind === "local" && !detached && r.name === branchName) continue;
      items.push(
        <button
          key={`co:${r.kind}:${r.name}`}
          onClick={() => {
            close();
            void repo().checkout(r.name, r.kind);
          }}
        >
          <span className="truncate">Checkout {r.name}</span>
        </button>,
      );
    }
    if (!(c.isHead && detached)) {
      items.push(
        <button
          key="detach"
          onClick={() => {
            close();
            void repo().checkout(c.oid, "commit");
          }}
        >
          Checkout Commit (Detached)
        </button>,
      );
    }
    items.push(
      <button
        key="newbranch"
        onClick={() => {
          setBranchPopover({ x: m.x, y: m.y, oid: c.oid });
          close();
        }}
      >
        Create Branch Here…
      </button>,
      <div key="s1" className="ctx-menu-sep" />,
    );
    {
      // every target oid is loaded (the prune effect guarantees it), so the
      // merge-commit pre-check is reliable; content conflicts surface from
      // the CLI through the abort-and-report path
      const hasMerge = target.some(
        (o) => (byOid.get(o)?.parents.length ?? 0) > 1,
      );
      const onlyHead = target.length === 1 && c.isHead;
      const reason = hasMerge
        ? "merge commits cannot be cherry-picked"
        : onlyHead
          ? "this commit is already the current HEAD"
          : null;
      items.push(
        <button
          key="cherry"
          disabled={reason !== null}
          title={reason ?? undefined}
          onClick={() => void runCherryPick(target)}
        >
          {target.length >= 2
            ? `Cherry-Pick ${target.length} Commits`
            : "Cherry-Pick Commit"}
        </button>,
        <div key="s-cherry" className="ctx-menu-sep" />,
      );
    }
    if (target.length >= 2) {
      const reason = squashCheck(target);
      items.push(
        <button
          key="squash"
          disabled={reason !== null}
          title={reason ?? undefined}
          onClick={() => void runSquash(target)}
        >
          Squash {target.length} Commits…
        </button>,
      );
    }
    {
      // selection (or the single commit) + its parent, melded into one
      const oldest = byOid.get(target[target.length - 1]);
      const ext =
        oldest && oldest.parents.length === 1
          ? [...target, oldest.parents[0]]
          : null;
      const reason =
        ext === null
          ? "no parent in the loaded history"
          : squashCheck(ext);
      items.push(
        <button
          key="squash-parent"
          disabled={reason !== null}
          title={reason ?? undefined}
          onClick={() => {
            if (ext) void runSquash(ext);
          }}
        >
          Squash into Parent…
        </button>,
      );
    }
    {
      // when detached, branchName is the short oid — use the generic label.
      // headChain membership = guaranteed "already up to date" no-op; side
      // ancestors merged in fall through to git's harmless success.
      const reason = detached
        ? "check out a branch first"
        : headChain.has(c.oid)
          ? "the current branch is already based on this commit"
          : null;
      items.push(
        <button
          key="rebase-here"
          disabled={reason !== null}
          title={reason ?? undefined}
          onClick={() => void runRebase(c.oid, c.oid.slice(0, 7))}
        >
          <span className="truncate">
            {detached
              ? "Rebase onto this Commit…"
              : `Rebase ${branchName} onto this Commit…`}
          </span>
        </button>,
        <button
          key="rebase-pick"
          disabled={detached}
          title={detached ? "check out a branch first" : undefined}
          onClick={() => {
            setRebasePopover({ x: m.x, y: m.y });
            close();
          }}
        >
          <span className="truncate">
            {detached
              ? "Rebase onto a Branch…"
              : `Rebase ${branchName} onto a Branch…`}
          </span>
        </button>,
        <div key="s-reset" className="ctx-menu-sep" />,
        // reset always targets the CLICKED commit, never the selection;
        // hard is the only destructive one and gets a confirm in runReset
        <button key="reset-soft" onClick={() => void runReset(c.oid, "soft")}>
          Reset Here (Soft)
        </button>,
        <button key="reset-mixed" onClick={() => void runReset(c.oid, "mixed")}>
          Reset Here (Mixed)
        </button>,
        <button key="reset-hard" onClick={() => void runReset(c.oid, "hard")}>
          Reset Here (Hard)…
        </button>,
      );
    }
    items.push(
      <div key="s2" className="ctx-menu-sep" />,
      <button
        key="copy"
        onClick={() => {
          close();
          void copyText(c.oid);
        }}
      >
        Copy SHA
      </button>,
    );
    return items;
  };

  return (
    <div className="git-graph accent-scope">
      <div className="gg-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="gg-spacer" style={{ height: items.length * ROW }}>
          {visible}
        </div>
      </div>
      {menu && byOid.has(menu.oid) && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {renderMenuItems(menu)}
        </ContextMenu>
      )}
      {branchPopover && (
        <BranchPopover
          x={branchPopover.x}
          y={branchPopover.y}
          oid={branchPopover.oid}
          onClose={() => setBranchPopover(null)}
        />
      )}
      {rebasePopover && (
        <RebasePopover
          x={rebasePopover.x}
          y={rebasePopover.y}
          branch={branchName ?? ""}
          onPick={(refName) => {
            setRebasePopover(null);
            void runRebase(refName, refName);
          }}
          onClose={() => setRebasePopover(null)}
        />
      )}
    </div>
  );
}
