/** Global Codex subscription usage, queried through the installed Codex
 * CLI's app-server protocol. Kept separate from the Claude toggle so either
 * meter can be enabled independently. */
import { create } from "zustand";
import { codexUsage, type CodexUsageState } from "../lib/ipc";

const ENABLED_KEY = "vibe-studio:codex-usage-enabled";
const POLL_MS = 5 * 60 * 1000;
const MIN_AUTO_GAP_MS = 60 * 1000;
const ERROR_AFTER = 3;

interface CodexUsageStore {
  enabled: boolean;
  state: CodexUsageState | null;
  stale: boolean;
  loading: boolean;
  setEnabled: (on: boolean) => void;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

let inFlight = false;
let failures = 0;
let lastAttemptMs = 0;

export const useCodexUsageStore = create<CodexUsageStore>((set, get) => ({
  enabled: loadEnabled(),
  state: null,
  stale: false,
  loading: false,
  setEnabled: (on) => {
    try {
      localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    } catch {
      /* keep the in-memory toggle */
    }
    set({ enabled: on });
    if (on) {
      failures = 0;
      void get().refresh({ force: true });
    } else {
      set({ state: null, stale: false, loading: false });
    }
  },
  refresh: async ({ force = false } = {}) => {
    if (!get().enabled || inFlight) return;
    if (!force && Date.now() - lastAttemptMs < MIN_AUTO_GAP_MS) return;
    inFlight = true;
    lastAttemptMs = Date.now();
    set({ loading: true });
    const keepLastGood = () => {
      failures += 1;
      return get().state?.status === "ok" && failures < ERROR_AFTER;
    };
    try {
      const next = await codexUsage();
      if (next.status === "error") {
        if (keepLastGood()) set({ loading: false, stale: true });
        else set({ state: next, stale: false, loading: false });
      } else {
        failures = 0;
        set({ state: next, stale: false, loading: false });
      }
    } catch (e) {
      if (keepLastGood()) set({ loading: false, stale: true });
      else
        set({
          state: { status: "error", message: String(e) },
          stale: false,
          loading: false,
        });
    } finally {
      inFlight = false;
    }
  },
}));

let polling = false;
export function initCodexUsagePolling(): void {
  if (polling) return;
  polling = true;
  const tick = () => void useCodexUsageStore.getState().refresh();
  tick();
  setInterval(tick, POLL_MS);
}
