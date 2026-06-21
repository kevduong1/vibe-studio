/**
 * Diff tab content: side-by-side (MergeView) or unified (unifiedMergeView)
 * comparison of the old/new contents returned by git_diff_file. The new side
 * is editable (with Cmd-S save to the working tree) for worktree diffs.
 * Non-commit diffs refetch when the repo watcher reports changes; unsaved
 * edits are never clobbered (a warning banner offers an explicit reload).
 */
import { useEffect, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import type { Text } from "@codemirror/state";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import {
  gitDiffFile,
  fsWriteFile,
  onRepoChanged,
  type DiffPayload,
} from "../lib/ipc";
import { basename } from "../lib/path";
import { changeRuler } from "../lib/cmChangeRuler";
import type { Tab } from "../stores/editor";
import {
  BannerDismiss,
  editKeymap,
  editorTheme,
  languageFor,
  readOnlyExtension,
  type CmExtension,
} from "./Editor";
import { editorSearch } from "./EditorSearch";
import { IcRows, IcSplit } from "./icons";
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
  const { diff } = tab;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<DiffMode>(loadMode);
  const [data, setData] = useState<DiffData | null>(null);
  /** Mirror of `data` for the watcher refetch (avoids stale closures). */
  const dataRef = useRef<DiffData | null>(null);
  /** Last loaded/written new-side text. */
  const savedTextRef = useRef("");
  /** Live doc of the editable (b) side, kept fresh by an updateListener. */
  const bDocRef = useRef<Text | null>(null);
  /** Forced refetch wired up by the watcher effect (Reload button). */
  const refetchRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Diff changed on disk under unsaved b-side edits. */
  const [diskChanged, setDiskChanged] = useState(false);

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
        savedTextRef.current = payload.newText;
        applyData({ payload, lang });
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [tab.id, diff.repoPath, diff.path, diff.kind, diff.oid, diff.origPath]);

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
          payload.newText === savedTextRef.current
        )
          return;
        const edited =
          bDocRef.current !== null &&
          bDocRef.current.toString() !== savedTextRef.current;
        if (!force && edited) {
          setDiskChanged(true);
          return;
        }
        savedTextRef.current = payload.newText;
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
    if (payload.binary || payload.oldText === payload.newText) return;
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
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
    const savePath = `${diff.repoPath}/${diff.path}`;
    // Track the b side's doc so refetches can tell unsaved edits apart.
    const trackDoc = EditorView.updateListener.of((u) => {
      if (u.docChanged) bDocRef.current = u.state.doc;
    });
    const save = (v: EditorView) => {
      const docText = v.state.doc.toString();
      // The repo watcher picks up the write and refreshes git status.
      void fsWriteFile(savePath, docText)
        .then(() => {
          if (disposed) return;
          savedTextRef.current = docText;
          setSaveError(null);
          setDiskChanged(false);
        })
        .catch((e) => {
          if (!disposed) setSaveError(String(e));
        });
    };
    const newSideExts = editable
      ? [...shared, trackDoc, editKeymap(save)]
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
    }

    return () => {
      disposed = true;
      bDocRef.current = null;
      mergeView?.destroy();
      unifiedView?.destroy();
    };
  }, [data, mode, diff.kind, diff.repoPath, diff.path]);

  const toggleMode = () => {
    setMode((m) => {
      const next: DiffMode = m === "split" ? "unified" : "split";
      localStorage.setItem(MODE_KEY, next);
      return next;
    });
  };

  const payload = data?.payload ?? null;

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
          <BannerDismiss onClick={() => setDiskChanged(false)} />
        </div>
      )}
      {saveError && (
        <div className="editor-banner danger">
          <span className="truncate">Save failed: {saveError}</span>
          <BannerDismiss onClick={() => setSaveError(null)} />
        </div>
      )}
      <div className="diff-body">
        {error ? (
          <div className="editor-msg danger">{error}</div>
        ) : !data ? (
          <div className="editor-msg dim">Loading…</div>
        ) : data.payload.binary ? (
          <div className="editor-msg">Binary file</div>
        ) : data.payload.oldText === data.payload.newText ? (
          <div className="editor-msg dim">No changes</div>
        ) : (
          <div ref={hostRef} className="diff-host" />
        )}
      </div>
    </div>
  );
}
