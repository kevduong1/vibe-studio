import type { AgentKind } from "./agentState";

/** Codex's default terminal-title activity frames. They are useful activity
 * evidence, but duplicating one beside Vibe's semantic Working label makes a
 * status animation look like a conversation topic. */
const CODEX_ACTIVITY_FRAMES = new Set([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
]);

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
    if (redundant.has(title)) return "";
  }
  return title;
}
