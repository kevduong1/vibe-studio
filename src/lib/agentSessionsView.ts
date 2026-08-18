import { basename, dirname } from "./path";
import { isInboxActionable, type AgentInboxItem } from "../stores/agentTasks";

export type AgentSessionsProjectionView = "all" | "attention";
export type AgentSessionsSort = "repository" | "session";

/** Presentation data that is meaningful only in the global session census.
 * The review inbox deliberately stays repository-metadata agnostic. */
export interface AgentSessionItem extends AgentInboxItem {
  /** Git-family identity shared by linked worktrees/equivalent open clones. */
  repositoryId: string;
  /** Human-readable repository name derived from the Git-family identity. */
  repository: string;
  /** Cosmetic name of this exact checkout/worktree. */
  checkout: string;
  /** Current branch (or detached short oid) when the checkout is open/known. */
  branch: string | null;
}

export interface AgentSessionsSection {
  id: string;
  label: string;
  items: AgentSessionItem[];
}

const compareText = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const sessionName = (item: AgentSessionItem): string =>
  item.topic || item.title;

const compareWithinRepository = (
  a: AgentSessionItem,
  b: AgentSessionItem,
): number =>
  compareText(a.checkout, b.checkout) ||
  compareText(sessionName(a), sessionName(b)) ||
  compareText(a.runtime.terminalId, b.runtime.terminalId);

const compareBySession = (a: AgentSessionItem, b: AgentSessionItem): number =>
  compareText(sessionName(a), sessionName(b)) ||
  compareText(a.repository, b.repository) ||
  compareWithinRepository(a, b);

/** Turn the titlebar's credential-free Git-family key into a compact repo
 * label. Hosted remotes end in owner/repo; local worktrees share the main
 * checkout's common `.git` directory. */
export function repositoryNameFromGroupId(
  groupId: string,
  fallbackPath: string,
): string {
  const raw = groupId.startsWith("remote:")
    ? groupId.slice("remote:".length)
    : groupId.startsWith("gitdir:")
      ? groupId.slice("gitdir:".length)
      : groupId;
  const normalized = raw.replace(/\/+$/, "");
  const localRoot =
    basename(normalized) === ".git" ? dirname(normalized) : normalized;
  const name = basename(localRoot).replace(/\.git$/i, "");
  return name || basename(fallbackPath);
}

/** Project sessions into alphabetical repository families by default. The
 * Attention view is a filter over the same ordering, never an urgency sort.
 * The alternative session sort is one flat A-Z list. */
export function projectAgentSessions(
  items: readonly AgentSessionItem[],
  view: AgentSessionsProjectionView,
  sort: AgentSessionsSort,
): AgentSessionsSection[] {
  const visible =
    view === "attention" ? items.filter(isInboxActionable) : [...items];

  if (sort === "session") {
    return visible.length > 0
      ? [
          {
            id: "sessions",
            label: "Sessions A–Z",
            items: visible.sort(compareBySession),
          },
        ]
      : [];
  }

  const repositories = new Map<
    string,
    { id: string; label: string; items: AgentSessionItem[] }
  >();
  for (const item of visible) {
    const existing = repositories.get(item.repositoryId);
    if (existing) existing.items.push(item);
    else {
      repositories.set(item.repositoryId, {
        id: `repository:${item.repositoryId}`,
        label: item.repository,
        items: [item],
      });
    }
  }

  return [...repositories.values()]
    .sort((a, b) => compareText(a.label, b.label) || compareText(a.id, b.id))
    .map((section) => ({
      ...section,
      items: section.items.sort(compareWithinRepository),
    }));
}
