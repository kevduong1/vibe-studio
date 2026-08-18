import { describe, expect, it } from "vitest";
import {
  AGENT_AVATAR_DEITIES,
  AGENT_AVATAR_DEITY_BY_COLOR,
  AGENT_AVATAR_FRAME_COUNT,
  AGENT_AVATAR_FRAME_MS,
  AGENT_AVATAR_PERSONALITIES,
  AGENT_AVATAR_STATIC_FRAME,
  AGENT_AVATAR_STATES,
  type AgentAvatarState,
  agentAvatarDeity,
  agentAvatarFrameAt,
  selectAgentAvatar,
} from "./agentAvatars";

describe("agent avatar selection", () => {
  it("maps project colors and detected agents to the intended deities", () => {
    expect(AGENT_AVATAR_DEITY_BY_COLOR).toEqual([
      { claude: "athena", codex: "zeus" },
      { claude: "hera", codex: "hades" },
      { claude: "artemis", codex: "demeter" },
      { claude: "hermes", codex: "hephaestus" },
      { claude: "aphrodite", codex: "aphrodite" },
      { claude: "poseidon", codex: "poseidon" },
      { claude: "apollo", codex: "apollo" },
      { claude: "ares", codex: "ares" },
    ]);
    expect(agentAvatarDeity(0, "claude")).toBe("athena");
    expect(agentAvatarDeity(0, "codex")).toBe("zeus");
  });

  it("uses every deity across the eight-color mapping", () => {
    const mapped = new Set(
      AGENT_AVATAR_DEITY_BY_COLOR.flatMap(({ claude, codex }) => [
        claude,
        codex,
      ]),
    );
    expect(mapped).toEqual(new Set(AGENT_AVATAR_DEITIES));
  });

  it("gives every deity a unique code-rendered personality and activity", () => {
    const signatures = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].signature,
    );
    const costumes = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].costume,
    );
    const activities = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].activity,
    );
    expect(new Set(signatures).size).toBe(AGENT_AVATAR_DEITIES.length);
    expect(new Set(costumes).size).toBe(AGENT_AVATAR_DEITIES.length);
    expect(new Set(activities).size).toBe(AGENT_AVATAR_DEITIES.length);
    for (const deity of AGENT_AVATAR_DEITIES) {
      expect(AGENT_AVATAR_PERSONALITIES[deity].name).toBeTruthy();
    }
  });

  it("publishes four-frame timing and a valid still pose for every state", () => {
    expect(AGENT_AVATAR_FRAME_COUNT).toBe(4);
    for (const state of AGENT_AVATAR_STATES) {
      expect(AGENT_AVATAR_FRAME_MS[state]).toBeGreaterThan(0);
      expect(AGENT_AVATAR_STATIC_FRAME[state]).toBeGreaterThanOrEqual(0);
      expect(AGENT_AVATAR_STATIC_FRAME[state]).toBeLessThan(
        AGENT_AVATAR_FRAME_COUNT,
      );
      expect(agentAvatarFrameAt(state, 0)).toBe(0);
      expect(agentAvatarFrameAt(state, AGENT_AVATAR_FRAME_MS[state])).toBe(1);
      expect(
        agentAvatarFrameAt(
          state,
          AGENT_AVATAR_FRAME_MS[state] * AGENT_AVATAR_FRAME_COUNT,
        ),
      ).toBe(0);
    }
  });

  it("selects the matching lifecycle pose and subdues only absent sessions", () => {
    const displays: AgentAvatarState[] = [
      "starting",
      "working",
      "blocked",
      "done",
      "idle",
      "unknown",
    ];
    for (const display of displays) {
      const selected = selectAgentAvatar(1, "codex", display);
      expect(selected).toEqual({
        deity: "hades",
        state: display,
        subdued: false,
      });
    }

    expect(selectAgentAvatar(1, "codex", "absent")).toEqual({
      deity: "hades",
      state: "idle",
      subdued: true,
    });
  });

  it("falls back to the blue mapping for a stale palette index", () => {
    expect(agentAvatarDeity(99, "claude")).toBe("athena");
    expect(agentAvatarDeity(-1, "codex")).toBe("zeus");
  });
});
