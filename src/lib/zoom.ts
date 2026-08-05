/**
 * Whole-app zoom (⌘+/⌘−/⌘0), persisted across restarts. Applied via the
 * webview's native page zoom — on macOS wry 0.55 this is WKWebView.pageZoom
 * (public API, macOS 11+), a layout-reflowing zoom like browser full-page
 * zoom: CSS metrics, CodeMirror, and xterm all scale with crisp text, and
 * terminal panes refit themselves through their ResizeObservers. Module-level
 * state (pattern: lib/projectColors.ts); nothing renders the level reactively.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Browser-style zoom steps — a fixed list (not ± increments) so repeated
    zooming can't accumulate float drift. */
const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const STORAGE_KEY = "vibe-studio:zoom";

const listeners = new Set<() => void>();

const loadLevel = (): number => {
  const parsed = Number(localStorage.getItem(STORAGE_KEY));
  return LEVELS.includes(parsed) ? parsed : 1;
};

let level = loadLevel();

const apply = (next: number) => {
  level = next;
  localStorage.setItem(STORAGE_KEY, String(next));
  void getCurrentWebview().setZoom(next);
  for (const listener of [...listeners]) listener();
};

/** Current page-zoom factor — lib/termFileDrop.ts divides native drag
    coordinates (webview points) by this to get CSS viewport px. */
export const currentZoom = (): number => level;

export const onZoomChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const zoomIn = (): void => {
  const i = LEVELS.indexOf(level);
  if (i < LEVELS.length - 1) apply(LEVELS[i + 1]);
};

export const zoomOut = (): void => {
  const i = LEVELS.indexOf(level);
  if (i > 0) apply(LEVELS[i - 1]);
};

// Unconditional (no level !== 1 guard): if the tracked level ever desyncs
// from the real page zoom (failed setZoom IPC), ⌘0 self-repairs.
export const zoomReset = (): void => apply(1);

/** Apply the persisted level at startup (App-level, once). The webview always
    opens at 1, so there's nothing to do — and no IPC worth making — for 1. */
export const initZoom = (): void => {
  if (level !== 1) void getCurrentWebview().setZoom(level);
};
