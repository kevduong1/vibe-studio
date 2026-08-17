import type { AgentKind } from "./agentState";

/** Codex's default terminal-title activity frames. They are useful activity
 * evidence, but duplicating one beside Talos's semantic Working label makes a
 * status animation look like a conversation topic. */
const CODEX_ACTIVITY_FRAMES = new Set([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
]);

/** The `activity` title item replaces its spinner with one of these blinking
 * prefixes while Codex is blocked. Talos already presents Needs Input from
 * semantic evidence, so neither phase belongs in the conversation topic. */
const CODEX_ACTION_REQUIRED = new Set([
  "[ ! ] action required",
  "[ . ] action required",
]);

/** Values emitted by Codex's `run-state` terminal-title item. Talos already
 * presents a richer process/screen-derived lifecycle beside the topic, so
 * retaining these would produce badges such as "Working · Starting" while
 * the two authorities settle. */
const CODEX_RUN_STATES = new Set([
  "ready",
  "starting",
  "working",
  "thinking",
  "reviewing",
  "compacting",
  "waiting",
  "waiting for approval",
  "awaiting approval",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripCodexActivityFrame(title: string): string {
  const chars = [...title];
  const index = chars.findIndex(
    (char, i) =>
      CODEX_ACTIVITY_FRAMES.has(char) &&
      (i === 0 || /\s/u.test(chars[i - 1])) &&
      (i === chars.length - 1 || /\s/u.test(chars[i + 1])),
  );
  if (index < 0) return title;
  const before = chars.slice(0, index).join("").trimEnd();
  const after = chars.slice(index + 1).join("").trimStart();
  // Codex deliberately uses spaces rather than ` | ` around `activity`, even
  // when it sits between two configured values. Restore their separation once
  // the presentation-only frame is gone.
  return before && after ? `${before} | ${after}` : before || after;
}

export function agentPaneTitle(
  kind: AgentKind,
  rawTitle: string,
  redundantTitles: readonly (string | undefined)[] = [],
): string {
  let title = rawTitle.trim();
  if (!title) return "";
  if (kind === "codex") {
    title = stripCodexActivityFrame(title);
    const redundant = new Set(
      redundantTitles.map((candidate) => candidate?.trim()).filter(Boolean),
    );
    // Codex joins configured terminal-title items with ` | `. Keep useful
    // metadata (a named thread, branch, model, task progress), but remove
    // values Talos already owns plus the UUID fallback of an unnamed thread.
    // Splitting only on whitespace-padded pipes leaves ordinary prose alone.
    title = title
      .split(/\s+\|\s+/)
      .map((item) => item.trim())
      .filter(
        (item) =>
          item &&
          !redundant.has(item) &&
          !UUID.test(item) &&
          !CODEX_ACTION_REQUIRED.has(item.toLowerCase()) &&
          !CODEX_RUN_STATES.has(item.toLowerCase()),
      )
      .join(" | ");
    if (!title || redundant.has(title)) return "";
  }
  return title;
}
