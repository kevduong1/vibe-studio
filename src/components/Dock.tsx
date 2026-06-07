/**
 * Generic dockable terminal grid — the shared UI for both bottom-panel
 * groups (each workspace's terminal dock and the global agent dock). Renders
 * the lib/dockTree layout (splits with drag-resizers; leaf groups with their
 * own tab strips), and owns drag-and-drop: drag a tab onto a strip to move
 * it (insertion caret), onto a group body's center to merge, or onto a body
 * edge to split in that axis (half-pane overlay). Tabs rename inline on
 * double-click.
 *
 * Terminal-flavor specifics (pane contents, tab glyphs, click side-effects,
 * close glue) are injected via props — see AgentDock / TerminalPanel.
 *
 * DnD is pointer-capture based (no HTML5 DnD — unreliable in WKWebView): the
 * source tab captures the pointer, every move hit-tests via elementFromPoint
 * against [data-dock-strip]/[data-dock-body] markers, and all drag chrome
 * (ghost chip, caret, zone overlay) is pointer-events:none so it never
 * poisons the hit test. Pane hosts survive drops because their sessions live
 * in the lib/termSessions registry, not in the React tree.
 */
import {
  Fragment,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useStore, type StoreApi } from "zustand";
import {
  findSplit,
  type DockGroup,
  type DockNode,
  type DockSplit,
  type DockState,
  type DockTerminalBase,
  type DropEdge,
} from "../lib/dockTree";
import { getSession } from "../lib/termSessions";
import { Resizer } from "./Resizer";
import { IcClose } from "./icons";
import "./Dock.css";

/** What the Dock needs from its zustand store (both docks satisfy this). */
export interface DockStoreState<T extends DockTerminalBase>
  extends DockState<T> {
  setActiveTerminal: (groupId: string, terminalId: string) => void;
  setActiveGroup: (groupId: string) => void;
  renameTerminal: (id: string, title: string) => void;
  moveTerminal: (terminalId: string, targetGroupId: string, index: number) => void;
  splitGroup: (terminalId: string, targetGroupId: string, edge: DropEdge) => void;
  setSplitSizes: (splitId: string, sizes: number[]) => void;
}

export interface DockPaneProps<T extends DockTerminalBase> {
  terminal: T;
  groupId: string;
  visible: boolean;
  /** Active tab of the dock's active group. */
  focused: boolean;
}

export interface DockProps<
  T extends DockTerminalBase,
  S extends DockStoreState<T>,
> {
  store: StoreApi<S>;
  /** One terminal's live pane (session attach + flavor extras). */
  Pane: ComponentType<DockPaneProps<T>>;
  /** Tab glyph (activity-aware for agent tabs, plain icon otherwise). */
  TabIcon: ComponentType<{ terminal: T }>;
  /** Optional glyph after the icon (e.g. disconnected ⊘). */
  TabBadge?: ComponentType<{ terminal: T }>;
  /** Rendered when the dock has no terminals. */
  Empty: ComponentType;
  /** Tab tooltip (defaults to the title). */
  tabTooltip?: (terminal: T) => string;
  /** Title fallback when a rename commits empty (defaults to "keep old"). */
  defaultTitle?: (terminal: T) => string;
  /** Extra tab/pane mousedown behavior (agent: switch to the project). */
  onSelectTerminal?: (terminal: T) => void;
  /** Right-click on a tab (suppressed while its inline rename is open);
   *  preventDefault is the handler's job. */
  onTabContextMenu?: (terminal: T, e: React.MouseEvent) => void;
  /** Close glue: must dispose the session BEFORE the structural removal. */
  closeTerminal: (id: string) => void;
}

type DropTarget =
  | { kind: "strip"; groupId: string; index: number; caretLeft: number }
  | { kind: "body"; groupId: string; zone: DropEdge | "center" };

interface Dnd {
  dropTarget: DropTarget | null;
  beginDrag: (
    e: React.PointerEvent,
    terminalId: string,
    sourceGroupId: string,
  ) => void;
}

/** Everything the recursive views need, threaded as one object. */
interface DockCtx<T extends DockTerminalBase, S extends DockStoreState<T>>
  extends DockProps<T, S> {
  dnd: Dnd;
}

const DRAG_THRESHOLD_PX = 4;
/** Fraction of a group body's width/height that reads as an edge drop. */
const EDGE_BAND = 0.2;

const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.groupId !== b.groupId) return false;
  return a.kind === "strip"
    ? a.index === (b as { index: number }).index
    : a.zone === (b as { zone: string }).zone;
};

// ---------------------------------------------------------------------------
// Tab (with inline double-click rename)
// ---------------------------------------------------------------------------

