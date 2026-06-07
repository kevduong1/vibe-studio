/**
 * The CodeMirror side of LSP: one `lspExtension(...)` bundle per editor view
 * wiring document sync, diagnostics squiggles, hover tooltips, completions,
 * and go-to-definition to a WorkspaceLsp handle. Framework-free (no React) —
 * Editor.tsx mounts it through a Compartment so settings/status changes can
 * attach/detach it live.
 *
 * Coordinates: CM offsets ⇄ LSP {line, character} conversion happens HERE
 * and only here. CM line strings are JS strings, so per-line indices already
 * are UTF-16 code units — the conversion is exact, no surrogate math.
 */
import {
  autocompletion,
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { Extension, Text } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  hoverTooltip,
  keymap,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";

import { renderMarkdown, renderMarkup } from "./markdown";
import { isLspAbort, type WorkspaceLsp } from "./servers";
import {
  serverLangForPath,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspPosition,
  type LspRange,
  type LspTextChange,
} from "./types";

/** Per-file squiggle cap — beyond this the file is on fire anyway. */
const MAX_DIAGNOSTICS = 200;
const MAX_COMPLETIONS = 200;
const HOVER_TIME_MS = 300;

export interface LspEditorConfig {
  handle: WorkspaceLsp;
  /** Absolute file path (plain path, not URI). */
  path: string;
  /** Go-to-definition jump; line/column are 1-based UTF-16 — exactly what
      the editor store's reveal consumes. Editor.tsx routes workspaces. */
  openLocation: (absPath: string, line: number, column: number) => void;
}

// --- Position mapping --------------------------------------------------------

const offsetToLsp = (doc: Text, pos: number): LspPosition => {
  const line = doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
};

/** LSP position → CM offset, CLAMPED: async diagnostics may reference lines
    that no longer exist, and an out-of-range doc.line() throws inside CM's
    update cycle, killing the whole view. Clamping never crosses a newline. */
const lspPosToOffset = (doc: Text, p: LspPosition): number => {
  const line = doc.line(Math.max(1, Math.min(p.line + 1, doc.lines)));
  return Math.min(line.from + Math.max(0, p.character), line.to);
};

const lspRangeToCm = (doc: Text, r: LspRange): { from: number; to: number } => {
  const from = lspPosToOffset(doc, r.start);
  return { from, to: Math.max(from, lspPosToOffset(doc, r.end)) };
};

// --- Diagnostics ---------------------------------------------------------------

const SEVERITY: Record<number, Diagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

const mapDiagnostics = (doc: Text, diags: LspDiagnostic[]): Diagnostic[] =>
  // Copy (sort mutates — `diags` is the facade's stored array), order by
  // position, THEN cap: the cap keeps the file's FIRST diagnostics, not an
  // arbitrary slice of an out-of-order publish. No post-map sort needed —
  // @codemirror/lint orders internally (which also absorbs the rare clamping
  // tie at doc edges).
  [...diags]
    .sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    )
    .slice(0, MAX_DIAGNOSTICS)
    .map((d) => {
      const { from, to } = lspRangeToCm(doc, d.range);
      // DiagnosticTags (we declare tagSupport [1, 2]) render via markClass:
      // 1 Unnecessary fades, 2 Deprecated strikes through (rules in
      // lspTheme); both can apply at once.
      const tagClasses = [
        d.tags?.includes(1) ? "cm-lsp-unnecessary" : "",
        d.tags?.includes(2) ? "cm-lsp-deprecated" : "",
      ].filter(Boolean);
      return {
        from,
        to,
        severity: SEVERITY[d.severity ?? 1] ?? "error",
        message: d.message,
        source: d.source
          ? d.code != null
            ? `${d.source}(${d.code})`
            : d.source
          : undefined,
        markClass: tagClasses.length ? tagClasses.join(" ") : undefined,
      };
    });

// --- Completion kind mapping ---------------------------------------------------

/** LSP CompletionItemKind (1–25) → CM's built-in option icon types. */
const KIND_TO_TYPE: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "function", // constructor
  5: "property", // field
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace", // module
  10: "property",
  11: "constant", // unit
  12: "constant", // value
  13: "enum",
  14: "keyword",
  15: "text", // snippet (we declare snippetSupport: false)
  16: "constant", // color
  17: "text", // file
  18: "text", // reference
  19: "text", // folder
  20: "constant", // enum member
  21: "constant",
  22: "class", // struct
  23: "property", // event
  24: "keyword", // operator
  25: "type", // type parameter
};

/** Case-insensitive subsequence reject for completion lists. fuzzy.ts's
    matcher would run its scoring DP on every surviving item — wasted work
    here, where ordering comes from the server's sortText and only the
    boolean is needed. */
const isSubsequence = (queryLower: string, targetLower: string): boolean => {
  let qi = 0;
  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (targetLower.charCodeAt(ti) === queryLower.charCodeAt(qi)) qi++;
  }
  return qi === queryLower.length;
};

// --- Theme ---------------------------------------------------------------------

