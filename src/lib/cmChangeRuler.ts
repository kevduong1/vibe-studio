/**
 * Overview ruler: colored blips overlaid on the editor's vertical scrollbar
 * marking where changes are (additions green, deletions red, modifications
 * blue) — VS Code style. One ViewPlugin, two mark sources:
 *   - "merge": derives marks from @codemirror/merge's chunks; works in both
 *     MergeView sides and the unified view (getChunks self-detects the side).
 *   - "field": marks pushed in via setRulerMarks (the plain file editor
 *     diffs its live doc against the git HEAD baseline — see
 *     computeRulerMarks and the glue in Editor.tsx).
 * The track maps the WHOLE document and doubles as a scrubber: pointer
 * down/drag jumps the view to the grabbed spot (the native thumb beneath
 * stays visible as the viewport indicator). Blip positions go through the
 * height map (lineBlockAt), NOT line-number proportions — collapseUnchanged
 * regions and deleted-chunk widgets would skew naive math badly. Styling
 * lives in EditorArea.css (.cm-change-ruler).
 */
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { Chunk, getChunks } from "@codemirror/merge";

export type RulerKind = "add" | "del" | "mod";

/** A changed range in the host editor's own doc. `from === to` is a
    zero-length "tick": a deletion point on the new side (or an insertion
    point on the old side), rendered at the minimum blip height. */
export interface RulerMark {
  from: number;
  to: number;
  kind: RulerKind;
}

/** Push externally computed marks (plain-editor git diff) into the ruler. */
export const setRulerMarks = StateEffect.define<readonly RulerMark[]>();

const rulerMarks = StateField.define<readonly RulerMark[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRulerMarks)) value = e.value;
    return value;
  },
});

/** Classify merge chunks into marks for the editor showing `side`
    ("a" = old text; "b"/null = new text — also the plain editor's case). */
export function marksFromChunks(
  chunks: readonly Chunk[],
  side: "a" | "b" | null,
  doc: Text,
): RulerMark[] {
  return chunks.map((c) => {
    const inserted = c.fromA === c.toA; // no old lines -> pure insertion
    const deleted = c.fromB === c.toB; // no new lines -> pure deletion
    const kind: RulerKind = inserted ? "add" : deleted ? "del" : "mod";
    // endA/endB clamp merge's one-past-the-end to positions; clamp once more
    // because field marks can briefly outlive a doc shrink between rediffs.
    const [from, to] =
      side === "a"
        ? [c.fromA, inserted ? c.fromA : c.endA]
        : [c.fromB, deleted ? c.fromB : c.endB];
    return { from: Math.min(from, doc.length), to: Math.min(to, doc.length), kind };
  });
}

/** Diff a baseline (e.g. the git index/HEAD text) against the live doc.
    scanLimit matches @codemirror/merge's own default for view diffs. */
export function computeRulerMarks(baseline: Text, doc: Text): RulerMark[] {
  return marksFromChunks(Chunk.build(baseline, doc, { scanLimit: 500 }), "b", doc);
}

/** Smallest rendered blip so single-line changes stay visible. */
const MIN_BLIP_PX = 3;

interface BlipGeom {
  kind: RulerKind;
  top: number;
  bottom: number;
}
interface Measured {
  total: number;
  track: number;
  blips: BlipGeom[];
}

