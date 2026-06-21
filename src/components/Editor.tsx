/**
 * Single-file CodeMirror editor for a "file" tab, plus the shared CodeMirror
 * helpers (theme, language loader, read-only / editing extensions, banner
 * dismiss button) that DiffViewer reuses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, Text, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { languages } from "@codemirror/language-data";
import { fsReadFile, fsWriteFile, gitDiffFile, onRepoChanged } from "../lib/ipc";
import { changeRuler, computeRulerMarks, setRulerMarks } from "../lib/cmChangeRuler";
import { lspExtension } from "../lib/lsp/cmLsp";
import { getLspForFile, subscribeLspStatus, type WorkspaceLsp } from "../lib/lsp/servers";
import { subscribeLspSettings } from "../lib/lsp/settings";
import type { Tab } from "../stores/editor";
import {
  useEditor,
  useWorkspace,
  useWorkspacesStore,
} from "../stores/workspaces";
import { editorSearch } from "./EditorSearch";
import { IcClose } from "./icons";
import "./EditorArea.css";

type FileTab = Extract<Tab, { kind: "file" }>;

export type CmExtension = Extension;

/** Debounce for re-reading the file after a repo watcher event. */
const DISK_CHECK_DEBOUNCE_MS = 300;

/** Debounce for rediffing the doc against the git baseline while typing. */
const RULER_RECOMPUTE_MS = 250;

// ---------------------------------------------------------------------------
// Shared theme
// ---------------------------------------------------------------------------

/** oneDark blended into the app's editor background + UI mono font. */
export const editorTheme: CmExtension = [
  oneDark,
  EditorView.theme(
    {
      "&": { backgroundColor: "var(--bg-editor)", fontSize: "12.5px" },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
      },
      ".cm-gutters": { backgroundColor: "var(--bg-editor)" },
      // Glass chrome for every editor popover (LSP/lint hovers, autocomplete,
      // completion docs) — overrides oneDark's flat gray boxes. Translucent
      // surface + blur needs the -webkit- prefix (build target is safari16;
      // unprefixed backdrop-filter is 18+).
      ".cm-tooltip": {
        backgroundColor: "var(--bg-glass)",
        backdropFilter: "blur(16px) saturate(140%)",
        "-webkit-backdrop-filter": "blur(16px) saturate(140%)",
        border: "1px solid var(--border-glass)",
        borderRadius: "8px",
        boxShadow: "0 8px 28px rgba(0, 0, 0, 0.45)",
        color: "var(--fg)",
      },
      // Clip only hover tooltips to the rounded corners: the autocomplete
      // tooltip positions its .cm-completionInfo docs panel OUTSIDE its own
      // bounds, so overflow:hidden there would amputate it.
      ".cm-tooltip.cm-tooltip-hover": { overflow: "hidden" },
      ".cm-tooltip-section:not(:first-child)": {
        borderTop: "1px solid var(--border-glass)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete": { padding: "3px" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        borderRadius: "5px",
        padding: "2px 6px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        background: "var(--bg-selected)",
        color: "var(--fg)",
      },
      ".cm-completionInfo": { padding: "8px 10px", maxWidth: "400px" },
      ".cm-diagnostic": { padding: "5px 9px", borderLeftWidth: "3px" },
    },
    { dark: true },
  ),
];

// ---------------------------------------------------------------------------
// Shared language loader
// ---------------------------------------------------------------------------