function DockTab<T extends DockTerminalBase, S extends DockStoreState<T>>({
  terminal,
  group,
  ctx,
}: {
  terminal: T;
  group: DockGroup;
  ctx: DockCtx<T, S>;
}) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const active = group.activeTerminalId === terminal.id;

  const commit = (value: string) => {
    const title = value.trim() || ctx.defaultTitle?.(terminal) || terminal.title;
    ctx.store.getState().renameTerminal(terminal.id, title);
    setEditing(false);
  };

  return (
    <div
      className={`dock-tab ${active ? "active" : ""}`}
      data-dock-tab
      title={ctx.tabTooltip?.(terminal) ?? terminal.title}
      onPointerDown={(e) => {
        if (!editing) ctx.dnd.beginDrag(e, terminal.id, group.id);
      }}
      onMouseDown={(e) => {
        if (e.button !== 0 || editing) return;
        ctx.store.getState().setActiveTerminal(group.id, terminal.id);
        ctx.onSelectTerminal?.(terminal);
      }}
      onDoubleClick={() => {
        if (!editing) {
          cancelled.current = false;
          setEditing(true);
        }
      }}
      // While renaming, right-clicks stay on the input's native menu (the
      // contextmenu event bubbles out of the input — it only stops
      // pointer/mouse/dblclick).
      onContextMenu={(e) => {
        if (!editing) ctx.onTabContextMenu?.(terminal, e);
      }}
    >
      <ctx.TabIcon terminal={terminal} />
      {ctx.TabBadge && <ctx.TabBadge terminal={terminal} />}
      {editing ? (
        <input
          className="dock-tab-rename"
          defaultValue={terminal.title}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          // Keep edits out of the terminal and the drag controller.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit(e.currentTarget.value);
            else if (e.key === "Escape") {
              cancelled.current = true;
              setEditing(false);
            }
          }}
          onBlur={(e) => {
            if (!cancelled.current) commit(e.currentTarget.value);
          }}
        />
      ) : (
        <span className="truncate">{terminal.title}</span>
      )}
      <button
        className="dock-tab-close"
        title="Close Terminal"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          ctx.closeTerminal(terminal.id);
        }}
      >
        <IcClose />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group (tab strip + panes) and split recursion
// ---------------------------------------------------------------------------

function GroupView<T extends DockTerminalBase, S extends DockStoreState<T>>({
  group,
  ctx,
}: {
  group: DockGroup;
  ctx: DockCtx<T, S>;
}) {
  const terminals = useStore(ctx.store, (s) => s.terminals);
  const isActiveGroup = useStore(ctx.store, (s) => s.activeGroupId === group.id);
  const { dropTarget } = ctx.dnd;

  return (
    <div className="dock-group">
      <div className="dock-strip" data-dock-strip={group.id}>
        {group.terminalIds.map((id) => {
          const t = terminals[id];
          return t ? (
            <DockTab key={id} terminal={t} group={group} ctx={ctx} />
          ) : null;
        })}
        {dropTarget?.kind === "strip" && dropTarget.groupId === group.id && (
          <div className="dock-caret" style={{ left: dropTarget.caretLeft }} />
        )}
      </div>
      <div className="dock-body" data-dock-body={group.id}>
        {group.terminalIds.map((id) => {
          const t = terminals[id];
          return t ? (
            <ctx.Pane
              key={id}
              terminal={t}
              groupId={group.id}
              visible={id === group.activeTerminalId}
              focused={isActiveGroup && id === group.activeTerminalId}
            />
          ) : null;
        })}
        {dropTarget?.kind === "body" && dropTarget.groupId === group.id && (
          <div className={`dock-drop-overlay ${dropTarget.zone}`} />
        )}
      </div>
    </div>
  );
}

