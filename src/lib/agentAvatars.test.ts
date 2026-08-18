import { describe, expect, it } from "vitest";
import {
  AGENT_AVATAR_DEITIES,
  AGENT_AVATAR_DEITY_BY_COLOR,
  AGENT_AVATAR_FRAMES,
  AGENT_AVATAR_FRAME_COUNT,
  AGENT_AVATAR_FRAME_MS,
  AGENT_AVATAR_GRID,
  AGENT_AVATAR_PALETTE_KEYS,
  AGENT_AVATAR_PERSONALITIES,
  AGENT_AVATAR_SPRITE_SETS,
  AGENT_AVATAR_STATIC_FRAME,
  AGENT_AVATAR_STATES,
  type AgentAvatarState,
  agentAvatarDeity,
  agentAvatarFrameAt,
  agentAvatarPaletteVars,
  composeAgentAvatarEmpty,
  composeAgentAvatarFrame,
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

  it("gives every deity a unique silhouette, relic, aura, and regalia", () => {
    const crowns = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].crown,
    );
    const emblems = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].emblem,
    );
    const props = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].prop,
    );
    const auras = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].aura,
    );
    const regalia = AGENT_AVATAR_DEITIES.map(
      (deity) => AGENT_AVATAR_PERSONALITIES[deity].regalia,
    );
    expect(new Set(crowns).size).toBe(AGENT_AVATAR_DEITIES.length);
    expect(new Set(emblems).size).toBe(AGENT_AVATAR_DEITIES.length);
    expect(new Set(props).size).toBe(AGENT_AVATAR_DEITIES.length);
    expect(new Set(auras).size).toBe(AGENT_AVATAR_DEITIES.length);
    expect(new Set(regalia).size).toBe(AGENT_AVATAR_DEITIES.length);
    for (const deity of AGENT_AVATAR_DEITIES) {
      expect(AGENT_AVATAR_PERSONALITIES[deity].name).toBeTruthy();
    }
  });

  it("publishes four-frame timing and a valid still pose for every state", () => {
    expect(AGENT_AVATAR_FRAME_COUNT).toBe(4);
    for (const state of AGENT_AVATAR_STATES) {
      expect(AGENT_AVATAR_FRAMES[state]).toHaveLength(AGENT_AVATAR_FRAME_COUNT);
      // Calm cadence: nothing may flicker faster than a third of a second.
      expect(AGENT_AVATAR_FRAME_MS[state]).toBeGreaterThanOrEqual(350);
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

describe("agent avatar sprites", () => {
  const keys = new Set<string>([...AGENT_AVATAR_PALETTE_KEYS, "."]);

  it("authors every sprite as a rectangular grid of known palette keys", () => {
    for (const [setName, sprites] of Object.entries(
      AGENT_AVATAR_SPRITE_SETS,
    )) {
      for (const [name, rows] of Object.entries(sprites)) {
        expect(rows.length, `${setName}/${name}`).toBeGreaterThan(0);
        const width = rows[0].length;
        for (const row of rows) {
          expect(row.length, `${setName}/${name}`).toBe(width);
          for (const cell of row) {
            expect(keys.has(cell), `${setName}/${name}: "${cell}"`).toBe(true);
          }
        }
      }
    }
  });

  it("keeps every composed layer inside the logical grid", () => {
    for (const deity of AGENT_AVATAR_DEITIES) {
      for (const state of AGENT_AVATAR_STATES) {
        for (let frame = 0; frame < AGENT_AVATAR_FRAME_COUNT; frame++) {
          const layers = composeAgentAvatarFrame(deity, state, frame);
          expect(layers.length).toBeGreaterThan(0);
          for (const layer of layers) {
            expect(layer.alpha).toBeGreaterThan(0);
            expect(layer.alpha).toBeLessThanOrEqual(1);
            expect(layer.x).toBeGreaterThanOrEqual(0);
            expect(layer.y).toBeGreaterThanOrEqual(0);
            expect(layer.x + layer.rows[0].length).toBeLessThanOrEqual(
              AGENT_AVATAR_GRID,
            );
            expect(layer.y + layer.rows.length).toBeLessThanOrEqual(
              AGENT_AVATAR_GRID,
            );
          }
        }
      }
    }
  });

  it("composes a detailed working portrait without merging personality data", () => {
    for (const deity of AGENT_AVATAR_DEITIES) {
      const layers = composeAgentAvatarFrame(deity, "working", 1);
      // Aura, shadow, torso, regalia, face, crown, two hands, relic, glint,
      // and emblem stay independently authored and independently blitted.
      expect(layers.length, deity).toBeGreaterThanOrEqual(11);
    }
  });

  it("wraps out-of-range frame indices onto the four-frame loop", () => {
    expect(composeAgentAvatarFrame("athena", "working", 4)).toEqual(
      composeAgentAvatarFrame("athena", "working", 0),
    );
    expect(composeAgentAvatarFrame("athena", "working", -1)).toEqual(
      composeAgentAvatarFrame("athena", "working", 3),
    );
  });

  it("never moves the figure or its prop more than one pixel per frame", () => {
    for (const state of AGENT_AVATAR_STATES) {
      const frames = AGENT_AVATAR_FRAMES[state];
      for (let frame = 0; frame < frames.length; frame++) {
        const current = frames[frame];
        const next = frames[(frame + 1) % frames.length];
        const headDy = (spec: (typeof frames)[number]) =>
          spec.bodyDy + (spec.bow ? 1 : 0);
        expect(Math.abs(next.bodyDy - current.bodyDy)).toBeLessThanOrEqual(1);
        expect(Math.abs(headDy(next) - headDy(current))).toBeLessThanOrEqual(1);
        expect(Math.abs(next.propDy - current.propDy)).toBeLessThanOrEqual(1);
        expect(current.auraAlpha).toBeGreaterThanOrEqual(0);
        expect(current.auraAlpha).toBeLessThanOrEqual(1);
        expect(current.glintAlpha).toBeGreaterThanOrEqual(0);
        expect(current.glintAlpha).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps each state distinguishable in its own still frame", () => {
    const still = (state: AgentAvatarState) =>
      AGENT_AVATAR_FRAMES[state][AGENT_AVATAR_STATIC_FRAME[state]];
    const poses = AGENT_AVATAR_STATES.map((state) => {
      const spec = still(state);
      return `${spec.head}/${spec.cue ?? "none"}/${spec.prop}/${spec.figureAlpha}`;
    });
    expect(new Set(poses).size).toBe(AGENT_AVATAR_STATES.length);
    expect(still("working").prop).toBe(true);
    expect(still("blocked").cue).toBe("question");
    expect(still("done").cue).toBe("check");
    expect(still("unknown").figureAlpha).toBeLessThan(1);
    expect(still("starting").figureAlpha).toBe(1);
  });

  it("renders an absent session as an empty tile", () => {
    const layers = composeAgentAvatarEmpty();
    expect(layers).toHaveLength(1);
    expect(layers[0].alpha).toBeLessThan(1);
    for (const row of layers[0].rows) {
      expect(row.replace(/[o.]/g, "")).toBe("");
    }
  });

  it("resolves every palette key to a theme custom property", () => {
    const vars = agentAvatarPaletteVars("hades", 3);
    for (const key of AGENT_AVATAR_PALETTE_KEYS) {
      expect(vars[key]?.startsWith("--")).toBe(true);
    }
    expect(vars.a).toBe("--project-3");
    expect(vars.f).toBe("--agent-avatar-hades-robe");
    expect(vars.e).toBe("--agent-avatar-hades-glow");
  });
});
