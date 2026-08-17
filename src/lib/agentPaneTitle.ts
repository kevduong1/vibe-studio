import type { AgentKind } from "./agentState";

/** Codex's default terminal-title activity frames. They are useful activity
 * evidence, but duplicating one beside Vibe's semantic Working label makes a
 * status animation look like a conversation topic. */
const CODEX_ACTIVITY_FRAMES = new Set([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
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

export function agentPaneTitle(
  kind: AgentKind,
  rawTitle: string,
  redundantTitles: readonly (string | undefined)[] = [],
): string {
  let title = rawTitle.trim();
  if (!title) return "";
  if (kind === "codex") {
    const [first, ...rest] = [...title];
    if (CODEX_ACTIVITY_FRAMES.has(first)) {
      title = rest.join("").replace(/^[\s·|—-]+/, "").trim();
    }
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
          !CODEX_RUN_STATES.has(item.toLowerCase()),
      )
      .join(" | ");
    if (!title || redundant.has(title)) return "";
  }
  return title;
}