function SplitView<T extends DockTerminalBase, S extends DockStoreState<T>>({
  split,
  ctx,
}: {
  split: DockSplit;
  ctx: DockCtx<T, S>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Shift fraction between the two children flanking divider `i`, keeping
  // their sum (the rest of the split doesn't move) and a 120px-ish floor.
  // Sizes are re-read from the store: the drag closure outlives this render.
  const resizeAt = (i: number, deltaPx: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const total = split.direction === "row" ? rect.width : rect.height;
    if (total <= 0) return;
    const state = ctx.store.getState();
    const fresh = findSplit(state.root, split.id);
    if (!fresh) return;
    const sizes = [...fresh.sizes];
    const min = Math.min(0.5, Math.max(0.05, 120 / total));
    const df = Math.max(
      -(sizes[i - 1] - min),
      Math.min(sizes[i] - min, deltaPx / total),
    );
    if (df === 0) return;
    sizes[i - 1] += df;
    sizes[i] -= df;
    state.setSplitSizes(split.id, sizes);
  };

  return (
    <div ref={containerRef} className={`dock-split ${split.direction}`}>
      {split.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <div className="dock-divider">
              <Resizer
                direction={split.direction === "row" ? "vertical" : "horizontal"}
                onDelta={(d) => resizeAt(i, d)}
              />
            </div>
          )}
          <div className="dock-cell" style={{ flex: `${split.sizes[i] ?? 1} 1 0%` }}>
            <DockNodeView node={child} ctx={ctx} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function DockNodeView<T extends DockTerminalBase, S extends DockStoreState<T>>({
  node,
  ctx,
}: {
  node: DockNode;
  ctx: DockCtx<T, S>;
}) {
  return node.type === "group" ? (
    <GroupView group={node} ctx={ctx} />
  ) : (
    <SplitView split={node} ctx={ctx} />
  );
}

// ---------------------------------------------------------------------------
// Dock root (owns the drag controller)
// ---------------------------------------------------------------------------

export function Dock<T extends DockTerminalBase, S extends DockStoreState<T>>(
  props: DockProps<T, S>,
): ReactNode {
  const root = useStore(props.store, (s) => s.root);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [ghost, setGhost] = useState<{ id: string; title: string } | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  // The pointer listeners live for a whole drag; state reads inside them
  // would be stale — mirror the current target in a ref.
  const targetRef = useRef<DropTarget | null>(null);

  const setTarget = (t: DropTarget | null) => {
    if (sameTarget(targetRef.current, t)) return;
    targetRef.current = t;
    setDropTarget(t);
  };

  const beginDrag = (
    e: React.PointerEvent,
    terminalId: string,
    sourceGroupId: string,
  ) => {
    if (e.button !== 0) return;
    const tabEl = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const hitTest = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      const strip = hit?.closest("[data-dock-strip]") as HTMLElement | null;
      if (strip) {
        const groupId = strip.getAttribute("data-dock-strip")!;
        const tabs = Array.from(
          strip.querySelectorAll("[data-dock-tab]"),
        ) as HTMLElement[];
        let index = tabs.length;
        for (let i = 0; i < tabs.length; i++) {
          const r = tabs[i].getBoundingClientRect();
          if (x < r.left + r.width / 2) {
            index = i;
            break;
          }
        }
        // Caret position in strip-content coordinates (offsetParent = strip),
        // measured here so rendering needs no DOM access.
        const last = tabs[tabs.length - 1];
        const caretLeft =
          index < tabs.length
            ? tabs[index].offsetLeft - 2
            : last
              ? last.offsetLeft + last.offsetWidth + 1
              : 2;
        setTarget({ kind: "strip", groupId, index, caretLeft });
        return;
      }
      const body = hit?.closest("[data-dock-body]") as HTMLElement | null;
      if (body) {
        const groupId = body.getAttribute("data-dock-body")!;
        const r = body.getBoundingClientRect();
        const px = (x - r.left) / r.width;
        const py = (y - r.top) / r.height;
        const min = Math.min(px, 1 - px, py, 1 - py);
        const zone: DropEdge | "center" =
          min >= EDGE_BAND
            ? "center"
            : min === px
              ? "left"
              : min === 1 - px
                ? "right"
                : min === py
                  ? "top"
                  : "bottom";
        setTarget({ kind: "body", groupId, zone });
        return;
      }
      setTarget(null);
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (
          Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX &&
          Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        dragging = true;
        // Capture so the canvas under the cursor never sees the gesture
        // (xterm would start a text selection); elementFromPoint still
        // hit-tests whatever is under the point.
        tabEl.setPointerCapture(pointerId);
        document.body.style.cursor = "grabbing";
        const title = props.store.getState().terminals[terminalId]?.title;
        setGhost({ id: terminalId, title: title ?? "" });
      }
      const g = ghostRef.current;
      if (g) {
        g.style.left = `${ev.clientX + 10}px`;
        g.style.top = `${ev.clientY + 8}px`;
      }
      hitTest(ev.clientX, ev.clientY);
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      document.body.style.cursor = "";
      const target = targetRef.current;
      targetRef.current = null;
      setDropTarget(null);
      setGhost(null);
      if (!commit || !dragging || !target) return;
      const store = props.store.getState();
      if (target.kind === "strip") {
        store.moveTerminal(terminalId, target.groupId, target.index);
      } else if (target.zone === "center") {
        // Center-drop onto the terminal's own group means "leave it here".
        if (target.groupId !== sourceGroupId) {
          store.moveTerminal(terminalId, target.groupId, Number.MAX_SAFE_INTEGER);
        }
      } else {
        store.splitGroup(terminalId, target.groupId, target.zone);
      }
      // The reparent steals xterm's focus — give it back.
      getSession(terminalId)?.focus();
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        finish(false);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const ctx: DockCtx<T, S> = { ...props, dnd: { dropTarget, beginDrag } };

  return (
    <div className="dock-root">
      {root ? <DockNodeView node={root} ctx={ctx} /> : <props.Empty />}
      {ghost && (
        <div className="dock-ghost" ref={ghostRef}>
          <span className="truncate">{ghost.title}</span>
        </div>
      )}
    </div>
  );
}
