/**
 * Diff tab content: side-by-side (MergeView) or unified (unifiedMergeView)
 * comparison of the old/new contents returned by git_diff_file. The new side
 * is editable (with Cmd-S save to the working tree) for worktree diffs.
 * Non-commit diffs refetch when the repo watcher reports changes; unsaved
 * edits are never clobbered (a warning banner offers an explicit reload).
 */
import { useEffect, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Text } from "@codemirror/state";
import {
  MergeView,
  goToNextChunk,
  goToPreviousChunk,
  unifiedMergeView,
} from "@codemirror/merge";
import {
  gitDiffFile,
  fsReadFile,
  fsReveal,
  fsWriteFile,
  onRepoChanged,
  type DiffPayload,
} from "../lib/ipc";
import { basename } from "../lib/path";
import { changeRuler } from "../lib/cmChangeRuler";
import {
  clearBufferedEditor,
  detectLineEnding,
  getBufferedEditor,
  registerLiveSaver,
  serializeText,
  setBufferedEditor,
  type LineEnding,
} from "../lib/editorBuffers";
import { copyText } from "../lib/clipboard";
import type { Tab } from "../stores/editor";
import { useWorkspace } from "../stores/workspaces";
import { useUiStore } from "../stores/ui";
import {
  BannerDismiss,
  editKeymap,
  editorTheme,
  languageFor,
  readOnlyExtension,
  type CmExtension,
} from "./Editor";
import { editorSearch } from "./EditorSearch";
import { ContextMenu } from "./ContextMenu";
import { IcChevronDown, IcChevronUp, IcFile, IcRows, IcSplit } from "./icons";
import "./EditorArea.css";

type DiffTab = Extract<Tab, { kind: "diff" }>;
type DiffMode = "split" | "unified";

interface DiffData {
  payload: DiffPayload;
  lang: CmExtension | null;
}

const MODE_KEY = "vibe-studio:diff-mode";

/** Debounce for refetching the diff after a repo watcher event. */
const REFETCH_DEBOUNCE_MS = 250;

const loadMode = (): DiffMode =>
  localStorage.getItem(MODE_KEY) === "unified" ? "unified" : "split";

const COLLAPSE = { margin: 3, minSize: 4 };

