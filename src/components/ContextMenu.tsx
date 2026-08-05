/**
 * Shared fixed-position context menu: clamps into the viewport pre-paint and
 * closes on backdrop click / right-click or Escape. Children are the items —
 * direct-child <button>s get the standard item styling (ContextMenu.css),
 * `.ctx-menu-sep` divides sections, and wrapped custom rows (e.g. the
 * titlebar's project color picker) style themselves.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNativeOverlay } from "../lib/nativeOverlays";
import "./ContextMenu.css";

export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  useNativeOverlay();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // clamp into the viewport once the real size is known (pre-paint)
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className="ctx-menu-backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div ref={ref} className="ctx-menu" style={pos}>
        {children}
      </div>
    </>
  );
}