/** Module-level like Editor.tsx's editorTheme: EditorView.theme() mints a
    fresh StyleModule per call, and lspExtension runs on every mount, tab
    switch, and status recheck — built per-call, each injects another
    stylesheet into the document for the app's lifetime. Closes over nothing,
    so hoisting is free. */
const lspTheme = EditorView.theme({
  ".cm-lsp-hover": {
    maxWidth: "520px",
    maxHeight: "340px",
    overflow: "auto",
    padding: "10px 12px",
    userSelect: "text",
    fontSize: "12px",
    lineHeight: "1.55",
  },
  ".cm-lsp-hover > :first-child": { marginTop: "0" },
  ".cm-lsp-hover > :last-child": { marginBottom: "0" },
  ".cm-lsp-hover p": { margin: "6px 0", color: "var(--fg)" },
  // Full-bleed divider (negative margins span the padding) — pyright
  // separates signature from docs with a rule.
  ".cm-lsp-hover hr": {
    border: "none",
    borderTop: "1px solid var(--border-glass)",
    margin: "8px -12px",
  },
  // Fenced blocks (signatures) — shared by the hover AND the completion
  // docs panel (same renderer), so target the renderer's class directly.
  // Translucent lift + accent bar reads as a header on the glass surface.
  ".cm-lsp-md-code": {
    margin: "6px 0",
    padding: "6px 9px",
    borderRadius: "6px",
    background: "var(--bg-hover)",
    borderLeft: "2px solid var(--accent)",
    fontFamily: "var(--font-mono)",
    fontSize: "11.5px",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  },
  ".cm-lsp-hover code, .cm-completionInfo code": {
    fontFamily: "var(--font-mono)",
    fontSize: "11.5px",
    background: "var(--bg-hover)",
    padding: "1px 4px",
    borderRadius: "4px",
  },
  // DiagnosticTag marks (mapDiagnostics): plain opacity/line-through, no
  // colors — nothing to source from theme variables.
  ".cm-lsp-unnecessary": { opacity: "0.6" },
  ".cm-lsp-deprecated": { textDecoration: "line-through" },
});

// --- The extension bundle --------------------------------------------------------

