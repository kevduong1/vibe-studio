import { displayAgentState } from "./agentState";
import {
  isInboxActionable,
  sortInboxItems,
  type AgentInboxItem,
} from "../stores/agentTasks";

export type AgentSessionsProjectionView = "all" | "attention";
export type AgentSessionsSectionId = "attention" | "active" | "quiet";

export const AGENT_SESSIONS_SECTION_LABELS: Record<
  AgentSessionsSectionId,
  string
> = {
  attention: "Needs attention",
  active: "Active",
  quiet: "Quiet",
};

export interface AgentSessionsSection {
  id: AgentSessionsSectionId;
  label: string;
  items: AgentInboxItem[];
}

const section = (
  id: AgentSessionsSectionId,
  items: AgentInboxItem[],
): AgentSessionsSection => ({
  id,
  label: AGENT_SESSIONS_SECTION_LABELS[id],
  items,
});

/** Project registered sessions into the sidebar's semantic sections.
 * Attention keeps the existing urgency/age ordering. Active and quiet keep
 * registration order so they do not jump around as unrelated sessions move
 * between attention tiers. */
export function projectAgentSessions(
  items: readonly AgentInboxItem[],
  view: AgentSessionsProjectionView,
): AgentSessionsSection[] {
  const attention = sortInboxItems(items.filter(isInboxActionable));
  if (view === "attention") return [section("attention", attention)];

  const active: AgentInboxItem[] = [];
  const quiet: AgentInboxItem[] = [];
  for (const item of items) {
    if (isInboxActionable(item)) continue;
    const display = displayAgentState(item.runtime);
    if (display === "working" || display === "starting") active.push(item);
    else quiet.push(item);
  }

  return [
    section("attention", attention),
    section("active", active),
    section("quiet", quiet),
  ];
}
