import { describe, expect, it } from "vitest";
import type { AgentRuntimeState } from "./agentState";
import type { AgentInboxItem } from "../stores/agentTasks";
import {
  AGENT_SESSIONS_SECTION_LABELS,
  projectAgentSessions,
} from "./agentSessionsView";

function item(
  id: string,
  patch: Partial<AgentRuntimeState> = {},
): AgentInboxItem {
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
    ...patch,
  };
  return { runtime, title: id, project: id, topic: "" };
}

const ids = (items: readonly AgentInboxItem[]) =>
  items.map((candidate) => candidate.runtime.terminalId);

describe("agent sessions view projection", () => {
  it("sorts attention while preserving registration order in active and quiet", () => {
    const quietFirst = item("quiet-first");
    const workingFirst = item("working-first", { lifecycle: "working" });
    const blockedNew = item("blocked-new", {
      lifecycle: "blocked",
      seen: false,
      changedAt: 20,
    });
    const startingSecond = item("starting-second", {
      occupancy: "starting",
      lifecycle: "unknown",
    });
    const blockedOld = item("blocked-old", {
      lifecycle: "blocked",
      seen: false,
      changedAt: 2,
    });
    const quietSecond = item("quiet-second", { lifecycle: "unknown" });
    const input = [
      quietFirst,
      workingFirst,
      blockedNew,
      startingSecond,
      blockedOld,
      quietSecond,
    ];

    const sections = projectAgentSessions(input, "all");

    expect(sections.map((candidate) => candidate.id)).toEqual([
      "attention",
      "active",
      "quiet",
    ]);
    expect(ids(sections[0].items)).toEqual(["blocked-old", "blocked-new"]);
    expect(ids(sections[1].items)).toEqual([
      "working-first",
      "starting-second",
    ]);
    expect(ids(sections[2].items)).toEqual(["quiet-first", "quiet-second"]);
    expect(input).toEqual([
      quietFirst,
      workingFirst,
      blockedNew,
      startingSecond,
      blockedOld,
      quietSecond,
    ]);
  });

  it("returns only the ordered attention section for the attention view", () => {
    const sections = projectAgentSessions(
      [
        item("working", { lifecycle: "working" }),
        item("done", { lifecycle: "idle", seen: false, changedAt: 8 }),
        item("blocked", { lifecycle: "blocked", seen: false, changedAt: 9 }),
        item("quiet"),
      ],
      "attention",
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("attention");
    expect(ids(sections[0].items)).toEqual(["blocked", "done"]);
  });

  it("includes stable user-facing labels and empty sections", () => {
    expect(AGENT_SESSIONS_SECTION_LABELS).toEqual({
      attention: "Needs attention",
      active: "Active",
      quiet: "Quiet",
    });
    expect(
      projectAgentSessions([], "all").map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        count: candidate.items.length,
      })),
    ).toEqual([
      { id: "attention", label: "Needs attention", count: 0 },
      { id: "active", label: "Active", count: 0 },
      { id: "quiet", label: "Quiet", count: 0 },
    ]);
  });
});
