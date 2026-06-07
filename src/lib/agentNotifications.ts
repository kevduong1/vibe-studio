/**
 * Opt-in macOS notifications for agent terminals: when a terminal has
 * notificationsEnabled (right-click its dock tab), an attention onset —
 * detected by lib/terminalActivity and reported through agentSessions'
 * onActivity edge check — fires a system notification + sound via
 * tauri-plugin-notification. Default off for every terminal.
 *
 * Plugin gotchas (verified against its source): the `sound` string goes
 * verbatim into NSUserNotification.soundName, where unknown names —
 * including "default" — are SILENTLY ignored; the one special-cased value
 * is "NSUserNotificationDefaultSoundName" (the user's chosen alert sound).
 * Named system sounds ("Ping", "Glass") also work. And under `tauri dev`
 * notifications attribute to Terminal, not Vibe Studio — the plugin
 * hardcodes com.apple.Terminal for unbundled dev binaries, so Terminal's
 * notification settings govern delivery there.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { message } from "@tauri-apps/plugin-dialog";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { projectDisplayName } from "./projectNames";

/**
 * Toggle from the tab context menu. Enabling gates on notification
 * permission: on denial the flag stays off and a dialog points at System
 * Settings. (Desktop builds hardcode "granted" today — the deny path is
 * mobile/future insurance.)
 */
export async function setTerminalNotifications(
  terminalId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled && !(await ensurePermission())) return;
  useAgentTerminalsStore.getState().setNotificationsEnabled(terminalId, enabled);
}

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if ((await requestPermission()) === "granted") return true;
  await message(
    "Notifications are disabled for Vibe Studio. Enable them in System Settings → Notifications.",
    { title: "Notifications", kind: "warning" },
  );
  return false;
}

/**
 * Attention-onset notification (fire-and-forget; agentSessions calls this
 * on the false → true edge only, so one banner per onset). Everything is
 * re-read from the store by id — the caller's captured terminal object may
 * predate renames/toggles.
 */
export function notifyAgentAttention(terminalId: string): void {
  const s = useAgentTerminalsStore.getState();
  const t = s.terminals[terminalId];
  if (!t?.notificationsEnabled) return; // default off; also just-closed residue
  const project = projectDisplayName(t.workspacePath);
  sendNotification({
    // Default tab titles ARE the project name (possibly "· N"-deduped) —
    // suffix the project only when the title no longer starts with the
    // current name (tab renamed, or project renamed after the title was
    // snapshotted at creation).
    title: t.title.startsWith(project) ? t.title : `${t.title} — ${project}`,
    // The live OSC 0/2 topic summary, when the agent has set one.
    body: s.paneTitle[terminalId] || "Needs your attention",
    sound: "NSUserNotificationDefaultSoundName",
  });
}
