import { describe, expect, it } from "vitest";
import {
  groupingAfterWorkspaceDeleted,
  useAgentTerminalsStore,
  type AgentTerminal,
  type GlobalTermGrouping,
} from "./agentTerminals";

const terminal = (id: string, workspacePath: string): AgentTerminal => ({
  id,
  title: id,
  workspacePath,
  kind: "shell",
});

const grouping = (lastActiveWorkspacePath: string | null): GlobalTermGrouping => ({
  id: "grouping",
  name: "Global 1",
  lastActiveWorkspacePath,
  root: {
    type: "group",
    id: "pane",
    terminalIds: ["deleted", "survivor"],
    activeTerminalId: "survivor",
  },
  activeGroupId: "pane",
});

describe("global terminal workspace memory", () => {
  it("starts every app session without restored terminal layouts", () => {
    const state = useAgentTerminalsStore.getState();
    expect(state.terminals).toEqual({});
    expect(state.groupings).toEqual([]);
    expect(state.activeGroupingId).toBeNull();
  });

  it("rebinds a deleted path to the active surviving terminal", () => {
    const value = grouping("/repo/deleted");
    const terminals = {
      deleted: terminal("deleted", "/repo/deleted"),
      survivor: terminal("survivor", "/repo/other"),
    };

    expect(groupingAfterWorkspaceDeleted(
      value,
      terminals,
      "/repo/deleted",
      "/repo/fallback",
    ).lastActiveWorkspacePath).toBe("/repo/other");
  });

  it("uses the current workspace when the grouping has no surviving project", () => {
    const value = { ...grouping("/repo/deleted"), root: null, activeGroupId: null };

    expect(groupingAfterWorkspaceDeleted(
      value,
      {},
      "/repo/deleted",
      "/repo/fallback",
    ).lastActiveWorkspacePath).toBe("/repo/fallback");
    expect(groupingAfterWorkspaceDeleted(
      value,
      {},
      "/repo/deleted",
      null,
    ).lastActiveWorkspacePath).toBeNull();
  });

  it("leaves unrelated grouping memory reference-stable", () => {
    const value = grouping("/repo/other");
    expect(groupingAfterWorkspaceDeleted(
      value,
      {},
      "/repo/deleted",
      null,
    )).toBe(value);
  });
});