/** Resolve + lazily load the language support for a file path, or null. */
export async function languageFor(path: string): Promise<CmExtension | null> {
  const filename = path.split("/").pop() ?? path;
  const desc = LanguageDescription.matchFilename(languages, filename);
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared editing extensions
// ---------------------------------------------------------------------------

/** Full read-only: not editable and readOnly facet set. */
export const readOnlyExtension: CmExtension = [
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
];

/** Tab indents instead of moving focus; Mod-s runs `onSave`. */
export function editKeymap(onSave: (view: EditorView) => void): CmExtension {
  return keymap.of([
    indentWithTab,
    {
      key: "Mod-s",
      preventDefault: true,
      run: (v) => {
        onSave(v);
        return true;
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Shared banner dismiss button
// ---------------------------------------------------------------------------

export function BannerDismiss({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn banner-dismiss" title="Dismiss" onClick={onClick}>
      <IcClose />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Draft cache: unsaved text survives tab switches (views unmount per tab)
// ---------------------------------------------------------------------------

const draftCache = new Map<string, { text: string | Text; savedText: string | Text }>();

// Keys are namespaced per workspace: with nested repos the same absolute file
// can be open in two workspaces (identical tab id), and sharing one slot
// would leak unsaved edits across them. NUL never appears in paths.
const draftKeyFor = (wsPath: string, tabId: string) => `${wsPath}\0${tabId}`;

// Drop drafts whose tab was closed (or whose whole workspace was closed).
const pruneDrafts = () => {
  const { workspaces } = useWorkspacesStore.getState();
  for (const key of [...draftCache.keys()]) {
    const sep = key.indexOf("\0");
    const wsPath = key.slice(0, sep);
    const tabId = key.slice(sep + 1);
    const ws = workspaces.find((w) => w.path === wsPath);
    if (!ws || !ws.editor.getState().tabs.some((t) => t.id === tabId)) {
      draftCache.delete(key);
    }
  }
};

/** Latest unsaved text for a tab, if any — the markdown preview renders the
    live draft rather than stale disk content. */
export function peekDraft(wsPath: string, tabId: string): string | null {
  const draft = draftCache.get(draftKeyFor(wsPath, tabId));
  return draft ? draft.text.toString() : null;
}

// Subscribe each workspace's editor store (incl. ones created later) to the
// pruner. Closed workspaces' subscriptions die with their stores.
const prunerWired = new WeakSet<object>();
const wirePruner = (state: ReturnType<typeof useWorkspacesStore.getState>) => {
  for (const w of state.workspaces) {
    if (!prunerWired.has(w.editor)) {
      prunerWired.add(w.editor);
      w.editor.subscribe(pruneDrafts);
    }
  }
};
wirePruner(useWorkspacesStore.getState());
useWorkspacesStore.subscribe((s) => {
  pruneDrafts(); // a workspace itself may have closed
  wirePruner(s);
});

// ---------------------------------------------------------------------------
// Editor component
// ---------------------------------------------------------------------------

export default function Editor({ tab }: { tab: FileTab }) {
  const ws = useWorkspace();
  const markDirty = useEditor((s) => s.markDirty);
  const reveal = useEditor((s) => s.reveal);
  const draftKey = draftKeyFor(ws.path, tab.id);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Last loaded/saved content as a CodeMirror Text (no toString per keystroke). */
  const savedRef = useRef<Text>(Text.empty);
  const [loading, setLoading] = useState(true);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Disk changed under a dirty buffer; saving would overwrite it. */
  const [diskChanged, setDiskChanged] = useState(false);
  /** Mod-s found the file changed on disk; waiting for explicit Overwrite. */
  const [saveConflict, setSaveConflict] = useState(false);

  /** Write the buffer out; unless `force`, refuse when the disk changed. */
  const save = useCallback(
    async (view: EditorView, force: boolean) => {
      const doc = view.state.doc;
      try {
        if (!force) {
          let onDisk: string | null = null;
          try {
            const file = await fsReadFile(tab.path);
            if (!file.binary) onDisk = file.text;
          } catch {
            // unreadable / deleted on disk — writing recreates it
          }
          if (viewRef.current !== view) return;
          if (onDisk !== null && onDisk !== savedRef.current.toString()) {
            setSaveConflict(true);
            return;
          }
        }
        await fsWriteFile(tab.path, doc.toString());
        if (viewRef.current !== view) return;
        savedRef.current = doc;
        const now = view.state.doc;
        const dirty = !now.eq(doc);
        if (dirty) draftCache.set(draftKey, { text: now, savedText: doc });
        else draftCache.delete(draftKey);
        markDirty(tab.id, dirty);
        setSaveError(null);
        setSaveConflict(false);
        setDiskChanged(false);
      } catch (e) {
        if (viewRef.current === view) setSaveError(String(e));
      }
    },
    [tab.id, tab.path, draftKey, markDirty],
  );

  /** Go-to-definition jump target. Longest-prefix match over open workspaces
      so nested repos resolve to the inner one; files outside every root
      (node_modules/*.d.ts) open in the current workspace — openFile and
      fsReadFile take any absolute path. */
  const openLocation = useCallback(
    (absPath: string, line: number, column: number) => {
      const { workspaces, activePath, setActive } = useWorkspacesStore.getState();
      const owner = workspaces
        .filter((w) => absPath === w.path || absPath.startsWith(`${w.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      const target = owner ?? ws;
      if (target.path !== activePath) setActive(target.path);
      target.editor.getState().openFile(absPath, { line, column });
    },
    [ws],
  );

  /** Move the cursor to line/column (1-based, UTF-16 cols — what CodeMirror
      positions use) and scroll it to the vertical center, clamping both. */
  const revealTo = useCallback((line: number, column: number) => {
    const v = viewRef.current;
    if (!v) return;
    const ln = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
    const pos = Math.min(ln.from + Math.max(0, column - 1), ln.to);
    v.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    v.focus();
  }, []);

  // Reveal on an ALREADY-open tab (e.g. a second search hit in the same
  // file). Pre-view reveals no-op here — the load effect below consumes
  // them once the view exists. clearReveal is nonce-gated, so whichever
  // consumer fires first wins and the other (StrictMode reruns included)
  // is a no-op.
  useEffect(() => {
    if (!reveal || reveal.tabId !== tab.id || !viewRef.current) return;
    revealTo(reveal.line, reveal.column);
    ws.editor.getState().clearReveal(reveal.nonce);
  }, [reveal, tab.id, revealTo, ws.editor]);

  /** Replace the buffer with the on-disk content and mark it clean. */
  const reloadFromDisk = useCallback(async () => {
    try {
      const file = await fsReadFile(tab.path);
      const view = viewRef.current;
      if (!view || file.binary) return;
      // Update `saved` first so the updateListener sees a clean buffer.
      const fresh = view.state.toText(file.text);
      savedRef.current = fresh;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: fresh },
      });
      draftCache.delete(draftKey);
      markDirty(tab.id, false);
      setDiskChanged(false);
      setSaveConflict(false);
    } catch {
      // mid-write / deleted — keep the banner so the user can retry
    }
  }, [tab.id, tab.path, draftKey, markDirty]);

  useEffect(() => {
    let disposed = false;
    let view: EditorView | null = null;
    let unlistenRepo: (() => void) | null = null;
    let unsubLspSettings: (() => void) | null = null;
    let unsubLspStatus: (() => void) | null = null;
    let diskTimer: ReturnType<typeof setTimeout> | null = null;
    let rulerTimer: ReturnType<typeof setTimeout> | null = null;
    /** Git HEAD content for the overview ruler; null = no ruler. */
    let rulerBaseline: Text | null = null;
    /** Whether the view currently holds non-empty ruler marks. */
    let rulerActive = false;
    setLoading(true);
    setBinary(false);
    setTruncated(false);
    setLoadError(null);
    setSaveError(null);
    setDiskChanged(false);
    setSaveConflict(false);

    // After a watcher event: silently reload when the buffer is clean,
    // warn when it is dirty (rare path — toString is fine here).
    const checkDisk = async () => {
      try {
        const file = await fsReadFile(tab.path);
        const v = viewRef.current;
        if (disposed || !v || file.binary) return;
        if (file.text === savedRef.current.toString()) return; // our own write
        if (v.state.doc.eq(savedRef.current)) {
          const fresh = v.state.toText(file.text);
          savedRef.current = fresh;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: fresh },
          });
          setDiskChanged(false);
        } else {
          setDiskChanged(true);
        }
      } catch {
        // mid-write / deleted — the next event (or a save) will sort it out
      }
    };

    // ----- overview ruler (scrollbar change blips vs git HEAD) -----
    // Files outside the workspace (go-to-def into node_modules) get no ruler.
    const rulerRelPath = tab.path.startsWith(`${ws.path}/`)
      ? tab.path.slice(ws.path.length + 1)
      : null;

    /** Rediff the LIVE doc against the baseline so blips track unsaved edits. */
    const recomputeRuler = () => {
      const v = viewRef.current;
      if (disposed || !v) return;
      const marks = rulerBaseline ? computeRulerMarks(rulerBaseline, v.state.doc) : [];
      if (!marks.length && !rulerActive) return; // nothing shown, nothing to clear
      rulerActive = marks.length > 0;
      v.dispatch({ effects: setRulerMarks.of(marks) });
    };

    /** (Re)fetch the HEAD text — on mount and after repo events, so commits
        and discards move the baseline. Baseline is HEAD (the "staged" diff
        kind's old side), NOT the index: blips must cover ALL uncommitted
        changes — an index baseline blanks the ruler the moment a file is
        staged. */
    const refreshRulerBaseline = async () => {
      if (!rulerRelPath) return;
      try {
        const status = ws.repo.getState().status;
        const entry = [...(status?.staged ?? []), ...(status?.unstaged ?? [])].find(
          (f) => f.path === rulerRelPath,
        );
        if (entry?.status === "?") {
          rulerBaseline = null; // untracked: an all-green ruler is just noise
        } else {
          const payload = await gitDiffFile(
            ws.path,
            rulerRelPath,
            "staged",
            undefined,
            entry?.origPath,
          );
          if (disposed) return;
          // Not in HEAD with no pending status = not tracked (ignored file).
          rulerBaseline =
            payload.binary || (!entry && payload.oldText === "")
              ? null
              : Text.of(payload.oldText.split(/\r\n?|\n/));
        }
      } catch {
        rulerBaseline = null; // outside a repo / mid-change — no blips
      }
      recomputeRuler();
    };

    (async () => {
      let doc: string | Text;
      let savedDoc: string | Text;
      let isTruncated = false;

      const cached = draftCache.get(draftKey);
      if (cached) {
        doc = cached.text;
        savedDoc = cached.savedText;
      } else {
        const file = await fsReadFile(tab.path);
        if (disposed) return;
        if (file.binary) {
          setBinary(true);
          setLoading(false);
          return;
        }
        doc = file.text;
        savedDoc = file.text;
        isTruncated = file.truncated;
      }

      const lang = await languageFor(tab.path);
      if (disposed) return;
      setTruncated(isTruncated);

      // LSP attaches through a compartment so settings toggles and server
      // status changes (binary installed, crash) attach/detach it live —
      // the doc session plugin's constructor/destroy are the didOpen/
      // didClose pair. Truncated buffers never attach (the server would see
      // garbage). DiffViewer deliberately has NO LSP: its worktree side is a
      // synthetic buffer that would fight this tab over the same document.
      const lspCompartment = new Compartment();
      let lspHandle: WorkspaceLsp | null = isTruncated
        ? null
        : getLspForFile(ws.path, tab.path);
      const lspExt = () =>
        lspHandle
          ? lspExtension({ handle: lspHandle, path: tab.path, openLocation })
          : [];

      const extensions: CmExtension[] = [
        basicSetup,
        editorTheme,
        editorSearch,
        lang ?? [],
        lspCompartment.of(lspExt()),
        changeRuler("field"),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const dirty = !u.state.doc.eq(savedRef.current);
          if (dirty)
            draftCache.set(draftKey, { text: u.state.doc, savedText: savedRef.current });
          else draftCache.delete(draftKey);
          markDirty(tab.id, dirty);
          // Keep the ruler blips tracking the buffer (debounced rediff).
          if (rulerTimer) clearTimeout(rulerTimer);
          rulerTimer = setTimeout(recomputeRuler, RULER_RECOMPUTE_MS);
        }),
        isTruncated
          ? readOnlyExtension
          : editKeymap((v) => void save(v, false)),
      ];

      view = new EditorView({ doc, extensions, parent: hostRef.current! });
      viewRef.current = view;
      savedRef.current =
        typeof savedDoc === "string" ? view.state.toText(savedDoc) : savedDoc;
      setLoading(false);
      void refreshRulerBaseline();

      // Consume a reveal requested before the view existed (fresh open from
      // a search result / quick open with a target line).
      const req = ws.editor.getState().reveal;
      if (req && req.tabId === tab.id) {
        revealTo(req.line, req.column);
        ws.editor.getState().clearReveal(req.nonce);
      }

      // Re-evaluate LSP attachment when settings toggle or a server's status
      // changes (binary found after install, crash, restart). Detaching
      // must also clear squiggles: the lint state field was installed by
      // setDiagnostics OUTSIDE the compartment and survives reconfiguration
      // (and the plugin's destroy runs mid-update, so it can't clear them).
      const recheckLsp = () => {
        const v = viewRef.current;
        if (disposed || !v) return;
        const next = isTruncated ? null : getLspForFile(ws.path, tab.path);
        if (next === lspHandle) return;
        lspHandle = next;
        v.dispatch({ effects: lspCompartment.reconfigure(lspExt()) });
        if (!next) v.dispatch(setDiagnostics(v.state, []));
      };
      unsubLspSettings = subscribeLspSettings(recheckLsp);
      unsubLspStatus = subscribeLspStatus(recheckLsp);

      // Watch for external modifications (debounced — events arrive in bursts).
      // Events arrive for every open workspace; only the repo containing this
      // file can have changed it. (A clean-buffer auto-reload dispatches a
      // whole-doc replace, which flows through the LSP plugin's update() as
      // one didChange — the server stays in sync with no extra wiring.)
      const unlisten = await onRepoChanged((change) => {
        if (disposed || !tab.path.startsWith(`${change.repoPath}/`)) return;
        if (diskTimer) clearTimeout(diskTimer);
        diskTimer = setTimeout(() => {
          void checkDisk();
          void refreshRulerBaseline();
        }, DISK_CHECK_DEBOUNCE_MS);
      });
      if (disposed) unlisten();
      else unlistenRepo = unlisten;
    })().catch((e) => {
      if (!disposed) {
        setLoadError(String(e));
        setLoading(false);
      }
    });

    return () => {
      disposed = true;
      if (diskTimer) clearTimeout(diskTimer);
      if (rulerTimer) clearTimeout(rulerTimer);
      unlistenRepo?.();
      unsubLspSettings?.();
      unsubLspStatus?.();
      viewRef.current = null;
      // destroy() runs the LSP plugin's destroy → didClose; never close the
      // document anywhere else (a second close would desync the server's
      // open-document set on StrictMode remounts).
      view?.destroy();
    };
  }, [tab.id, tab.path, draftKey, markDirty, save, revealTo, openLocation, ws.editor, ws.path]);

  return (
    <div className="editor-pane">
      {truncated && (
        <div className="editor-banner warning">
          File truncated (&gt;5 MB) — read-only
        </div>
      )}
      {diskChanged && !saveConflict && (
        <div className="editor-banner warning">
          <span className="truncate">
            File changed on disk — saving will overwrite it
          </span>
          <button className="banner-action" onClick={() => void reloadFromDisk()}>
            Reload
          </button>
          <BannerDismiss onClick={() => setDiskChanged(false)} />
        </div>
      )}
      {saveConflict && (
        <div className="editor-banner danger">
          <span className="truncate">
            File changed on disk since it was loaded — overwrite it?
          </span>
          <button
            className="banner-action"
            onClick={() => {
              const v = viewRef.current;
              if (v) void save(v, true);
            }}
          >
            Overwrite
          </button>
          <BannerDismiss onClick={() => setSaveConflict(false)} />
        </div>
      )}
      {saveError && (
        <div className="editor-banner danger">
          <span className="truncate">Save failed: {saveError}</span>
          <BannerDismiss onClick={() => setSaveError(null)} />
        </div>
      )}
      {binary ? (
        <div className="editor-msg">Binary file not shown</div>
      ) : loadError ? (
        <div className="editor-msg danger">{loadError}</div>
      ) : (
        <div ref={hostRef} className="editor-host" />
      )}
      {loading && !binary && !loadError && (
        <div className="editor-loading">Loading…</div>
      )}
    </div>
  );
}
