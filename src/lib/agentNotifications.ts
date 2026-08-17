/**
 * Opt-in semantic alerts for agent terminals (right-click a dock tab):
 * background blocked and unseen-completion edges play the attention sound
 * and post a best-effort system banner. Default off for every terminal.
 *
 * The sound is app-played (ipc playSound → afplay), NOT a notification
 * sound: it works in dev and release alike, survives Focus modes and
 * per-app notification settings, and can be any audio file (picked in the
 * settings modal; defaults to the bundled sounds/alert.mp3 — a tauri
 * `bundle.resources` entry, resolved per-install via resolveResource).
 *
 * Banners go through notify.rs (UserNotifications framework — the tauri
 * notification plugin's deprecated-API path stores but never presents on
 * current macOS). They need a real app bundle, so bare `tauri dev` has no
 * banner (the sound still works), and they need OS authorization —
 * requested on the first enable. Denial only costs the banner; the toggle
 * and sound stay functional. The banner-mode setting decides whether
 * banners also present while the app is frontmost (macOS suppresses those
 * unless notify.rs' delegate allows it) or are skipped entirely.
 */
import { resolveResource } from "@tauri-apps/api/path";
import { message } from "@tauri-apps/plugin-dialog";
import {
  notificationDismiss,
  notificationRequest,
  notificationSend,
  notificationState,
  playSound,
} from "./ipc";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  subscribeAgentTransitions,
  useAgentRuntimeStore,
} from "../stores/agentRuntime";
import { agentAlertAction, reasonLabel } from "./agentState";
import { projectDisplayName } from "./projectNames";

// ---------------------------------------------------------------------------
// Attention sound (global setting; the per-terminal bit is just on/off)
// ---------------------------------------------------------------------------

const SOUND_KEY = "talos:attention-sound";

/** The standard macOS alert sounds (/System/Library/Sounds). */
export const SYSTEM_SOUNDS = [
  "Basso",
  "Blow",
  "Bottle",
  "Frog",
  "Funk",
  "Glass",
  "Hero",
  "Morse",
  "Ping",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
  "Tink",
] as const;

export const systemSoundPath = (name: string): string =>
  `/System/Library/Sounds/${name}.aiff`;

/** The bundled default (tauri.conf.json bundle.resources); its absolute
 *  location differs per install/dev, hence the resolve + cache. The cache
 *  keeps only fulfilled promises — caching a rejection would permanently
 *  silence the default sound for the session. */
const BUNDLED_SOUND = "sounds/alert.mp3";
let bundledSound: Promise<string> | null = null;
const bundledSoundPath = (): Promise<string> => {
  bundledSound ??= resolveResource(BUNDLED_SOUND).catch((e: unknown) => {
    bundledSound = null;
    throw e;
  });
  return bundledSound;
};

/** Raw persisted choice — null = the bundled default. */
export const storedAttentionSound = (): string | null =>
  localStorage.getItem(SOUND_KEY);

/** null restores the bundled default (the key is dropped, not stored). */
export const setAttentionSoundPath = (path: string | null): void => {
  if (path) localStorage.setItem(SOUND_KEY, path);
  else localStorage.removeItem(SOUND_KEY);
};

/** Play the configured attention sound — the one playback path, shared by
 *  real alerts and the settings-modal previews. A stored custom file that
 *  stopped existing (deleted, volume unmounted) falls back to the bundled
 *  default: play_sound rejects on missing files exactly so alerts can't go
 *  silent without a trace. */
export async function playAttentionSound(): Promise<void> {
  const stored = storedAttentionSound();
  if (stored) {
    try {
      await playSound(stored);
      return;
    } catch {
      // stale custom path — fall through to the bundled default
    }
  }
  try {
    await playSound(await bundledSoundPath());
  } catch {
    // resource/afplay failure — alerts stay best-effort
  }
}

// ---------------------------------------------------------------------------
// Banner visibility (global setting, settings modal)
// ---------------------------------------------------------------------------

const BANNER_KEY = "talos:banner-mode";

/** "always" presents banners even while the app is frontmost (notify.rs'
 *  willPresent delegate answers with banner+list), "background" keeps the
 *  OS default (frontmost = suppressed), "never" skips the banner entirely
 *  (sound-only). */
export type BannerMode = "always" | "background" | "never";

export const bannerMode = (): BannerMode => {
  const v = localStorage.getItem(BANNER_KEY);
  return v === "background" || v === "never" ? v : "always";
};

/** "always" is the default — stored as a dropped key. */
export const setBannerMode = (mode: BannerMode): void => {
  if (mode === "always") localStorage.removeItem(BANNER_KEY);
  else localStorage.setItem(BANNER_KEY, mode);
};

// ---------------------------------------------------------------------------
// Per-terminal toggle + the attention hook
// ---------------------------------------------------------------------------

const bannerOperations = new Map<string, Promise<void>>();

/** Notification Center accepts adds asynchronously. Serialize each stable
 * terminal identifier so a dismissal cannot run before an earlier add has
 * actually been accepted and then reappear afterward. */
