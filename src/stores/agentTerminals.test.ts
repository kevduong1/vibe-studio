import { describe, expect, it } from "vitest";
import { useAgentTerminalsStore } from "./agentTerminals";

describe("global terminal session state", () => {
  it("starts every app session without restored terminal layouts", () => {
    const state = useAgentTerminalsStore.getState();
    expect(state.terminals).toEqual({});
    expect(state.groupings).toEqual([]);
    expect(state.activeGroupingId).toBeNull();
  });
});
