import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  fsCopy,
  fsCreateDir,
  fsCreateFile,
  fsReadDir,
  fsRename,
  fsReveal,
  fsTrash,
  onRepoChanged,
  type DirEntry,
} from "../lib/ipc";
import { copyText } from "../lib/clipboard";
import { basename, dirname } from "../lib/path";
import { useEditor, useRepo, useWorkspace } from "../stores/workspaces";
import { ContextMenu } from "./ContextMenu";
import {
  IcChevronRight,
  IcCollapseAll,
  IcFile,
  IcFolder,
  IcRefresh,
} from "./icons";
import "./FileExplorer.css";

type DirCache = Map<string, DirEntry[] | "error">;

const DRAG_THRESHOLD_PX = 4;

interface Row {
  key: string;
  kind: "entry" | "empty" | "error" | "create";
  entry: DirEntry | null;
  depth: number;
}

const validateName = (name: string): string | null => {
  if (!name || name === "." || name === "..") return "Invalid name.";
  if (name.includes("/")) return "Names cannot contain “/”.";
  return null;
};

/** Inline name editor for the rename / new-file / new-folder rows. Commits on
    Enter or blur, cancels on Escape (commit fires exactly once — Enter also
    blurs). `null` = cancelled. */
function NameInput({
  defaultValue,
  onCommit,
}: {
  defaultValue: string;
  onCommit: (value: string | null) => void;
}) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  return (
    <input
      className="fx-name-input"
      defaultValue={defaultValue}
      autoFocus
      spellCheck={false}
      onFocus={(e) => {
        // preselect the stem only, VS Code-style (keep the extension)
        const dot = defaultValue.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : defaultValue.length);
      }}
      // keep edits inside the input: no row toggle, no tree keyboard nav
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export default function FileExplorer() {
  const ws = useWorkspace();
  const repoPath = useRepo((s) => s.repoPath);
  const repoName = useRepo((s) => s.repoName);
  const openFile = useEditor((s) => s.openFile);
  const previewFile = useEditor((s) => s.previewFile);
  const activeTabId = useEditor((s) => s.activeTabId);

  const [cache, setCache] = useState<DirCache>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [rootExpanded, setRootExpanded] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    /** null = root / blank-area menu */
    entry: DirEntry | null;
  } | null>(null);
  // explorer-internal cut/copy clipboard (not the OS pasteboard)
  const [clipboard, setClipboard] = useState<{
    entries: DirEntry[];
    cut: boolean;
  } | null>(null);
  const [editing, setEditing] = useState<
    | { kind: "rename"; entry: DirEntry }
    | { kind: "create"; dir: string; isDir: boolean }
    | null
  >(null);

  const treeRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const repoPathRef = useRef(repoPath);
  const expandedRef = useRef(expanded);
  const cacheRef = useRef(cache);
  const selectedRef = useRef(selected);
  const selectionAnchorRef = useRef<string | null>(null);
  const dragPathsRef = useRef<string[]>([]);
  const dropTargetRef = useRef<string | null>(null);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  repoPathRef.current = repoPath;
  expandedRef.current = expanded;
  cacheRef.current = cache;
  selectedRef.current = selected;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dragCleanupRef.current?.();
    };
  }, []);

  const loadDir = useCallback((path: string) => {
    fsReadDir(path).then(
      (entries) => {
        if (!mountedRef.current) return;
        setCache((c) => new Map(c).set(path, entries));
      },
      () => {
        if (!mountedRef.current) return;
        setCache((c) => new Map(c).set(path, "error"));
      },
    );
  }, []);

  /**
   * Re-reads root + every expanded dir. Collapsed dirs are pruned from the
   * cache, but dirs loaded concurrently (expanded mid-refetch) are kept.
   */
  const refetchExpanded = useCallback(async () => {
    const root = repoPathRef.current;
    if (!root) return;
    const dirs = [root, ...expandedRef.current];
    const results = await Promise.all(
      dirs.map(async (d): Promise<[string, DirEntry[] | "error"]> => {
        try {
          return [d, await fsReadDir(d)];
        } catch {
          return [d, "error"];
        }
      }),
    );
    if (!mountedRef.current) return;
    setCache((c) => {
      const next = new Map(results);
      for (const k of expandedRef.current) {
        if (!next.has(k) && c.has(k)) next.set(k, c.get(k)!);
      }
      return next;
    });
  }, []);

  // load the repo root whenever the repo changes
  useEffect(() => {
    setCache(new Map());
    setExpanded(new Set());
    setRootExpanded(true);
    setSelected(new Set());
    setFocused(null);
    setDragging(new Set());
    setDropTarget(null);
    setDragGhost(null);
    selectionAnchorRef.current = null;
    dragPathsRef.current = [];
    dropTargetRef.current = null;
    dragCleanupRef.current?.();
    setMenu(null);
    setClipboard(null);
    setEditing(null);
    if (!repoPath) return;
    let cancelled = false;
    fsReadDir(repoPath).then(
      (entries) => {
        if (!cancelled) setCache(new Map([[repoPath, entries]]));
      },
      () => {
        if (!cancelled) setCache(new Map([[repoPath, "error"]]));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  // silently refresh expanded dirs when the repo workdir changes (debounced)
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void onRepoChanged((change) => {
      // events arrive for every open workspace — only ours matter
      if (change.repoPath !== repoPathRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetchExpanded(), 300);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [refetchExpanded]);

  // highlight the file backing the active editor tab
  const activeFilePath =
    activeTabId && activeTabId.startsWith("file:")
      ? activeTabId.slice("file:".length)
      : null;
  useEffect(() => {
    if (!activeFilePath || !repoPath || !activeFilePath.startsWith(`${repoPath}/`)) return;
    const next = new Set([activeFilePath]);
    selectedRef.current = next;
    setSelected(next);
    setFocused(activeFilePath);
    selectionAnchorRef.current = activeFilePath;

    // Auto-reveal: expand and load every ancestor, then scroll the row into
    // view. Loading them together keeps deeply nested files snappy.
    const dirs: string[] = [];
    for (let dir = dirname(activeFilePath); dir !== repoPath && dir.startsWith(`${repoPath}/`); dir = dirname(dir)) {
      dirs.push(dir);
    }
    const expandedNext = new Set(expandedRef.current);
    for (const dir of dirs) expandedNext.add(dir);
    expandedRef.current = expandedNext;
    setExpanded(expandedNext);
    setRootExpanded(true);
    let disposed = false;
    void Promise.all(
      dirs
        .filter((dir) => !cacheRef.current.has(dir))
        .map(async (dir): Promise<[string, DirEntry[] | "error"]> => {
          try {
            return [dir, await fsReadDir(dir)];
          } catch {
            return [dir, "error"];
          }
        }),
    ).then((loaded) => {
      if (disposed) return;
      if (loaded.length) setCache((current) => new Map([...current, ...loaded]));
      requestAnimationFrame(() => scrollRowIntoView(activeFilePath));
    });
    return () => {
      disposed = true;
    };
  }, [activeFilePath, repoPath]);

  const toggleDir = useCallback(
    (path: string) => {
      const isOpen = expandedRef.current.has(path);
      const next = new Set(expandedRef.current);
      if (isOpen) next.delete(path);
      else next.add(path);
      setExpanded(next);
      if (!isOpen && !cacheRef.current.has(path)) loadDir(path);
    },
    [loadDir],
  );

  // -------------------------------------------------------------------------
  // File management (context menu / inline edits)
  // -------------------------------------------------------------------------

  /** Expand a dir (and the root) so a row inside it can actually render.
      Writes expandedRef eagerly: callers refetchExpanded() in the same task,
      before React re-renders the ref assignments. */
  const ensureExpanded = useCallback(
    (dir: string) => {
      if (dir === repoPathRef.current) {
        setRootExpanded(true);
        return;
      }
      if (expandedRef.current.has(dir)) return;
      const next = new Set(expandedRef.current).add(dir);
      expandedRef.current = next;
      setExpanded(next);
      if (!cacheRef.current.has(dir)) loadDir(dir);
    },
    [loadDir],
  );

  /** Open file tabs at `root` or inside it. */
  const affectedTabs = useCallback(
    (root: string) => {
      const { tabs } = ws.editor.getState();
      return tabs.filter(
        (t) =>
          t.kind === "file" &&
          (t.path === root || t.path.startsWith(root + "/")),
      );
    },
    [ws],
  );

  /** Remove descendants when an ancestor is also selected. Moving/deleting
      the ancestor already includes them, and a second operation would target
      a path that no longer exists. */
  const topLevelEntries = (entries: DirEntry[]) =>
    entries.filter(
      (entry) =>
        !entries.some(
          (other) =>
            other !== entry && entry.path.startsWith(other.path + "/"),
        ),
    );

  const entriesForPaths = (paths: Iterable<string>): DirEntry[] => {
    const wanted = new Set(paths);
    const found: DirEntry[] = [];
    for (const entries of cacheRef.current.values()) {
      if (entries === "error") continue;
      for (const entry of entries) {
        if (wanted.delete(entry.path)) found.push(entry);
      }
    }
    return found;
  };

  /** Renaming/moving/deleting retargets or closes affected tabs, and unsaved
      drafts die with their tab id — get explicit consent first. */
  const confirmDirtyLoss = useCallback(
    async (root: string, title: string): Promise<boolean> => {
      const { dirty } = ws.editor.getState();
      const dirtyTabs = affectedTabs(root).filter((t) => dirty[t.id]);
      if (dirtyTabs.length === 0) return true;
      const what =
        dirtyTabs.length === 1
          ? `"${dirtyTabs[0].title}" has`
          : `${dirtyTabs.length} open files have`;
      return confirm(`${what} unsaved changes that will be lost.`, {
        title,
        kind: "warning",
      });
    },
    [ws, affectedTabs],
  );

  const confirmDirtyLossFor = useCallback(
    async (roots: string[], title: string): Promise<boolean> => {
      const { dirty } = ws.editor.getState();
      const dirtyTabs = new Map(
        roots
          .flatMap(affectedTabs)
          .filter((tab) => dirty[tab.id])
          .map((tab) => [tab.id, tab]),
      );
      if (dirtyTabs.size === 0) return true;
      const tabs = [...dirtyTabs.values()];
      const what =
        tabs.length === 1
          ? `"${tabs[0].title}" has`
          : `${tabs.length} open files have`;
      return confirm(`${what} unsaved changes that will be lost.`, {
        title,
        kind: "warning",
      });
    },
    [ws, affectedTabs],
  );

  /** Repoint local state (selection, expansion, clipboard, editor tabs)
      after `from` moved to `to`. Updates expandedRef eagerly — see
      ensureExpanded. */
  const applyPathMove = useCallback(
    (from: string, to: string) => {
      const remap = (p: string) =>
        p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p;
      const next = new Set([...expandedRef.current].map(remap));
      expandedRef.current = next;
      setExpanded(next);
      setSelected((paths) => {
        const moved = new Set([...paths].map(remap));
        selectedRef.current = moved;
        return moved;
      });
      setFocused((path) => (path ? remap(path) : path));
      if (selectionAnchorRef.current) {
        selectionAnchorRef.current = remap(selectionAnchorRef.current);
      }
      setClipboard((c) => {
        if (!c) return c;
        return {
          ...c,
          entries: c.entries.map((entry) => {
            const path = remap(entry.path);
            return path === entry.path
              ? entry
              : { ...entry, path, name: basename(path) };
          }),
        };
      });
      ws.editor.getState().retargetFileTabs(from, to);
    },
    [ws],
  );

  const scrollRowIntoView = (path: string) => {
    requestAnimationFrame(() => {
      treeRef.current
        ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const startCreate = (dir: string, isDir: boolean) => {
    setMenu(null);
    ensureExpanded(dir);
    setEditing({ kind: "create", dir, isDir });
  };

  const commitCreate = async (
    dir: string,
    isDir: boolean,
    value: string | null,
  ) => {
    setEditing(null);
    const name = value?.trim();
    if (!name) return; // cancelled or left empty
    const title = isDir ? "New Folder" : "New File";
    const invalid = validateName(name);
    if (invalid) {
      void message(invalid, { title, kind: "error" });
      return;
    }
    const path = `${dir}/${name}`;
    try {
      await (isDir ? fsCreateDir(path) : fsCreateFile(path));
    } catch (e) {
      void message(String(e), { title, kind: "error" });
      return;
    }
    const next = new Set([path]);
    selectedRef.current = next;
    setSelected(next);
    setFocused(path);
    selectionAnchorRef.current = path;
    if (!isDir) openFile(path);
    await refetchExpanded();
    scrollRowIntoView(path);
  };

  const commitRename = async (entry: DirEntry, value: string | null) => {
    setEditing(null);
    const name = value?.trim();
    if (!name || name === entry.name) return;
    const invalid = validateName(name);
    if (invalid) {
      void message(invalid, { title: "Rename", kind: "error" });
      return;
    }
    if (!(await confirmDirtyLoss(entry.path, "Rename"))) return;
    const to = `${dirname(entry.path)}/${name}`;
    try {
      await fsRename(entry.path, to);
    } catch (e) {
      void message(String(e), { title: "Rename", kind: "error" });
      return;
    }
    applyPathMove(entry.path, to);
    const next = new Set([to]);
    selectedRef.current = next;
    setSelected(next);
    setFocused(to);
    selectionAnchorRef.current = to;
    await refetchExpanded();
    scrollRowIntoView(to);
  };

  const deleteEntries = async (rawEntries: DirEntry[]) => {
    setMenu(null);
    const entries = topLevelEntries(rawEntries);
    if (entries.length === 0) return;
    const { dirty } = ws.editor.getState();
    const affected = [
      ...new Map(
        entries.flatMap((entry) => affectedTabs(entry.path)).map((tab) => [tab.id, tab]),
      ).values(),
    ];
    const dirtyTabs = affected.filter((t) => dirty[t.id]);
    const unsaved =
      dirtyTabs.length === 0
        ? ""
        : dirtyTabs.length === 1
          ? ` "${dirtyTabs[0].title}" has unsaved changes that will be lost.`
          : ` ${dirtyTabs.length} open files have unsaved changes that will be lost.`;
    const subject =
      entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
    const ok = await confirm(`Move ${subject} to the Trash?${unsaved}`, {
      title: "Delete",
      kind: "warning",
    });
    if (!ok) return;

    const removed: DirEntry[] = [];
    const errors: string[] = [];
    for (const entry of entries) {
      try {
        await fsTrash(entry.path);
        removed.push(entry);
      } catch (e) {
        errors.push(String(e));
      }
    }
    if (removed.length === 0) {
      void message(errors.join("\n"), { title: "Delete", kind: "error" });
      return;
    }

    const withinRemoved = (p: string) =>
      removed.some(
        (entry) => p === entry.path || p.startsWith(entry.path + "/"),
      );
    const editor = ws.editor.getState();
    const removedTabIds = new Set(
      removed.flatMap((entry) => affectedTabs(entry.path)).map((tab) => tab.id),
    );
    for (const tab of affected) {
      if (removedTabIds.has(tab.id)) editor.closeTab(tab.id);
    }
    const next = new Set(
      [...expandedRef.current].filter((path) => !withinRemoved(path)),
    );
    expandedRef.current = next;
    setExpanded(next);
    setSelected((paths) => {
      const kept = new Set([...paths].filter((path) => !withinRemoved(path)));
      selectedRef.current = kept;
      return kept;
    });
    setFocused((path) => (path && withinRemoved(path) ? null : path));
    if (selectionAnchorRef.current && withinRemoved(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null;
    }
    setClipboard((c) => {
      if (!c) return c;
      const kept = c.entries.filter((entry) => !withinRemoved(entry.path));
      return kept.length > 0 ? { ...c, entries: kept } : null;
    });
    await refetchExpanded();
    if (errors.length > 0) {
      void message(errors.join("\n"), { title: "Delete", kind: "error" });
    }
  };

  const moveEntriesInto = async (
    rawEntries: DirEntry[],
    destDir: string,
    title: "Move" | "Paste",
  ): Promise<{ moved: string[]; failed: DirEntry[] } | null> => {
    const entries = topLevelEntries(rawEntries);
    const moving = entries.filter((entry) => dirname(entry.path) !== destDir);
    const invalid = moving.find(
      (entry) =>
        entry.isDir &&
        (destDir === entry.path || destDir.startsWith(entry.path + "/")),
    );
    if (invalid) {
      void message("Cannot move a folder into itself.", {
        title,
        kind: "error",
      });
      return null;
    }
    if (moving.length === 0) return { moved: [], failed: [] };
    if (!(await confirmDirtyLossFor(moving.map((entry) => entry.path), "Move"))) {
      return null;
    }

    const moved: string[] = [];
    const failed: DirEntry[] = [];
    const errors: string[] = [];
    for (const entry of moving) {
      const dest = `${destDir}/${entry.name}`;
      try {
        await fsRename(entry.path, dest);
        applyPathMove(entry.path, dest);
        moved.push(dest);
      } catch (e) {
        failed.push(entry);
        errors.push(String(e));
      }
    }
    ensureExpanded(destDir);
    if (moved.length > 0) {
      const next = new Set(moved);
      selectedRef.current = next;
      setSelected(next);
      setFocused(moved[moved.length - 1]);
      selectionAnchorRef.current = moved[0];
    }
    await refetchExpanded();
    if (moved.length > 0) scrollRowIntoView(moved[moved.length - 1]);
    if (errors.length > 0) {
      void message(errors.join("\n"), { title, kind: "error" });
    }
    return { moved, failed };
  };

  const pasteInto = async (destDir: string) => {
    setMenu(null);
    if (!clipboard) return;
    const { entries: clipboardEntries, cut } = clipboard;
    const entries = topLevelEntries(clipboardEntries);
    if (cut) {
      const result = await moveEntriesInto(entries, destDir, "Paste");
      if (result) {
        setClipboard(
          result.failed.length > 0
            ? { entries: result.failed, cut: true }
            : null,
        );
      }
    } else {
      const created: string[] = [];
      const errors: string[] = [];
      for (const entry of entries) {
        try {
          created.push(await fsCopy(entry.path, destDir));
        } catch (e) {
          errors.push(String(e));
        }
      }
      ensureExpanded(destDir);
      if (created.length > 0) {
        const next = new Set(created);
        selectedRef.current = next;
        setSelected(next);
        setFocused(created[created.length - 1]);
        selectionAnchorRef.current = created[0];
      }
      await refetchExpanded();
      if (created.length > 0) scrollRowIntoView(created[created.length - 1]);
      if (errors.length > 0) {
        void message(errors.join("\n"), { title: "Paste", kind: "error" });
      }
    }
  };

  // -------------------------------------------------------------------------

  const rows = useMemo(() => {
    const out: Row[] = [];
    const pushDir = (dirPath: string, depth: number) => {
      const entries = cache.get(dirPath);
      if (entries === undefined) return; // not loaded yet
      if (entries === "error") {
        out.push({ key: `${dirPath}::error`, kind: "error", entry: null, depth });
        return;
      }
      if (editing?.kind === "create" && editing.dir === dirPath) {
        out.push({ key: `${dirPath}::create`, kind: "create", entry: null, depth });
      } else if (entries.length === 0) {
        out.push({ key: `${dirPath}::empty`, kind: "empty", entry: null, depth });
        return;
      }
      for (const e of entries) {
        out.push({ key: e.path, kind: "entry", entry: e, depth });
        if (e.isDir && expanded.has(e.path)) pushDir(e.path, depth + 1);
      }
    };
    if (repoPath && rootExpanded) pushDir(repoPath, 0);
    return out;
  }, [cache, expanded, rootExpanded, repoPath, editing]);

  const visibleEntries = rows
    .filter((row) => row.kind === "entry")
    .map((row) => row.entry!);

  const setOnlySelected = (path: string) => {
    const next = new Set([path]);
    selectedRef.current = next;
    setSelected(next);
    setFocused(path);
    selectionAnchorRef.current = path;
  };

  const selectRange = (toPath: string) => {
    const anchor = selectionAnchorRef.current;
    const anchorIdx = visibleEntries.findIndex((entry) => entry.path === anchor);
    const toIdx = visibleEntries.findIndex((entry) => entry.path === toPath);
    if (anchorIdx < 0 || toIdx < 0) {
      setOnlySelected(toPath);
      return;
    }
    const [start, end] =
      anchorIdx < toIdx ? [anchorIdx, toIdx] : [toIdx, anchorIdx];
    const next = new Set(
      visibleEntries.slice(start, end + 1).map((entry) => entry.path),
    );
    selectedRef.current = next;
    setSelected(next);
    setFocused(toPath);
  };

  const onRowClick = (entry: DirEntry, ev: React.MouseEvent) => {
    if (ev.shiftKey) {
      selectRange(entry.path);
      return;
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selectedRef.current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      selectedRef.current = next;
      setSelected(next);
      setFocused(entry.path);
      selectionAnchorRef.current = entry.path;
      return;
    }
    setOnlySelected(entry.path);
    if (entry.isDir) toggleDir(entry.path);
    else previewFile(entry.path);
  };

  const onRowContext = (entry: DirEntry, ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!selectedRef.current.has(entry.path)) setOnlySelected(entry.path);
    else setFocused(entry.path);
    setMenu({ x: ev.clientX, y: ev.clientY, entry });
  };

  const moveDroppedEntries = async (rawEntries: DirEntry[], destDir: string) => {
    await moveEntriesInto(rawEntries, destDir, "Move");
  };

  const updateDropTarget = (path: string | null) => {
    if (dropTargetRef.current === path) return;
    dropTargetRef.current = path;
    setDropTarget(path);
  };

  /** WKWebView/Tauri does not reliably deliver HTML drag events for explorer
      rows. Use pointer capture (the same strategy as Dock's tab dragging),
      then hit-test folder/root targets beneath the captured pointer. */
  const beginPointerDrag = (ev: React.PointerEvent, entry: DirEntry) => {
    if (ev.button !== 0) return;
    const row = ev.currentTarget as HTMLElement;
    const pointerId = ev.pointerId;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let started = false;

    const hitTest = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      const target = hit?.closest("[data-fx-drop-dir]") as HTMLElement | null;
      if (target) {
        updateDropTarget(target.getAttribute("data-fx-drop-dir"));
        return;
      }
      const tree = hit?.closest(".fx-tree");
      updateDropTarget(tree ? repoPathRef.current : null);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      document.body.style.cursor = "";
      document.body.classList.remove("fx-pointer-dragging");
      dragCleanupRef.current = null;
    };

    const finish = (commit: boolean) => {
      cleanup();
      const target = dropTargetRef.current;
      const paths = dragPathsRef.current;
      dragPathsRef.current = [];
      updateDropTarget(null);
      setDragging(new Set());
      setDragGhost(null);
      if (!started) return;

      // A click is normally synthesized immediately after pointerup. Do not
      // let that reopen/toggle the row after a completed drag.
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (commit && target) {
        void moveDroppedEntries(entriesForPaths(paths), target);
      }
    };

    const onMove = (moveEv: PointerEvent) => {
      // Prevent WKWebView from turning the gesture into a native text
      // selection, including during the few pixels before drag activation.
      moveEv.preventDefault();
      if (!started) {
        if (
          Math.abs(moveEv.clientX - startX) < DRAG_THRESHOLD_PX &&
          Math.abs(moveEv.clientY - startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        started = true;
        let paths: string[];
        if (selectedRef.current.has(entry.path)) {
          paths = topLevelEntries(entriesForPaths(selectedRef.current)).map(
            (item) => item.path,
          );
        } else {
          setOnlySelected(entry.path);
          paths = [entry.path];
        }
        dragPathsRef.current = paths;
        setDragging(new Set(paths));
        setDragGhost(paths.length === 1 ? entry.name : `${paths.length} items`);
        window.getSelection()?.removeAllRanges();
        row.setPointerCapture(pointerId);
        document.body.style.cursor = "grabbing";
        document.body.classList.add("fx-pointer-dragging");
      }

      const ghost = dragGhostRef.current;
      if (ghost) {
        ghost.style.left = `${moveEv.clientX + 10}px`;
        ghost.style.top = `${moveEv.clientY + 8}px`;
      }
      const tree = treeRef.current;
      if (tree) {
        const rect = tree.getBoundingClientRect();
        if (moveEv.clientY < rect.top + 24) tree.scrollTop -= 10;
        else if (moveEv.clientY > rect.bottom - 24) tree.scrollTop += 10;
      }
      hitTest(moveEv.clientX, moveEv.clientY);
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (keyEv: KeyboardEvent) => {
      if (keyEv.key === "Escape") {
        keyEv.stopPropagation();
        finish(false);
      }
    };

    dragCleanupRef.current = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const entries = visibleEntries;
    if (entries.length === 0) return;
    const idx = entries.findIndex((entry) => entry.path === focused);
    const sel = idx >= 0 ? entries[idx] : null;

    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const ni =
        idx === -1
          ? 0
          : Math.min(
              entries.length - 1,
              Math.max(0, idx + (ev.key === "ArrowDown" ? 1 : -1)),
            );
      if (ev.shiftKey) selectRange(entries[ni].path);
      else setOnlySelected(entries[ni].path);
      scrollRowIntoView(entries[ni].path);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      if (sel?.isDir && !expanded.has(sel.path)) toggleDir(sel.path);
      else if (sel?.isDir) {
        const child = entries[idx + 1];
        if (child?.path.startsWith(`${sel.path}/`)) {
          setOnlySelected(child.path);
          scrollRowIntoView(child.path);
        }
      }
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      if (sel?.isDir && expanded.has(sel.path)) toggleDir(sel.path);
      else if (sel) {
        const parent = dirname(sel.path);
        if (parent !== repoPath && parent.startsWith(`${repoPath}/`)) {
          setOnlySelected(parent);
          scrollRowIntoView(parent);
        }
      }
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (!sel) return;
      if (sel.isDir) toggleDir(sel.path);
      else openFile(sel.path);
    } else if (ev.key === "F2") {
      ev.preventDefault();
      if (sel && selected.size === 1) setEditing({ kind: "rename", entry: sel });
    } else if (ev.key === "Backspace" && ev.metaKey) {
      ev.preventDefault();
      void deleteEntries(entriesForPaths(selected));
    } else if (ev.key.toLowerCase() === "a" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      const next = new Set(entries.map((entry) => entry.path));
      selectedRef.current = next;
      setSelected(next);
      setFocused(entries[entries.length - 1].path);
      selectionAnchorRef.current = entries[0].path;
    }
  };

  return (
    <div className="file-explorer">
      <div className="fx-header">
        <span className="fx-title">Explorer</span>
        <div className="fx-actions">
          <button
            className="icon-btn"
            title="Collapse all"
            onClick={() => setExpanded(new Set())}
          >
            <IcCollapseAll />
          </button>
          <button
            className="icon-btn"
            title="Refresh"
            onClick={() => void refetchExpanded()}
          >
            <IcRefresh />
          </button>
        </div>
      </div>

      <div
        className="fx-tree"
        ref={treeRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          selectedRef.current = new Set();
          setSelected(new Set());
          setFocused(null);
          selectionAnchorRef.current = null;
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenu({ x: ev.clientX, y: ev.clientY, entry: null });
        }}
      >
        <div
          className={`fx-repo-row ${dropTarget === repoPath ? "drop-target" : ""}`}
          data-fx-drop-dir={repoPath}
          onClick={() => setRootExpanded((v) => !v)}
        >
          <span className={`fx-chevron ${rootExpanded ? "open" : ""}`}>
            <IcChevronRight />
          </span>
          <span className="fx-repo-name truncate">{repoName}</span>
        </div>

        {rows.map((row) => {
          if (row.kind === "create" && editing?.kind === "create") {
            const { dir, isDir } = editing;
            return (
              <div key={row.key} className="fx-row">
                {Array.from({ length: row.depth }, (_, i) => (
                  <span key={i} className="fx-indent" />
                ))}
                <span className="fx-chevron" />
                <span className={`fx-icon ${isDir ? "dir" : "file"}`}>
                  {isDir ? <IcFolder /> : <IcFile />}
                </span>
                <NameInput
                  defaultValue=""
                  onCommit={(v) => void commitCreate(dir, isDir, v)}
                />
              </div>
            );
          }
          if (row.kind !== "entry") {
            return (
              <div key={row.key} className="fx-row fx-placeholder">
                {Array.from({ length: row.depth }, (_, i) => (
                  <span key={i} className="fx-indent" />
                ))}
                <span className="fx-chevron" />
                <span className="fx-placeholder-text">
                  ({row.kind === "error" ? "error" : "empty"})
                </span>
              </div>
            );
          }
          const e = row.entry!;
          const isOpen = e.isDir && expanded.has(e.path);
          const isRenaming =
            editing?.kind === "rename" && editing.entry.path === e.path;
          const cls = [
            "fx-row",
            selected.has(e.path) ? "selected" : "",
            e.name.startsWith(".") ? "dotfile" : "",
            clipboard?.cut && clipboard.entries.some((entry) => entry.path === e.path)
              ? "cut"
              : "",
            dragging.has(e.path) ? "dragging" : "",
            dropTarget === e.path ? "drop-target" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={row.key}
              data-path={e.path}
              data-fx-drop-dir={e.isDir ? e.path : undefined}
              className={cls}
              onPointerDown={
                isRenaming ? undefined : (ev) => beginPointerDrag(ev, e)
              }
              onClick={
                isRenaming
                  ? undefined
                  : (ev) => {
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      onRowClick(e, ev);
                    }
              }
              onDoubleClick={
                isRenaming || e.isDir
                  ? undefined
                  : (ev) => {
                      ev.preventDefault();
                      openFile(e.path);
                    }
              }
              onContextMenu={(ev) => onRowContext(e, ev)}
            >
              {Array.from({ length: row.depth }, (_, i) => (
                <span key={i} className="fx-indent" />
              ))}
              <span className={`fx-chevron ${isOpen ? "open" : ""}`}>
                {e.isDir && <IcChevronRight />}
              </span>
              <span className={`fx-icon ${e.isDir ? "dir" : "file"}`}>
                {e.isDir ? <IcFolder /> : <IcFile />}
              </span>
              {isRenaming ? (
                <NameInput
                  defaultValue={e.name}
                  onCommit={(v) => void commitRename(e, v)}
                />
              ) : (
                <span className="fx-name truncate">{e.name}</span>
              )}
            </div>
          );
        })}
      </div>

      {dragGhost && (
        <div className="fx-drag-ghost" ref={dragGhostRef}>
          <span className="truncate">{dragGhost}</span>
        </div>
      )}

      {menu &&
        repoPath &&
        (() => {
          const e = menu.entry;
          const menuEntries = e
            ? selected.has(e.path)
              ? entriesForPaths(selected)
              : [e]
            : [];
          const topMenuEntries = topLevelEntries(menuEntries);
          const single = topMenuEntries.length === 1 ? topMenuEntries[0] : null;
          // files take New/Paste actions on their containing dir
          const dirFor = e ? (e.isDir ? e.path : dirname(e.path)) : repoPath;
          return (
            <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
              {(!e || e.isDir) && (
                <>
                  <button onClick={() => startCreate(dirFor, false)}>
                    New File…
                  </button>
                  <button onClick={() => startCreate(dirFor, true)}>
                    New Folder…
                  </button>
                  <div className="ctx-menu-sep" />
                </>
              )}
              <button
                onClick={() => {
                  setMenu(null);
                  void fsReveal(single?.path ?? e?.path ?? repoPath);
                }}
              >
                Reveal in Finder
              </button>
              <div className="ctx-menu-sep" />
              {e && (
                <>
                  <button
                    onClick={() => {
                      setClipboard({ entries: topMenuEntries, cut: true });
                      setMenu(null);
                    }}
                  >
                    Cut
                  </button>
                  <button
                    onClick={() => {
                      setClipboard({ entries: topMenuEntries, cut: false });
                      setMenu(null);
                    }}
                  >
                    Copy
                  </button>
                </>
              )}
              <button disabled={!clipboard} onClick={() => void pasteInto(dirFor)}>
                Paste
              </button>
              {e && (
                <>
                  <div className="ctx-menu-sep" />
                  <button
                    onClick={() => {
                      void copyText(
                        topMenuEntries.map((entry) => entry.path).join("\n"),
                      );
                      setMenu(null);
                    }}
                  >
                    Copy Path
                  </button>
                  <button
                    onClick={() => {
                      void copyText(
                        topMenuEntries
                          .map((entry) => entry.path.slice(repoPath.length + 1))
                          .join("\n"),
                      );
                      setMenu(null);
                    }}
                  >
                    Copy Relative Path
                  </button>
                  <div className="ctx-menu-sep" />
                  {single && (
                    <button
                      onClick={() => {
                        setMenu(null);
                        setEditing({ kind: "rename", entry: single });
                      }}
                    >
                      Rename…
                    </button>
                  )}
                  <button onClick={() => void deleteEntries(topMenuEntries)}>
                    Delete
                  </button>
                </>
              )}
            </ContextMenu>
          );
        })()}
    </div>
  );
}