export default function DiffViewer({ tab }: { tab: DiffTab }) {
  const ws = useWorkspace();
  const { diff } = tab;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<DiffMode>(loadMode);
  const [data, setData] = useState<DiffData | null>(null);
  /** Mirror of `data` for the watcher refetch (avoids stale closures). */
  const dataRef = useRef<DiffData | null>(null);
  /** Last loaded/written new-side text and exact disk representation. */
  const savedTextRef = useRef<Text>(Text.empty);
  const savedDiskTextRef = useRef("");
  const lineEndingRef = useRef<LineEnding>("LF");
  /** Live doc of the editable (b) side, kept fresh by an updateListener. */
  const bDocRef = useRef<Text | null>(null);
  const navViewRef = useRef<EditorView | null>(null);
  /** Forced refetch wired up by the watcher effect (Reload button). */
  const refetchRef = useRef<(() => void) | null>(null);
  const forceSaveRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Diff changed on disk under unsaved b-side edits. */
  const [diskChanged, setDiskChanged] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    view: EditorView | null;
  } | null>(null);

  const applyData = (d: DiffData | null) => {
    dataRef.current = d;
    setData(d);
  };

  // Fetch diff payload + language when the tab's diff changes.
  useEffect(() => {
    let disposed = false;
    applyData(null);
    setError(null);
    setSaveError(null);
    setDiskChanged(false);
    Promise.all([
      gitDiffFile(diff.repoPath, diff.path, diff.kind, diff.oid, diff.origPath),
      languageFor(diff.path),
    ])
      .then(([payload, lang]) => {
        if (disposed) return;
        const cached = getBufferedEditor(ws.editor, tab.id);
        savedDiskTextRef.current = cached?.savedDiskText ?? payload.newText;
        lineEndingRef.current = cached?.lineEnding ?? detectLineEnding(payload.newText);
        const displayText = cached
          ? serializeText(cached.text, cached.lineEnding)
          : payload.newText;
        const displayPayload = { ...payload, newText: displayText };
        savedTextRef.current = cached?.savedText ?? Text.of(payload.newText.split(/\r\n?|\n/));
        applyData({ payload: displayPayload, lang });
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [tab.id, diff.repoPath, diff.path, diff.kind, diff.oid, diff.origPath, ws.editor]);

  // Worktree/staged diffs go stale as the repo changes: refetch on watcher
  // events, but never tear down a view holding unsaved edits.
  useEffect(() => {
    if (diff.kind === "commit") return; // commit diffs are immutable

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async (force: boolean) => {
      try {
        const payload = await gitDiffFile(
          diff.repoPath,
          diff.path,
          diff.kind,
          diff.oid,
          diff.origPath,
        );
        if (disposed) return;
        const cur = dataRef.current;
        if (!cur) return; // initial load still in flight
        // Nothing changed vs what we show (e.g. the watcher echoing our own
        // save) — keep the view (and its cursor/scroll) intact.
        if (
          !force &&
          payload.oldText === cur.payload.oldText &&
          payload.newText === savedDiskTextRef.current
        )
          return;
        const edited =
          bDocRef.current !== null &&
          !bDocRef.current.eq(savedTextRef.current);
        if (!force && edited) {
          setDiskChanged(true);
          return;
        }
        savedTextRef.current = Text.of(payload.newText.split(/\r\n?|\n/));
        savedDiskTextRef.current = payload.newText;
        lineEndingRef.current = detectLineEnding(payload.newText);
        setDiskChanged(false);
        applyData({ payload, lang: cur.lang });
      } catch (e) {
        // Background refetch failures are ignored (file may be mid-change).
        if (!disposed && force) setError(String(e));
      }
    };
    refetchRef.current = () => void refetch(true);

    void onRepoChanged((change) => {
      // events arrive for every open workspace — only our repo matters
      if (disposed || change.repoPath !== diff.repoPath) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(false), REFETCH_DEBOUNCE_MS);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
      refetchRef.current = null;
    };
  }, [tab.id, diff.repoPath, diff.path, diff.kind, diff.oid, diff.origPath]);

  // Build / rebuild the merge view.
  useEffect(() => {
    if (!data) return;
    const { payload, lang } = data;
    if (payload.binary || (payload.oldText === payload.newText && diff.kind !== "worktree")) return;
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    // changeRuler("merge") follows the merge chunks in both split sides and
    // the unified view (scrollbar change blips).
    const shared: CmExtension[] = [
      basicSetup,
      editorTheme,
      editorSearch,
      changeRuler("merge"),
      lang ?? [],
    ];
    const editable = diff.kind === "worktree";
    const savePath = `${diff.repoPath.replace(/\/$/, "")}/${diff.path}`;
    // Track the b side's doc so refetches can tell unsaved edits apart.
    const trackDoc = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      bDocRef.current = u.state.doc;
      if (!editable) return;
      const dirty = !u.state.doc.eq(savedTextRef.current);
      const userEdited = u.transactions.some((transaction) =>
        ["input", "delete", "move", "undo", "redo"].some((event) =>
          transaction.isUserEvent(event),
        ),
      );
      if (dirty) {
        setBufferedEditor(ws.editor, tab.id, {
          path: savePath,
          text: u.state.doc,
          savedText: savedTextRef.current,
          savedDiskText: savedDiskTextRef.current,
          lineEnding: lineEndingRef.current,
        });
      } else clearBufferedEditor(ws.editor, tab.id);
      ws.editor.getState().markDirty(tab.id, dirty, userEdited);
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      if (dirty && useUiStore.getState().autoSave) {
        autoSaveTimer = setTimeout(() => void save(u.view, false), 1000);
      }
    });
    const save = async (v: EditorView, force: boolean): Promise<boolean> => {
      try {
        if (!force) {
          const file = await fsReadFile(savePath).catch(() => null);
          if (file && (file.binary || file.text !== savedDiskTextRef.current)) {
            if (!disposed) setDiskChanged(true);
            return false;
          }
        }
        const docText = serializeText(v.state.doc, lineEndingRef.current);
        await fsWriteFile(savePath, docText);
        if (disposed) return false;
        savedTextRef.current = v.state.doc;
        savedDiskTextRef.current = docText;
        clearBufferedEditor(ws.editor, tab.id);
        ws.editor.getState().markDirty(tab.id, false);
        setSaveError(null);
        setDiskChanged(false);
        return true;
      } catch (error) {
        if (!disposed) setSaveError(String(error));
        return false;
      }
    };
    forceSaveRef.current = () => {
      const view = navViewRef.current;
      if (view) void save(view, true);
    };
    const newSideExts = editable
      ? [...shared, trackDoc, editKeymap((view) => void save(view, false))]
      : [...shared, trackDoc, readOnlyExtension];

    let mergeView: MergeView | null = null;
    let unifiedView: EditorView | null = null;

    if (mode === "split") {
      mergeView = new MergeView({
        a: { doc: payload.oldText, extensions: [...shared, readOnlyExtension] },
        b: { doc: payload.newText, extensions: newSideExts },
        parent: host,
        collapseUnchanged: COLLAPSE,
        highlightChanges: true,
        gutter: true,
      });
      bDocRef.current = mergeView.b.state.doc;
      navViewRef.current = mergeView.b;
    } else {
      unifiedView = new EditorView({
        doc: payload.newText,
        extensions: [
          ...newSideExts,
          unifiedMergeView({
            original: payload.oldText,
            mergeControls: false,
            highlightChanges: true,
            gutter: true,
            collapseUnchanged: COLLAPSE,
          }),
        ],
        parent: host,
      });
      bDocRef.current = unifiedView.state.doc;
      navViewRef.current = unifiedView;
    }

    const unregisterSaver = editable
      ? registerLiveSaver(ws.editor, tab.id, (force) => {
          const view = navViewRef.current;
          return view ? save(view, force) : Promise.resolve(false);
        })
      : null;
    const unsubscribeUi = useUiStore.subscribe((state, previous) => {
      if (!editable || !state.autoSave || previous.autoSave === state.autoSave) return;
      const view = navViewRef.current;
      if (!view || view.state.doc.eq(savedTextRef.current)) return;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => void save(view, false), 1000);
    });

    return () => {
      disposed = true;
      bDocRef.current = null;
      navViewRef.current = null;
      forceSaveRef.current = null;
      unregisterSaver?.();
      unsubscribeUi();
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      mergeView?.destroy();
      unifiedView?.destroy();
    };
  }, [data, mode, diff.kind, diff.repoPath, diff.path, tab.id, ws.editor]);

  const toggleMode = () => {
    const live = bDocRef.current;
    const current = dataRef.current;
    if (live && current) {
      applyData({
        ...current,
        payload: {
          ...current.payload,
          newText: serializeText(live, lineEndingRef.current),
        },
      });
    }
    setMode((m) => {
      const next: DiffMode = m === "split" ? "unified" : "split";
      localStorage.setItem(MODE_KEY, next);
      return next;
    });
  };

  const payload = data?.payload ?? null;
  const filePath = `${diff.repoPath.replace(/\/$/, "")}/${diff.path}`;
  const canOpenFile = diff.status !== "D";
  const openFile = () => {
    if (canOpenFile) ws.editor.getState().openFile(filePath);
  };
  const navigateChunk = (direction: -1 | 1) => {
    const view = navViewRef.current;
    if (!view) return;
    (direction < 0 ? goToPreviousChunk : goToNextChunk)(view);
    view.focus();
  };

  return (
    <div className="diff-pane">
      <div className="diff-toolbar">
        <span className="diff-name truncate">{basename(diff.path)}</span>
        {payload && (
          <span className="diff-labels truncate">
            {payload.oldLabel} ↔ {payload.newLabel}
          </span>
        )}
        <span className="diff-spacer" />
        <button
          className="icon-btn"
          title="Previous change (Shift-F7)"
          onClick={() => navigateChunk(-1)}
        >
          <IcChevronUp />
        </button>
        <button
          className="icon-btn"
          title="Next change (F7)"
          onClick={() => navigateChunk(1)}
        >
          <IcChevronDown />
        </button>
        <button
          className="icon-btn"
          title={canOpenFile ? "Open file" : "Deleted file has no working-tree file"}
          disabled={!canOpenFile}
          onClick={openFile}
        >
          <IcFile />
        </button>
        <button
          className="icon-btn"
          title={mode === "split" ? "Switch to unified view" : "Switch to side-by-side view"}
          onClick={toggleMode}
        >
          {mode === "split" ? <IcRows /> : <IcSplit />}
        </button>
      </div>
      {diskChanged && (
        <div className="editor-banner warning">
          <span className="truncate">
            File changed on disk — saving will overwrite it
          </span>
          <button className="banner-action" onClick={() => refetchRef.current?.()}>
            Reload
          </button>
          <button className="banner-action" onClick={() => forceSaveRef.current?.()}>
            Overwrite
          </button>
          <BannerDismiss onClick={() => setDiskChanged(false)} />
        </div>
      )}
      {saveError && (
        <div className="editor-banner danger">
          <span className="truncate">Save failed: {saveError}</span>
          <BannerDismiss onClick={() => setSaveError(null)} />
        </div>
      )}
      <div
        className="diff-body"
        onContextMenu={(event) => {
          event.preventDefault();
          const editor = (event.target as HTMLElement).closest<HTMLElement>(".cm-editor");
          setMenu({
            x: event.clientX,
            y: event.clientY,
            view: editor ? EditorView.findFromDOM(editor) : null,
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "F7") {
            event.preventDefault();
            navigateChunk(event.shiftKey ? -1 : 1);
          }
        }}
      >
        {error ? (
          <div className="editor-msg danger">{error}</div>
        ) : !data ? (
          <div className="editor-msg dim">Loading…</div>
        ) : data.payload.binary ? (
          <div className="editor-msg">Binary file</div>
        ) : data.payload.oldText === data.payload.newText && diff.kind !== "worktree" ? (
          <div className="editor-msg dim">No changes</div>
        ) : (
          <div ref={hostRef} className="diff-host" />
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            disabled={
              menu.view !== navViewRef.current ||
              diff.kind !== "worktree" ||
              !menu.view ||
              menu.view.state.selection.ranges.every((range) => range.empty)
            }
            onClick={() => {
              const view = menu.view;
              if (view) {
                const text = view.state.selection.ranges
                  .map((range) => view.state.sliceDoc(range.from, range.to))
                  .join("\n");
                void copyText(text);
                ws.editor.getState().pinTab(tab.id);
                view.dispatch(view.state.replaceSelection(""));
                view.focus();
              }
              setMenu(null);
            }}
          >
            Cut
          </button>
          <button
            disabled={!menu.view || menu.view.state.selection.ranges.every((range) => range.empty)}
            onClick={() => {
              if (menu.view) {
                const text = menu.view.state.selection.ranges
                  .map((range) => menu.view!.state.sliceDoc(range.from, range.to))
                  .join("\n");
                void copyText(text);
              }
              setMenu(null);
            }}
          >
            Copy
          </button>
          <button
            disabled={menu.view !== navViewRef.current || diff.kind !== "worktree"}
            onClick={() => {
              const view = menu.view;
              if (view) {
                void navigator.clipboard.readText().then((text) => {
                  ws.editor.getState().pinTab(tab.id);
                  view.dispatch(view.state.replaceSelection(text));
                  view.focus();
                });
              }
              setMenu(null);
            }}
          >
            Paste
          </button>
          <div className="ctx-menu-sep" />
          <button disabled={!canOpenFile} onClick={() => { openFile(); setMenu(null); }}>
            Open File
          </button>
          <div className="ctx-menu-sep" />
          <button onClick={() => { void copyText(filePath); setMenu(null); }}>
            Copy Path
          </button>
          <button onClick={() => { void copyText(diff.path); setMenu(null); }}>
            Copy Relative Path
          </button>
          <button
            disabled={!canOpenFile}
            onClick={() => { void fsReveal(filePath); setMenu(null); }}
          >
            Reveal in Finder
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
