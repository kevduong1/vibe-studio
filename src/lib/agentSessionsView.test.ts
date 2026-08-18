import { describe, expect, it } from "vitest";
import type { AgentRuntimeState } from "./agentState";
import {
  projectAgentSessions,
  repositoryNameFromGroupId,
  type AgentSessionItem,
} from "./agentSessionsView";

function item(
  id: string,
  options: {
    repositoryId?: string;
    repository?: string;
    checkout?: string;
    title?: string;
    topic?: string;
    runtime?: Partial<AgentRuntimeState>;
  } = {},
): AgentSessionItem {
  const runtime: AgentRuntimeState = {
    terminalId: id,
    workspacePath: `/repo/${id}`,
    scope: "global",
    requestedKind: "claude",
    kind: "claude",
    occupancy: "present",
    generation: 1,
    lifecycle: "idle",
    seen: true,
    changedAt: 10,
    ...options.runtime,
  };
  const checkout = options.checkout ?? id;
  return {
    runtime,
    title: options.title ?? id,
    project: checkout,
    topic: options.topic ?? "",
    repositoryId: options.repositoryId ?? "repo:default",
    repository: options.repository ?? "Default",
    checkout,
    branch: null,
  };
}

const ids = (items: readonly AgentSessionItem[]) =>
  items.map((candidate) => candidate.runtime.terminalId);

describe("agent sessions view projection", () => {
  it("groups repository families alphabetically and keeps worktrees together", () => {
    const sections = projectAgentSessions(
      [
        item("beta", {
          repositoryId: "repo:beta",
          repository: "Beta",
          checkout: "main",
        }),
        item("alpha-task", {
          repositoryId: "repo:alpha",
          repository: "Alpha",
          checkout: "task-z",
        }),
        item("alpha-main", {
          repositoryId: "repo:alpha",
          repository: "Alpha",
          checkout: "main",
        }),
      ],
      "all",
      "repository",
    );

    expect(sections.map((section) => section.label)).toEqual(["Alpha", "Beta"]);
    expect(ids(sections[0].items)).toEqual(["alpha-main", "alpha-task"]);
    expect(ids(sections[1].items)).toEqual(["beta"]);
  });

  it("treats attention as a filter while retaining repository/check-out ordering", () => {
    const sections = projectAgentSessions(
      [
        item("blocked-z", {
          repositoryId: "repo:alpha",
          repository: "Alpha",
          checkout: "z-worktree",
          runtime: { lifecycle: "blocked", seen: false },
        }),
        item("quiet", {
          repositoryId: "repo:alpha",
          repository: "Alpha",
          checkout: "middle",
        }),
        item("done-a", {
          repositoryId: "repo:alpha",
          repository: "Alpha",
          checkout: "a-worktree",
          runtime: { lifecycle: "idle", seen: false },
        }),
      ],
      "attention",
      "repository",
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Alpha");
    expect(ids(sections[0].items)).toEqual(["done-a", "blocked-z"]);
  });

  it("offers one flat alphabetical session-name sort", () => {
    const sections = projectAgentSessions(
      [
        item("second", { repository: "Alpha", title: "Zulu" }),
        item("first", { repository: "Beta", title: "alpha 2" }),
        item("middle", { repository: "Gamma", topic: "Alpha 10" }),
      ],
      "all",
      "session",
    );

    expect(sections.map((section) => section.label)).toEqual(["Sessions A–Z"]);
    expect(ids(sections[0].items)).toEqual(["first", "middle", "second"]);
  });

  it("derives readable names for hosted repos and local worktree families", () => {
    expect(
      repositoryNameFromGroupId(
        "remote:github.com/openai/codex.git",
        "/fallback/project",
      ),
    ).toBe("codex");
    expect(
      repositoryNameFromGroupId(
        "gitdir:/Users/me/repos/talos/.git",
        "/fallback/project",
      ),
    ).toBe("talos");
  });

  it("omits empty sections", () => {
    expect(projectAgentSessions([], "all", "repository")).toEqual([]);
    expect(projectAgentSessions([], "attention", "session")).toEqual([]);
  });
});