export function lspExtension(config: LspEditorConfig): Extension {
  const { handle, path } = config;
  const lang = serverLangForPath(path);

  /** didOpen/didChange/didClose tied to the view (= compartment) lifecycle:
      settings toggles and tab unmounts produce correct open/close pairs for
      free. The view's doc at construction IS the draft-cache text, so the
      server always sees unsaved edits. */
  class LspDocSession {
    private unsubDiag: () => void;
    private destroyed = false;

    constructor(private view: EditorView) {
      handle.openDocument(path, () => this.view.state.doc.toString());
      this.unsubDiag = handle.onDiagnostics(path, (_p, diags) => {
        if (this.destroyed) return;
        this.view.dispatch(
          setDiagnostics(this.view.state, mapDiagnostics(this.view.state.doc, diags)),
        );
      });
      // Diagnostics published before this view attached (tab switch back).
      const existing = handle.diagnostics(path);
      if (existing.length) {
        queueMicrotask(() => {
          if (this.destroyed) return;
          this.view.dispatch(
            setDiagnostics(this.view.state, mapDiagnostics(this.view.state.doc, existing)),
          );
        });
      }
    }

    update(u: ViewUpdate) {
      if (!u.docChanged) return;
      const changes: LspTextChange[] = [];
      u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({
          range: {
            start: offsetToLsp(u.startState.doc, fromA),
            end: offsetToLsp(u.startState.doc, toA),
          },
          text: inserted.toString(),
        });
      });
      // LSP applies contentChanges sequentially, each against the doc the
      // previous change produced; iterChanges yields OLD-doc coordinates
      // ascending. Descending order keeps every old-doc range valid through
      // the sequence.
      changes.reverse();
      handle.changeDocument(path, changes);
    }

    destroy() {
      this.destroyed = true;
      // Unsubscribe FIRST: closeDocument publishes an empty set, and destroy
      // runs mid-update — dispatching from here would reenter CM.
      this.unsubDiag();
      handle.closeDocument(path);
    }
  }

  // --- Hover -------------------------------------------------------------------

  const hoverSource = async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    const doc = view.state.doc; // identity-captured for the stale guard
    const result = await handle.hover(path, offsetToLsp(doc, pos));
    // hoverTooltip won't drop a result computed against an older doc — we
    // must (the lint hover shows diagnostics separately; ours stacks below).
    if (!result || view.state.doc !== doc) return null;
    const dom = renderMarkdown(result.markdown);
    if (!dom.textContent?.trim()) return null;
    dom.className = "cm-lsp-hover";
    const range = result.range
      ? lspRangeToCm(doc, result.range)
      : { from: pos, to: pos };
    return {
      pos: range.from,
      end: range.to,
      above: true,
      create: () => ({ dom }),
    };
  };

  // --- Completion ----------------------------------------------------------------

  const completionSource = async (
    ctx: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(/[\w$]+/);
    const charBefore = ctx.pos > 0 ? ctx.state.sliceDoc(ctx.pos - 1, ctx.pos) : "";
    const isTrigger =
      !word && !!lang && handle.completionTriggers(lang).includes(charBefore);
    if (!ctx.explicit && !word && !isTrigger) return null;

    // Cancel superseded requests for real: CM aborts the context when a new
    // keystroke starts the next query, and the abort propagates to a
    // $/cancelRequest on the wire (client.ts). Hover/definition stay
    // uncancelled — low-rate; the facade forwards a signal when they need it.
    const ac = new AbortController();
    ctx.addEventListener("abort", () => ac.abort());
    let result: { isIncomplete: boolean; items: LspCompletionItem[] };
    try {
      result = await handle.completions(
        path,
        offsetToLsp(ctx.state.doc, ctx.pos),
        isTrigger
          ? { triggerKind: 2, triggerCharacter: charBefore }
          : { triggerKind: 1 },
        ac.signal,
      );
    } catch (err) {
      if (isLspAbort(err)) return null;
      throw err;
    }
    if (ctx.aborted || !result.items.length) return null;

    // Servers return the WHOLE symbol table in rough name order (tsserver/
    // pyright: 1500+ items), so capping the raw list would keep ~200 A–B
    // symbols and lose `console` for "cons". Order by server relevance
    // (sortText), drop items that can't match the typed word, THEN cap.
    let items = [...result.items].sort((a, b) => {
      const ka = a.sortText ?? a.label;
      const kb = b.sortText ?? b.label;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    if (word) {
      // LSP filters against filterText when present (label otherwise) —
      // tsserver uses it for e.g. bracket-notation property completions.
      const q = word.text.toLowerCase();
      items = items.filter((item) =>
        isSubsequence(q, (item.filterText ?? item.label).toLowerCase()),
      );
    }
    // An emptied-by-filter list must be null, NOT `{options: [], validFor}`:
    // CM caches a returned result against validFor, so backspacing within
    // the word would keep showing nothing instead of re-querying.
    if (!items.length) return null;
    const truncated = items.length > MAX_COMPLETIONS;
    if (truncated) items = items.slice(0, MAX_COMPLETIONS);

    const options = items.map((item): Completion => {
      const doc = item.documentation;
      const { textEdit } = item;
      return {
        label: item.label,
        detail: item.detail,
        type: item.kind !== undefined ? KIND_TO_TYPE[item.kind] : undefined,
        // Plain-text insertions only (snippetSupport: false). newText is
        // authored against textEdit.range, which may start LEFT of the
        // matched word (tsserver bracket-notation completions swallow the
        // dot: newText `["foo-bar"]`) — inserting it at the word start
        // would produce `obj.["foo-bar"]`, so honor the range start.
        apply: textEdit
          ? (view, completion, from, to) => {
              const cmDoc = view.state.doc;
              const { from: editFrom } = lspRangeToCm(cmDoc, textEdit.range);
              // Replace from the clamped range start through the CURRENT
              // word end (`to` — the user may have typed past the
              // request-time range end). A stale/bogus range clamps onto
              // some other line; extending the replacement there would eat
              // unrelated text — fall back to a plain word replace.
              const start =
                editFrom >= cmDoc.lineAt(from).from ? Math.min(editFrom, from) : from;
              view.dispatch({
                ...insertCompletionText(view.state, textEdit.newText, start, to),
                annotations: pickedCompletion.of(completion),
              });
            }
          : item.insertText ?? item.label,
        sortText: item.sortText,
        info: doc ? () => renderMarkup(doc) : undefined,
      };
    });
    return {
      from: word ? word.from : ctx.pos,
      options,
      // Client-side filtering while the user types is only sound for a
      // provably complete list: if the server said incomplete OR our cap cut
      // anything, CM must re-query per keystroke (each re-query re-filters
      // against the longer word, surfacing items the cap dropped).
      validFor: truncated || result.isIncomplete ? undefined : /^[\w$]*$/,
    };
  };

  // --- Go-to-definition -------------------------------------------------------------

  const gotoDefinition = async (view: EditorView, pos: number) => {
    const locations = await handle.definition(path, offsetToLsp(view.state.doc, pos));
    // Multi-target picker is out of scope for v1 — take the first.
    const target = locations[0];
    if (!target || !view.dom.isConnected) return;
    config.openLocation(
      target.path,
      target.range.start.line + 1,
      target.range.start.character + 1,
    );
  };

  return [
    ViewPlugin.define((view) => new LspDocSession(view)),
    hoverTooltip(hoverSource, { hoverTime: HOVER_TIME_MS }),
    // `override` replaces the languageData sources (lang-javascript /
    // lang-python local-scope completers) while attached — no double popup —
    // and basicSetup's own autocompletion() merges conflict-free (it passes
    // an empty config). When the compartment empties, the defaults return.
    autocompletion({ override: [completionSource] }),
    keymap.of([
      {
        key: "F12",
        run: (view) => {
          void gotoDefinition(view, view.state.selection.main.head);
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        if (!e.metaKey || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        void gotoDefinition(view, pos);
        return true; // suppress CM's selection handling
      },
    }),
    lspTheme,
  ];
}