const rulerPlugin = (source: "field" | "merge") =>
  ViewPlugin.fromClass(
    class {
      private readonly ruler: HTMLDivElement;
      private marks: readonly RulerMark[] = [];
      /** Last chunk set seen (merge source); identity skips rebuilds. */
      private chunks: readonly Chunk[] | null = null;

      private readonly measure = {
        // Read phase: positions via the height map; no DOM writes here.
        read: (view: EditorView): Measured => {
          const total = view.scrollDOM.scrollHeight;
          const track = view.scrollDOM.clientHeight;
          const pad = view.documentPadding.top;
          const docLen = view.state.doc.length;
          const blips = this.marks.map((m) => {
            const from = Math.min(m.from, docLen);
            const top = pad + view.lineBlockAt(from).top;
            const bottom =
              m.to <= m.from
                ? top
                : pad + view.lineBlockAt(Math.min(m.to, docLen)).bottom;
            return { kind: m.kind, top, bottom };
          });
          return { total, track, blips };
        },
        write: (m: Measured) => this.render(m),
      };

      private readonly view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.ruler = document.createElement("div");
        this.ruler.className = "cm-change-ruler";
        this.ruler.setAttribute("aria-hidden", "true");
        this.ruler.addEventListener("pointerdown", this.onPointerDown);
        this.ruler.addEventListener("pointermove", this.onPointerMove);
        this.ruler.addEventListener("wheel", this.onWheel, { passive: false });
        view.dom.appendChild(this.ruler);
        this.readMarks(view.state);
        view.requestMeasure(this.measure);
      }

      // ----- scrubbing: the ruler replaces the native track interaction -----

      private readonly onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault(); // keep editor focus/selection intact
        this.ruler.setPointerCapture(e.pointerId);
        this.scrubTo(e.clientY);
      };

      private readonly onPointerMove = (e: PointerEvent) => {
        if (e.buttons & 1 && this.ruler.hasPointerCapture(e.pointerId))
          this.scrubTo(e.clientY);
      };

      /** The ruler is a sibling of the scroller, so wheels over it would
          otherwise scroll nothing. */
      private readonly onWheel = (e: WheelEvent) => {
        this.view.scrollDOM.scrollTop += e.deltaY;
        e.preventDefault();
      };

      /** Center the viewport on the grabbed track fraction (absolute jump,
          like a minimap — not the native thumb's relative drag). */
      private scrubTo(clientY: number) {
        const rect = this.ruler.getBoundingClientRect();
        if (!rect.height) return;
        const frac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        const sd = this.view.scrollDOM;
        sd.scrollTop = frac * sd.scrollHeight - sd.clientHeight / 2;
      }

      update(u: ViewUpdate) {
        const changed = this.readMarks(u.state);
        if (changed || u.docChanged || u.geometryChanged)
          u.view.requestMeasure(this.measure);
      }

      destroy() {
        this.ruler.remove();
      }

      /** Refresh marks from the source; true when they changed. */
      private readMarks(state: EditorState): boolean {
        if (source === "field") {
          const next = state.field(rulerMarks);
          if (next === this.marks) return false;
          this.marks = next;
          return true;
        }
        // getChunks is null until the merge view finishes initializing; the
        // merge extension dispatches an update once chunks exist.
        const c = getChunks(state);
        const chunks = c?.chunks ?? null;
        if (chunks === this.chunks) return false;
        this.chunks = chunks;
        this.marks = chunks ? marksFromChunks(chunks, c!.side, state.doc) : [];
        return true;
      }

      private render({ total, track, blips }: Measured) {
        this.ruler.textContent = ""; // drop previous blips
        if (!total || !track) return;
        const scale = track / total;
        for (const b of blips) {
          const el = document.createElement("div");
          el.className = `cm-change-ruler-blip ${b.kind}`;
          const height = Math.max(MIN_BLIP_PX, (b.bottom - b.top) * scale);
          const top = Math.max(0, Math.min(b.top * scale, track - height));
          el.style.top = `${top}px`;
          el.style.height = `${height}px`;
          this.ruler.appendChild(el);
        }
      }
    },
  );

// Shared instances so a double inclusion dedupes instead of stacking rulers.
const fieldPlugin = rulerPlugin("field");
const mergePlugin = rulerPlugin("merge");

/** The ruler extension. "field" reads setRulerMarks dispatches (plain
    editor); "merge" follows @codemirror/merge's chunks (diff views). */
export function changeRuler(source: "field" | "merge"): Extension {
  return source === "field" ? [rulerMarks, fieldPlugin] : mergePlugin;
}