export function enqueueAgentBannerOperation(
  terminalId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = bannerOperations.get(terminalId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  bannerOperations.set(terminalId, next);
  void next.catch(() => {}).then(() => {
    if (bannerOperations.get(terminalId) === next) {
      bannerOperations.delete(terminalId);
    }
  });
  return next;
}

/** Concurrent enables share one in-flight authorization request — macOS
 *  only ever shows one prompt; this keeps N toggles from parking N IPC
 *  calls behind it. */
let pendingRequest: Promise<unknown> | null = null;
/** The blocked-banners reminder fires once per session, not per enable. */
let warnedDenied = false;

/**
 * Toggle from the tab context menu. Enabling always succeeds — the sound
 * needs no permission. Banner authorization is handled opportunistically:
 * the OS prompt appears on the first enable (bundled builds), and a denial
 * just means sound-only (one reminder dialog per session on enables while
 * the OS reports denied).
 */
export async function setTerminalNotifications(
  terminalId: string,
  enabled: boolean,
): Promise<void> {
  const global = useAgentTerminalsStore.getState().terminals[terminalId];
  if (global) {
    useAgentTerminalsStore.getState().setNotificationsEnabled(terminalId, enabled);
  } else {
    const workspace = useWorkspacesStore
      .getState()
      .workspaces.find((item) => item.terminal.getState().terminals[terminalId]);
    workspace?.terminal.getState().setNotificationsEnabled(terminalId, enabled);
  }
  if (!enabled) {
    dismissAgentAttention(terminalId); // a delivered banner may linger
    return;
  }
  const state = await notificationState();
  if (state === "prompt") {
    pendingRequest ??= notificationRequest().finally(() => {
      pendingRequest = null;
    });
    await pendingRequest; // either answer is fine — sound already works
  } else if (state === "denied" && !warnedDenied) {
    warnedDenied = true;
    await message(
      "Banners are blocked for Talos (System Settings → Notifications). The attention sound will still play.",
      { title: "Notifications", kind: "warning" },
    );
  }
  // "granted": nothing to do; "unsupported" (tauri dev): silently sound-only.
}

/**
 * Attention-onset alert (fire-and-forget; agentSessions calls this on the
 * false → true edge only, so one alert per onset). Everything is re-read
 * from the store by id — the caller's captured terminal object may predate
 * renames/toggles.
 */
const terminalPresentation = (terminalId: string) => {
  const globalState = useAgentTerminalsStore.getState();
  const global = globalState.terminals[terminalId];
  if (global) {
    const project = projectDisplayName(global.workspacePath);
    return {
      enabled: global.notificationsEnabled === true,
      title: global.title.startsWith(project)
        ? global.title
        : `${global.title} — ${project}`,
      topic: globalState.paneTitle[terminalId],
    };
  }
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const terminal = workspace.terminal.getState().terminals[terminalId];
    if (terminal) {
      return {
        enabled: terminal.notificationsEnabled === true,
        title: `${terminal.title} — ${projectDisplayName(workspace.path)}`,
        topic: workspace.terminal.getState().paneTitle[terminalId] ?? "",
      };
    }
  }
  return undefined;
};

export function notifyAgentAttention(
  terminalId: string,
  type: "blocked" | "done" | "checks_failed" = "blocked",
): void {
  const presentation = terminalPresentation(terminalId);
  if (!presentation?.enabled) return;
  const runtime = useAgentRuntimeStore.getState().states[terminalId];
  void playAttentionSound();
  const mode = bannerMode();
  if (mode === "never") return;
  void enqueueAgentBannerOperation(
    terminalId,
    () => notificationSend(
      // Identifier = terminal id: a repeat onset replaces the terminal's
      // delivered banner instead of stacking, and the dismiss paths (attention
      // answered / tab closed / notifications disabled) remove by it.
      terminalId,
      presentation.title,
      type === "checks_failed"
        ? "Automatic checks failed"
        : presentation.topic ||
          (type === "done" ? "Turn completed" : reasonLabel(runtime?.reason)),
      mode === "always",
    ),
  ).catch(() => {});
}

/**
 * Tear down the terminal's pending or delivered banner: called on the attention
 * true → false edge (the user answered), on terminal close, and on
 * notifications-disable. Deliberately unconditional — removing a
 * nonexistent identifier is a framework no-op (and dev has no banners), so
 * callers don't need to know whether one was ever posted.
 */
export function dismissAgentAttention(terminalId: string): void {
  void enqueueAgentBannerOperation(
    terminalId,
    () => notificationDismiss(terminalId),
  ).catch(() => {});
}

// Semantic edge behavior is centralized here so redraws cannot repeat an
// alert. One identifier per terminal means a later blocked/done edge replaces
// the prior delivered banner instead of stacking it.
subscribeAgentTransitions(({ previous, current }) => {
  const action = agentAlertAction(previous, current);
  if (current && action === "blocked") {
    notifyAgentAttention(current.terminalId, "blocked");
    return;
  }
  if (current && action === "done") {
    notifyAgentAttention(current.terminalId, "done");
    return;
  }
  if (action === "dismiss") {
    dismissAgentAttention(previous?.terminalId ?? current?.terminalId ?? "");
  }
});
