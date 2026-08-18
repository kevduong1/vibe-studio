import type { AgentDisplayState, AgentKind } from "./agentState";

export const AGENT_AVATAR_DEITIES = [
  "aphrodite",
  "apollo",
  "ares",
  "artemis",
  "athena",
  "demeter",
  "hades",
  "hephaestus",
  "hera",
  "hermes",
  "poseidon",
  "zeus",
] as const;

export type AgentAvatarDeity = (typeof AGENT_AVATAR_DEITIES)[number];
export type AgentAvatarState = Exclude<AgentDisplayState, "absent">;

export const AGENT_AVATAR_STATES = [
  "idle",
  "starting",
  "working",
  "blocked",
  "done",
  "unknown",
] as const satisfies readonly AgentAvatarState[];

export type AgentAvatarSignature =
  | "hearts"
  | "sun"
  | "sword"
  | "moon"
  | "owl"
  | "wheat"
  | "portal"
  | "forge"
  | "peacock"
  | "message"
  | "wave"
  | "lightning";

export type AgentAvatarCostume =
  | "flower-dress"
  | "laurel-tunic"
  | "war-helm"
  | "moon-huntress"
  | "owl-helm"
  | "harvest-hood"
  | "underworld-crown"
  | "smith-apron"
  | "queen-crown"
  | "winged-helm"
  | "sea-king"
  | "sky-king";

export type AgentAvatarActivity =
  | "rose-garden"
  | "lyre"
  | "sword-drill"
  | "archery"
  | "weaving"
  | "harvest"
  | "summoning"
  | "smithing"
  | "royal-audience"
  | "courier"
  | "tide-calling"
  | "storm-calling";

export interface AgentAvatarPersonality {
  name: string;
  signature: AgentAvatarSignature;
  costume: AgentAvatarCostume;
  activity: AgentAvatarActivity;
}

/** Small, deliberately hand-authored personality vocabulary for the Canvas
 * renderer. Semantic state owns the readable lifecycle pose, while working
 * uses the deity's own activity and choreography instead of a shared desk. */
export const AGENT_AVATAR_PERSONALITIES: Record<
  AgentAvatarDeity,
  AgentAvatarPersonality
> = {
  aphrodite: {
    name: "Aphrodite",
    signature: "hearts",
    costume: "flower-dress",
    activity: "rose-garden",
  },
  apollo: {
    name: "Apollo",
    signature: "sun",
    costume: "laurel-tunic",
    activity: "lyre",
  },
  ares: {
    name: "Ares",
    signature: "sword",
    costume: "war-helm",
    activity: "sword-drill",
  },
  artemis: {
    name: "Artemis",
    signature: "moon",
    costume: "moon-huntress",
    activity: "archery",
  },
  athena: {
    name: "Athena",
    signature: "owl",
    costume: "owl-helm",
    activity: "weaving",
  },
  demeter: {
    name: "Demeter",
    signature: "wheat",
    costume: "harvest-hood",
    activity: "harvest",
  },
  hades: {
    name: "Hades",
    signature: "portal",
    costume: "underworld-crown",
    activity: "summoning",
  },
  hephaestus: {
    name: "Hephaestus",
    signature: "forge",
    costume: "smith-apron",
    activity: "smithing",
  },
  hera: {
    name: "Hera",
    signature: "peacock",
    costume: "queen-crown",
    activity: "royal-audience",
  },
  hermes: {
    name: "Hermes",
    signature: "message",
    costume: "winged-helm",
    activity: "courier",
  },
  poseidon: {
    name: "Poseidon",
    signature: "wave",
    costume: "sea-king",
    activity: "tide-calling",
  },
  zeus: {
    name: "Zeus",
    signature: "lightning",
    costume: "sky-king",
    activity: "storm-calling",
  },
};

/** Project palette index + detected runtime kind chooses the character. The
 * shared single-character colors are intentional and keep all twelve deities
 * addressable across the eight-color palette. */
export const AGENT_AVATAR_DEITY_BY_COLOR = [
  { claude: "athena", codex: "zeus" },
  { claude: "hera", codex: "hades" },
  { claude: "artemis", codex: "demeter" },
  { claude: "hermes", codex: "hephaestus" },
  { claude: "aphrodite", codex: "aphrodite" },
  { claude: "poseidon", codex: "poseidon" },
  { claude: "apollo", codex: "apollo" },
  { claude: "ares", codex: "ares" },
] as const satisfies readonly Record<AgentKind, AgentAvatarDeity>[];

export const AGENT_AVATAR_FRAME_COUNT = 4;

/** Slower quiet/waiting loops keep the sidebar calm; active states read at a
 * glance without turning every row into constant visual noise. */
export const AGENT_AVATAR_FRAME_MS: Record<AgentAvatarState, number> = {
  starting: 180,
  working: 150,
  blocked: 480,
  done: 240,
  idle: 620,
  unknown: 380,
};

/** Most descriptive pose for a non-animated presentation of each state. */
export const AGENT_AVATAR_STATIC_FRAME: Record<AgentAvatarState, number> = {
  starting: 3,
  working: 1,
  blocked: 2,
  done: 2,
  idle: 0,
  unknown: 1,
};

export function agentAvatarDeity(
  projectColorIndex: number,
  kind: AgentKind,
): AgentAvatarDeity {
  return (
    AGENT_AVATAR_DEITY_BY_COLOR[projectColorIndex]?.[kind] ??
    AGENT_AVATAR_DEITY_BY_COLOR[0][kind]
  );
}

export function agentAvatarState(
  display: AgentDisplayState,
): AgentAvatarState {
  return display === "absent" ? "idle" : display;
}

export function agentAvatarFrameAt(
  state: AgentAvatarState,
  elapsedMs: number,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / AGENT_AVATAR_FRAME_MS[state]) %
    AGENT_AVATAR_FRAME_COUNT;
}

export interface AgentAvatarSelection {
  deity: AgentAvatarDeity;
  state: AgentAvatarState;
  /** Absent sessions render an empty, dim terrarium rather than implying a
   * quiet live agent. */
  subdued: boolean;
}

export function selectAgentAvatar(
  projectColorIndex: number,
  kind: AgentKind,
  display: AgentDisplayState,
): AgentAvatarSelection {
  return {
    deity: agentAvatarDeity(projectColorIndex, kind),
    state: agentAvatarState(display),
    subdued: display === "absent",
  };
}

export function agentAvatarName(deity: AgentAvatarDeity): string {
  return AGENT_AVATAR_PERSONALITIES[deity].name;
}
