import { create } from "zustand";
import { useWorkspacesStore } from "./workspaces";

export type SidebarTab =
  | "sessions"
  | "explorer"
  | "scm"
  | "memories";
export type AgentSessionsView = "all" | "attention";
/** Bottom-panel sides: per-workspace terminals vs the global terminal
 *  groupings (which grouping is in front lives in stores/agentTerminals). */
export type PanelGroup = "terminal" | "agent";

interface UiState {
  sidebarTab: SidebarTab;
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Session-only controls for the global Agent Sessions sidebar. Keeping
      them above the component preserves the view across activity-tab swaps. */
  agentSessionsView: AgentSessionsView;
  agentSessionsQuietExpanded: boolean;
  panelVisible: boolean;
  panelHeight: number;
  panelGroup: PanelGroup;
  /** Panel fills the whole center column (editor hidden). Transient view
      state: maximizing reveals the panel, hiding the panel clears it, and
      opening an editor tab clears it (stores/editor.ts) so the file is
      actually visible. */
  panelMaximized: boolean;
  /** Bumped by showSearch (⌘⇧F); the active workspace's Explorer search
      focuses its input on change — a counter so repeat presses refocus. */
  searchFocusNonce: number;
  /** Workspace targeted by the latest search shortcut. */
  searchFocusPath: string | null;
  /** Markdown tabs render as a preview instead of source (status-bar badge,
      shown only while the active tab is a .md file). App-wide, not per-tab:
      "reading mode" tends to be a moment, not a per-file choice. */
  markdownPreview: boolean;
  /** App-wide editor soft wrapping preference. */
  wordWrap: boolean;
  /** Save dirty active editors after a short idle delay. */
  autoSave: boolean;
  /** Mounted native-overlay families. A counter keeps nested and StrictMode
      unmounts from revealing previews too early. */
  nativeOverlayDepth: number;

  setSidebarTab: (tab: SidebarTab) => void;
  /** Reveal the global sessions view without the activity-button toggle
      behavior. Used by shortcuts and other global entry points. */
  showAgentSessions: () => void;
  setAgentSessionsView: (view: AgentSessionsView) => void;
  toggleAgentSessionsQuiet: () => void;
  /** ⌘⇧F: reveal Explorer's content-search mode and focus the query input.
      (setSidebarTab would TOGGLE the sidebar closed when already there.) */
  showSearch: () => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  togglePanel: () => void;
  setPanelVisible: (v: boolean) => void;
  setPanelHeight: (h: number) => void;
  /** Selecting a group also reveals the panel. */
  setPanelGroup: (g: PanelGroup) => void;
  togglePanelMaximized: () => void;
  setPanelMaximized: (v: boolean) => void;
  toggleMarkdownPreview: () => void;
  toggleWordWrap: () => void;
  toggleAutoSave: () => void;
  pushNativeOverlay: () => void;
  popNativeOverlay: () => void;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

const storedBool = (key: string): boolean =>
  typeof window !== "undefined" && window.localStorage.getItem(key) === "true";
const storeBool = (key: string, value: boolean): void => {
  if (typeof window !== "undefined") window.localStorage.setItem(key, String(value));
};

export const useUiStore = create<UiState>((set) => ({
  sidebarTab: "scm",
  sidebarVisible: true,
  sidebarWidth: 320,
  agentSessionsView: "all",
  agentSessionsQuietExpanded: true,
  panelVisible: false,
  panelHeight: 280,
  panelGroup: "terminal",
  panelMaximized: false,
  searchFocusNonce: 0,
  searchFocusPath: null,
  markdownPreview: false,
  wordWrap: storedBool("talos:word-wrap"),
  autoSave: storedBool("talos:auto-save"),
  nativeOverlayDepth: 0,

  setSidebarTab: (tab) =>
    set((s) =>
      s.sidebarTab === tab && s.sidebarVisible
        ? { sidebarVisible: false }
        : { sidebarTab: tab, sidebarVisible: true },
    ),
  showAgentSessions: () =>
    set({ sidebarTab: "sessions", sidebarVisible: true }),
  setAgentSessionsView: (agentSessionsView) => set({ agentSessionsView }),
  toggleAgentSessionsQuiet: () =>
    set((state) => ({
      agentSessionsQuietExpanded: !state.agentSessionsQuietExpanded,
    })),
  showSearch: () => {
    const searchFocusPath = useWorkspacesStore.getState().activePath;
    set((s) => ({
      sidebarTab: "explorer",
      sidebarVisible: true,
      searchFocusPath,
      searchFocusNonce: s.searchFocusNonce + 1,
    }));
  },
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, 200, 600) }),
  togglePanel: () =>
    set((s) => ({ panelVisible: !s.panelVisible, panelMaximized: false })),
  setPanelVisible: (v) =>
    set(v ? { panelVisible: true } : { panelVisible: false, panelMaximized: false }),
  setPanelHeight: (h) => set({ panelHeight: clamp(h, 100, 800) }),
  setPanelGroup: (g) => set({ panelGroup: g, panelVisible: true }),
  togglePanelMaximized: () =>
    set((s) =>
      s.panelMaximized
        ? { panelMaximized: false }
        : { panelMaximized: true, panelVisible: true },
    ),
  setPanelMaximized: (v) =>
    set(v ? { panelMaximized: true, panelVisible: true } : { panelMaximized: false }),
  toggleMarkdownPreview: () =>
    set((s) => ({ markdownPreview: !s.markdownPreview })),
  toggleWordWrap: () =>
    set((s) => {
      const wordWrap = !s.wordWrap;
      storeBool("talos:word-wrap", wordWrap);
      return { wordWrap };
    }),
  toggleAutoSave: () =>
    set((s) => {
      const autoSave = !s.autoSave;
      storeBool("talos:auto-save", autoSave);
      return { autoSave };
    }),
  pushNativeOverlay: () =>
    set((s) => ({ nativeOverlayDepth: s.nativeOverlayDepth + 1 })),
  popNativeOverlay: () =>
    set((s) => ({ nativeOverlayDepth: Math.max(0, s.nativeOverlayDepth - 1) })),
}));

/**
 * The panel group actually displayed: with no workspaces open, "terminal"
 * is meaningless (workspace terminals don't exist) and the agent group —
 * whose terminals outlive their projects — takes over. Pure derivation;
 * the user's panelGroup choice is untouched.
 */
export function useEffectivePanelGroup(): PanelGroup {
  const hasWorkspaces = useWorkspacesStore((s) => s.workspaces.length > 0);
  const group = useUiStore((s) => s.panelGroup);
  return hasWorkspaces ? group : "agent";
}
