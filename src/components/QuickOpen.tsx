/**
 * ⌘P quick open: fuzzy file-name picker over the active workspace's files
 * (gitignore-respected listing from the backend, fetched fresh per open).
 * Modeled on TaskPicker: top-centered overlay that owns the keyboard while
 * open; selection follows both keyboard and mouse.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listWorkspaceFiles } from "../lib/ipc";
import { fuzzyMatch } from "../lib/fuzzy";
import { useNativeOverlay } from "../lib/nativeOverlays";
import { basename } from "../lib/path";
import type { Workspace } from "../stores/workspaces";
import "./QuickOpen.css";

/** Rows actually rendered; scores beyond this never make the screen. */
const MAX_SHOWN = 100;

interface FileEntry {
  path: string;
  /** Pre-lowercased once per load — the fuzzy scan runs per keystroke. */
  lower: string;
}

interface ShownEntry {
  path: string;
  /** Matched char indices into `path` (empty when the filter is empty). */
  positions: number[];
}

const NO_POSITIONS: number[] = [];

/** Render `text` with the matched positions (already segment-relative)
    wrapped in .qo-match spans; consecutive runs coalesce into one span. */
function highlighted(text: string, positions: number[]): ReactNode {
  if (positions.length === 0) return text;
  const out: ReactNode[] = [];
  let prev = 0;
  for (let i = 0; i < positions.length; ) {
    const start = positions[i];
    let end = start + 1;
    for (i++; i < positions.length && positions[i] === end; i++) end++;
    if (start > prev) out.push(text.slice(prev, start));
    out.push(
      <span key={start} className="qo-match">
        {text.slice(start, end)}
      </span>,
    );
    prev = end;
  }
  if (prev < text.length) out.push(text.slice(prev));
  return out;
}

export default function QuickOpen({
  ws,
  onClose,
}: {
  ws: Workspace;
  onClose: () => void;
}) {
  useNativeOverlay();
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<FileEntry[] | null>(null); // null = loading
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    let disposed = false;
    listWorkspaceFiles(ws.path)
      .then((r) => {
        if (disposed) return;
        setFiles(r.files.map((path) => ({ path, lower: path.toLowerCase() })));
        setTruncated(r.truncated);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [ws.path]);

  const shown = useMemo<ShownEntry[]>(() => {
    if (!files) return [];
    const q = filter.trim().toLowerCase();
    if (!q) {
      return files
        .slice(0, MAX_SHOWN)
        .map((f) => ({ path: f.path, positions: NO_POSITIONS }));
    }
    const scored: (ShownEntry & { score: number })[] = [];
    for (const f of files) {
      const m = fuzzyMatch(q, f.path, f.lower);
      if (m) scored.push({ path: f.path, positions: m.positions, score: m.score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : 1),
    );
    return scored.slice(0, MAX_SHOWN);
  }, [files, filter]);
  const sel = Math.max(0, Math.min(index, shown.length - 1));

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = (rel: string) => {
    // Backend paths are repo-relative; the editor wants absolute (the tab id
    // then matches FileExplorer's, so the same file never opens twice).
    ws.editor.getState().openFile(`${ws.path}/${rel}`);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The picker owns the keyboard while open (same rule as TaskPicker):
    // ⌘W/⌘1-9/⌘P must not reach the window-level shortcuts underneath.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(sel + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[sel]) open(shown[sel].path);
    }
  };

  return (
    <div className="quick-open-backdrop" onMouseDown={onClose}>
      <div
        className="quick-open"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="text-input"
          placeholder="Go to file…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setIndex(0);
          }}
        />
        <div className="quick-open-list" ref={listRef}>
          {shown.map((f, i) => {
            // Split the match positions at the basename boundary so each
            // display segment highlights its own characters.
            const base = basename(f.path);
            const baseStart = f.path.length - base.length;
            const dir = baseStart > 0 ? f.path.slice(0, baseStart - 1) : "";
            const basePositions: number[] = [];
            const dirPositions: number[] = [];
            for (const p of f.positions) {
              if (p >= baseStart) basePositions.push(p - baseStart);
              else if (p < dir.length) dirPositions.push(p);
            }
            return (
              <button
                key={f.path}
                className={`quick-open-item ${i === sel ? "selected" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => open(f.path)}
              >
                <span className="qo-base truncate">
                  {highlighted(base, basePositions)}
                </span>
                {dir && (
                  <span className="qo-dir truncate">
                    {highlighted(dir, dirPositions)}
                  </span>
                )}
              </button>
            );
          })}
          {shown.length === 0 && (
            <div className="quick-open-empty">
              {error ?? (files === null ? "Loading…" : "No matching files")}
            </div>
          )}
        </div>
        {truncated && (
          <div className="quick-open-note">
            File list truncated — refine your search
          </div>
        )}
      </div>
    </div>
  );
}
