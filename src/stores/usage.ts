/**
 * Global (account-wide, workspace-independent) Claude subscription usage
 * store. Opt-in like LSP — disabled until the user enables it in Settings,
 * since fetching reaches into Claude Code's credential store (a keychain
 * prompt is possible) and hits Anthropic. The usage endpoint is itself
 * rate-limited (shared with Claude Code's own polling on the same token), so
 * while enabled we poll sparingly: a slow background interval, plus a forced
 * pull whenever the user opens the status-bar chip. The chip renders `state`.
 *
 * See lib/ipc.ts `claudeUsage` — the fetch reuses Claude Code's existing OAuth
 * token read-only and never refreshes it.
 */
import { create } from "zustand";
import { claudeUsage, type UsageState } from "../lib/ipc";

const ENABLED_KEY = "vibe-studio:usage-enabled";
/** Usage windows barely move over minutes (5h / 7d), and the endpoint is
 *  rate-limited, so the background poll is deliberately slow — opening the chip
 *  forces a fresh pull when you actually want current numbers. */
const POLL_MS = 5 * 60 * 1000;
/** Floor on the gap between background (interval) ticks; user-initiated pulls
 *  (open chip / Refresh / retry) pass `force` and bypass it. A guard so an
 *  auto path can never hammer a rate-limited endpoint, well under POLL_MS. */
const MIN_AUTO_GAP_MS = 60 * 1000;
/** Keep showing the last good reading through this many consecutive transient
 *  failures (HTTP 429 rate-limit, network blips) before surfacing the error.
 *  Usage windows barely move over minutes, so a slightly stale gauge beats a
 *  gauge that flashes "usage error" every time a poll lands during a burst. */
const ERROR_AFTER = 3;

interface UsageStore {
  enabled: boolean;
  /** Latest result the UI renders; null until the first fetch resolves. While
   *  `stale` is set this is the last good reading kept across a failed refresh,
   *  not the live one. */
  state: UsageState | null;
  /** True when `state` is a retained good reading after a transient failure. */
  stale: boolean;
  loading: boolean;
  setEnabled: (on: boolean) => void;
  /** `force` bypasses the auto-tick throttle (user-initiated refresh/retry). */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

// Module-level so overlapping ticks (interval + focus + manual) coalesce to a
// single in-flight request.
let inFlight = false;
// Consecutive transient failures since the last good reading, and the last
// fetch attempt's timestamp (for the auto-tick throttle).
let failures = 0;
let lastAttemptMs = 0;

export const useUsageStore = create<UsageStore>((set, get) => ({
  enabled: loadEnabled(),
  state: null,
  stale: false,
  loading: false,
  setEnabled: (on) => {
    try {
      localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    } catch {
      /* private mode / quota — keep the in-memory toggle either way */
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
    // A transient failure (rate limit / network blip) must not wipe a good
    // reading: keep the last `ok` state, flag it stale, and only surface the
    // error once it persists or when there's nothing good to fall back to.
    const keepLastGood = () => {
      failures += 1;
      return get().state?.status === "ok" && failures < ERROR_AFTER;
    };
    try {
      const next = await claudeUsage();
      if (next.status === "error") {
        if (keepLastGood()) set({ loading: false, stale: true });
        else set({ state: next, stale: false, loading: false });
      } else {
        // ok / expired / unauthenticated are definitive answers, not blips.
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

/**
 * Start the background poll once (called from the status bar's mount). Ticks
 * immediately, then only on the slow interval — deliberately NOT on window
 * focus or other frequent events, to stay light on the rate-limited usage
 * endpoint (opening the chip is the on-demand refresh). Every tick no-ops while
 * disabled, so it's safe to start unconditionally.
 */
let polling = false;
export function initUsagePolling(): void {
  if (polling) return;
  polling = true;
  const tick = () => void useUsageStore.getState().refresh();
  tick();
  setInterval(tick, POLL_MS);
}
