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

/** Claude Code prefixes its OSC 0/2 title with one frame of its brand/spinner
 * glyph family. Talos already renders a Claude icon beside the topic, so the
 * glyph would only double the sparkle. */
const CLAUDE_TITLE_GLYPHS = new Set(["·", "✢", "✳", "✶", "✻", "✽"]);

/** Claude Code's title text when the session has no topic yet: the product
 * name, which says nothing a Claude-labelled pane does not already say. */
const CLAUDE_DEFAULT_TITLE = "claude code";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rendered forms of Codex's `context-remaining` / `context-used` title
 * fields. They are useful meters in the TUI but not a conversation topic. */
const CODEX_CONTEXT_METER = /^context\s+(?:100|[0-9]{1,2})%\s+(?:left|used)$/i;

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

/** Only a leading glyph separated by whitespace is Claude's marker; the same
 * characters inside prose belong to the topic the user is reading. */
function stripClaudeTitleGlyph(title: string): string {
  const chars = [...title];
  if (chars.length < 2) return title;
  if (!CLAUDE_TITLE_GLYPHS.has(chars[0])) return title;
  if (!/\s/u.test(chars[1])) return title;
  return chars.slice(1).join("").trimStart();
}

export function agentPaneTitle(
  kind: AgentKind,
  rawTitle: string,
  redundantTitles: readonly (string | undefined)[] = [],
): string {
  let title = rawTitle.trim();
  if (!title) return "";
  const redundant = new Set(
    redundantTitles.map((candidate) => candidate?.trim()).filter(Boolean),
  );
  if (kind === "claude") {
    title = stripClaudeTitleGlyph(title).trim();
    if (!title || title.toLowerCase() === CLAUDE_DEFAULT_TITLE) return "";
    if (redundant.has(title)) return "";
  }
  if (kind === "codex") {
    title = stripCodexActivityFrame(title);
    // Codex joins configured terminal-title items with ` | `. Keep useful
    // metadata (a named thread, branch, model, task progress), but remove
    // values Talos already owns, context meters, and the UUID fallback of an
    // unnamed thread.
    // Splitting only on whitespace-padded pipes leaves ordinary prose alone.
    title = title
      .split(/\s+\|\s+/)
      .map((item) => item.trim())
      .filter(
        (item) =>
          item &&
          !redundant.has(item) &&
          !UUID.test(item) &&
          !CODEX_CONTEXT_METER.test(item) &&
          !CODEX_ACTION_REQUIRED.has(item.toLowerCase()) &&
          !CODEX_RUN_STATES.has(item.toLowerCase()),
      )
      .join(" | ");
    if (!title || redundant.has(title)) return "";
  }
  return title;
}
