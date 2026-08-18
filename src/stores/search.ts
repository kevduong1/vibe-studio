/**
 * Per-workspace Explorer search state. The Explorer owns both fuzzy filename
 * search and workspace-content search; only the latter needs backend result
 * state here. Keeping the shared query/scope in the workspace means it
 * survives activity-view and workspace switches.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { searchWorkspace, type SearchFileResult } from "../lib/ipc";

/** Type-ahead debounce; option toggles re-run immediately. */
const DEBOUNCE_MS = 250;

export type SearchToggle = "caseSensitive" | "wholeWord" | "useRegex";
export type SearchMode = "files" | "content";

export interface SearchState {
  mode: SearchMode;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;

  results: SearchFileResult[];
  totalMatches: number;
  /** A backend result cap was hit — there may be more matches. */
  truncated: boolean;
  searching: boolean;
  /** Backend failure (an invalid regex while typing) shown inline. */
  error: string | null;
  /** Collapsed file groups, keyed by relative path. */
  collapsed: Record<string, boolean>;

  setMode: (mode: SearchMode) => void;
  setQuery: (q: string) => void;
  toggle: (k: SearchToggle) => void;
  toggleCollapsed: (file: string) => void;
}

export type SearchStore = StoreApi<SearchState>;

/** Created by the workspaces store, one per open repo. */
export const createSearchStore = (repoPath: string): SearchStore =>
  createStore<SearchState>((set, get) => {
    // Stale-result guard: only the latest issued request may commit its
    // results, so a slow search over a big repo can never clobber a newer
    // query's output. (No backend cancellation needed — responses are
    // capped, dropping one is cheap.)
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const invalidate = () => {
      seq++;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const run = async () => {
      timer = null;
      const mySeq = ++seq;
      const { mode, query, caseSensitive, wholeWord, useRegex } = get();
      if (mode !== "content") return;
      if (!query) {
        set({
          results: [],
          totalMatches: 0,
          truncated: false,
          searching: false,
          error: null,
        });
        return;
      }
      set({ searching: true });
      try {
        const r = await searchWorkspace(
          repoPath,
          query,
          caseSensitive,
          wholeWord,
          useRegex,
        );
        if (mySeq !== seq) return; // superseded by a newer search
        set({
          results: r.files,
          totalMatches: r.totalMatches,
          truncated: r.truncated,
          searching: false,
          error: null,
          collapsed: {},
        });
      } catch (e) {
        if (mySeq !== seq) return;
        set({ searching: false, error: String(e) });
      }
    };

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), ms);
    };

    return {
      mode: "files",
      query: "",
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
      results: [],
      totalMatches: 0,
      truncated: false,
      searching: false,
      error: null,
      collapsed: {},

      setMode: (mode) => {
        if (mode === get().mode) return;
        invalidate();
        set({
          mode,
          searching: mode === "content" && !!get().query,
          error: null,
        });
        if (mode === "content" && get().query) schedule(0);
      },
      setQuery: (q) => {
        invalidate();
        set({ query: q });
        if (!q) {
          set({
            results: [],
            totalMatches: 0,
            truncated: false,
            searching: false,
            error: null,
          });
        } else if (get().mode === "content") {
          set({ searching: true, error: null });
          schedule(DEBOUNCE_MS);
        }
      },
      toggle: (k) => {
        invalidate();
        set({ [k]: !get()[k] } as Partial<SearchState>);
        if (get().mode === "content" && get().query) {
          set({ searching: true, error: null });
          schedule(0);
        }
      },
      toggleCollapsed: (file) =>
        set((s) => ({
          collapsed: { ...s.collapsed, [file]: !s.collapsed[file] },
        })),
    };
  });
