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
  const activeTabId = useEditor((s) => s.activeTabId);

  const [cache, setCache] = useState<DirCache>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [rootExpanded, setRootExpanded] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    /** null = root / blank-area menu */
    entry: DirEntry | null;
  } | null>(null);
  // explorer-internal cut/copy clipboard (not the OS pasteboard)
  const [clipboard, setClipboard] = useState<{
    entry: DirEntry;
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
  repoPathRef.current = repoPath;
  expandedRef.current = expanded;
  cacheRef.current = cache;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
    setSelected(null);
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
    if (activeFilePath) setSelected(activeFilePath);
  }, [activeFilePath]);

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
      setSelected((s) => (s ? remap(s) : s));
      setClipboard((c) => {
        if (!c) return c;
        const p = remap(c.entry.path);
        if (p === c.entry.path) return c;
        return { ...c, entry: { ...c.entry, path: p, name: basename(p) } };
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
    setSelected(path);
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
    setSelected(to);
    await refetchExpanded();
    scrollRowIntoView(to);
  };

  const deleteEntry = async (entry: DirEntry) => {
    setMenu(null);
    const { dirty } = ws.editor.getState();
    const affected = affectedTabs(entry.path);
    const dirtyTabs = affected.filter((t) => dirty[t.id]);
    const unsaved =
      dirtyTabs.length === 0
        ? ""
        : dirtyTabs.length === 1
          ? ` "${dirtyTabs[0].title}" has unsaved changes that will be lost.`
          : ` ${dirtyTabs.length} open files have unsaved changes that will be lost.`;
    const ok = await confirm(`Move "${entry.name}" to the Trash?${unsaved}`, {
      title: "Delete",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await fsTrash(entry.path);
    } catch (e) {
      void message(String(e), { title: "Delete", kind: "error" });
      return;
    }
    const editor = ws.editor.getState();
    for (const t of affected) editor.closeTab(t.id);
    const within = (p: string) =>
      p === entry.path || p.startsWith(entry.path + "/");
    const next = new Set([...expandedRef.current].filter((p) => !within(p)));
    expandedRef.current = next;
    setExpanded(next);
    setSelected((s) => (s && within(s) ? null : s));
    setClipboard((c) => (c && within(c.entry.path) ? null : c));
    await refetchExpanded();
  };

  const pasteInto = async (destDir: string) => {
    setMenu(null);
    if (!clipboard) return;
    const { entry, cut } = clipboard;
    if (cut) {
      const dest = `${destDir}/${entry.name}`;
      if (dest === entry.path) {
        setClipboard(null); // pasted back in place
        return;
      }
      if (
        entry.isDir &&
        (destDir === entry.path || destDir.startsWith(entry.path + "/"))
      ) {
        void message("Cannot move a folder into itself.", {
          title: "Paste",
          kind: "error",
        });
        return;
      }
      if (!(await confirmDirtyLoss(entry.path, "Move"))) return;
      try {
        await fsRename(entry.path, dest);
      } catch (e) {
        void message(String(e), { title: "Paste", kind: "error" });
        return;
      }
      setClipboard(null);
      applyPathMove(entry.path, dest);
      ensureExpanded(destDir);
      setSelected(dest);
      await refetchExpanded();
      scrollRowIntoView(dest);
    } else {
      let created: string;
      try {
        created = await fsCopy(entry.path, destDir);
      } catch (e) {
        void message(String(e), { title: "Paste", kind: "error" });
        return;
      }
      ensureExpanded(destDir);
      setSelected(created);
      await refetchExpanded();
      scrollRowIntoView(created);
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

  const onRowClick = (e: DirEntry) => {
    setSelected(e.path);
    if (e.isDir) toggleDir(e.path);
    else openFile(e.path);
  };

  const onRowContext = (e: DirEntry, ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setSelected(e.path);
    setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const entries = rows.filter((r) => r.kind === "entry").map((r) => r.entry!);
    if (entries.length === 0) return;
    const idx = entries.findIndex((e) => e.path === selected);
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
      setSelected(entries[ni].path);
      scrollRowIntoView(entries[ni].path);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      if (sel?.isDir && !expanded.has(sel.path)) toggleDir(sel.path);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      if (sel?.isDir && expanded.has(sel.path)) toggleDir(sel.path);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (!sel) return;
      if (sel.isDir) toggleDir(sel.path);
      else openFile(sel.path);
    } else if (ev.key === "F2") {
      ev.preventDefault();
      if (sel) setEditing({ kind: "rename", entry: sel });
    } else if (ev.key === "Backspace" && ev.metaKey) {
      ev.preventDefault();
      if (sel) void deleteEntry(sel);
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
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenu({ x: ev.clientX, y: ev.clientY, entry: null });
        }}
      >
        <div
          className="fx-repo-row"
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
            selected === e.path ? "selected" : "",
            e.name.startsWith(".") ? "dotfile" : "",
            clipboard?.cut && clipboard.entry.path === e.path ? "cut" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={row.key}
              data-path={e.path}
              className={cls}
              onClick={isRenaming ? undefined : () => onRowClick(e)}
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

      {menu &&
        repoPath &&
        (() => {
          const e = menu.entry;
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
                  void fsReveal(e?.path ?? repoPath);
                }}
              >
                Reveal in Finder
              </button>
              <div className="ctx-menu-sep" />
              {e && (
                <>
                  <button
                    onClick={() => {
                      setClipboard({ entry: e, cut: true });
                      setMenu(null);
                    }}
                  >
                    Cut
                  </button>
                  <button
                    onClick={() => {
                      setClipboard({ entry: e, cut: false });
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
                      void copyText(e.path);
                      setMenu(null);
                    }}
                  >
                    Copy Path
                  </button>
                  <button
                    onClick={() => {
                      void copyText(e.path.slice(repoPath.length + 1));
                      setMenu(null);
                    }}
                  >
                    Copy Relative Path
                  </button>
                  <div className="ctx-menu-sep" />
                  <button
                    onClick={() => {
                      setMenu(null);
                      setEditing({ kind: "rename", entry: e });
                    }}
                  >
                    Rename…
                  </button>
                  <button onClick={() => void deleteEntry(e)}>Delete</button>
                </>
              )}
            </ContextMenu>
          );
        })()}
    </div>
  );
}
