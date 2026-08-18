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

/** Hand-authored sprites live on a 20x20 logical grid that scales by an
 * integer factor into the 80px tile, so every art pixel stays square. */
export const AGENT_AVATAR_GRID = 20;

/* ---------------------------------------------------------------------------
 * Palette
 *
 * Sprites are rows of palette keys; every key resolves to a CSS custom
 * property at draw time (AgentAvatar.tsx). No color literal ever lives here.
 * ------------------------------------------------------------------------ */

export const AGENT_AVATAR_PALETTE_KEYS = [
  "k", // ink outline
  "s", // skin
  "S", // skin shade
  "w", // eye
  "h", // hair / headgear
  "f", // robe
  "F", // robe shade
  "a", // project accent (robe stole — keeps rows project-tinted)
  "e", // deity signature glow (emblem, crown jewels, prop)
  "d", // highlight
  "p", // neutral prop material
  "o", // ground shadow
] as const;

export type AgentAvatarPaletteKey = (typeof AGENT_AVATAR_PALETTE_KEYS)[number];

const SHARED_COLOR_VARS = {
  k: "--agent-avatar-outline",
  s: "--agent-avatar-skin",
  S: "--agent-avatar-skin-shade",
  w: "--agent-avatar-eye",
  d: "--agent-avatar-highlight",
  p: "--agent-avatar-prop",
  o: "--agent-avatar-shadow",
} as const satisfies Partial<Record<AgentAvatarPaletteKey, string>>;

const DEITY_COLOR_SUFFIX = {
  h: "hair",
  f: "robe",
  F: "robe-shade",
  e: "glow",
} as const satisfies Partial<Record<AgentAvatarPaletteKey, string>>;

/** CSS custom property name for every palette key of one rendered avatar. */
export function agentAvatarPaletteVars(
  deity: AgentAvatarDeity,
  projectColorIndex: number,
): Record<AgentAvatarPaletteKey, string> {
  const vars = {} as Record<AgentAvatarPaletteKey, string>;
  for (const [key, name] of Object.entries(SHARED_COLOR_VARS)) {
    vars[key as AgentAvatarPaletteKey] = name;
  }
  for (const [key, suffix] of Object.entries(DEITY_COLOR_SUFFIX)) {
    vars[key as AgentAvatarPaletteKey] = `--agent-avatar-${deity}-${suffix}`;
  }
  vars.a = `--project-${projectColorIndex}`;
  return vars;
}

/* ---------------------------------------------------------------------------
 * Sprites
 * ------------------------------------------------------------------------ */

export interface AgentAvatarSprite {
  readonly rows: readonly string[];
  /** Grid column of the sprite's first character. */
  readonly x: number;
  /** Grid row of the sprite's first row. */
  readonly y: number;
}

/** One blit request: a sprite already positioned for this frame. */
export interface AgentAvatarLayer extends AgentAvatarSprite {
  /** 0..1; the renderer applies it as canvas alpha. */
  readonly alpha: number;
}

const SHADOW: AgentAvatarSprite = {
  rows: ["oooooooooooo"],
  x: 4,
  y: 18,
};

/** Shoulders down to the hem. The accent stole runs down the middle so every
 * row stays tinted by its own project color. */
const TORSO: AgentAvatarSprite = {
  rows: [
    "....kffffaaffffk....",
    "....kfffaaaafffk....",
    "...kffffaaaaffffk...",
    "...kfffFaaaaFfffk...",
    "...kffFFaaaaFFffk...",
    "...kFFFFaaaaFFFFk...",
  ],
  x: 0,
  y: 12,
};

const HAND_LEFT: AgentAvatarSprite = { rows: ["ss"], x: 6, y: 15 };
const HAND_RIGHT: AgentAvatarSprite = { rows: ["ss"], x: 12, y: 15 };

export type AgentAvatarHead = "open" | "blink" | "up" | "down" | "happy";

const HEAD_X = 6;
const HEAD_Y = 5;

/** Five head variants carry the whole readable-in-a-still-frame burden: the
 * eyes move inside the face instead of the body moving across the tile. */
const HEADS: Record<AgentAvatarHead, readonly string[]> = {
  open: [
    ".kkkkkk.",
    "khhhhhhk",
    "khhsshhk",
    "kswsswsk",
    "kssssssk",
    ".kSssSk.",
    "..kssk..",
  ],
  blink: [
    ".kkkkkk.",
    "khhhhhhk",
    "khhsshhk",
    "kwwsswwk",
    "kssssssk",
    ".kSssSk.",
    "..kssk..",
  ],
  up: [
    ".kkkkkk.",
    "khhhhhhk",
    "khwsswhk",
    "kssssssk",
    "kssssssk",
    ".kSssSk.",
    "..kssk..",
  ],
  down: [
    ".kkkkkk.",
    "khhhhhhk",
    "khhsshhk",
    "kssssssk",
    "kswsswsk",
    ".kSssSk.",
    "..kssk..",
  ],
  happy: [
    ".kkkkkk.",
    "khhhhhhk",
    "khhsshhk",
    "kwwsswwk",
    "kssSSssk",
    ".kSssSk.",
    "..kssk..",
  ],
};

export type AgentAvatarCrown =
  | "crested-helm"
  | "storm-laurel"
  | "coral-crown"
  | "jewel-diadem"
  | "crescent-tiara"
  | "sun-laurel"
  | "war-helm"
  | "wheat-wreath"
  | "shade-hood"
  | "forge-goggles"
  | "winged-cap"
  | "blossom-hair";

const CROWN_X = 5;
const CROWN_Y = 1;

const CROWNS: Record<AgentAvatarCrown, readonly string[]> = {
  "crested-helm": [
    "....ee....",
    "....ee....",
    "...eeee...",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".h......h.",
  ],
  "storm-laurel": [
    "..........",
    "..e....e..",
    "...e..e...",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".heeeeeeh.",
  ],
  "coral-crown": [
    "..e.ee.e..",
    "..e.ee.e..",
    "..eeeeee..",
    "...hhhh...",
    ".hhhhhhhh.",
    ".h......h.",
  ],
  "jewel-diadem": [
    "....dd....",
    "..e.ee.e..",
    "..eeeeee..",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".h......h.",
  ],
  "crescent-tiara": [
    "..........",
    "...e.e....",
    "..e...e...",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".hh....hh.",
  ],
  "sun-laurel": [
    "..........",
    ".e......e.",
    "..e....e..",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".hee..eeh.",
  ],
  "war-helm": [
    ".......ee.",
    "......ee..",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".hhhhhhhh.",
    ".h......h.",
  ],
  "wheat-wreath": [
    "..........",
    ".e.e..e.e.",
    "..e.ee.e..",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".hh....hh.",
  ],
  "shade-hood": [
    "....e.....",
    "...eee....",
    "..hhhhhh..",
    ".hhhhhhhh.",
    "hhhhhhhhhh",
    "hh......hh",
  ],
  "forge-goggles": [
    "..........",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".hhhhhhhh.",
    ".hhhhhhhh.",
    ".ddeeeedd.",
  ],
  "winged-cap": [
    "..........",
    "..hhhhhh..",
    ".hhhhhhhh.",
    "ehhhhhhhhe",
    "eehhhhhhee",
    ".h......h.",
  ],
  "blossom-hair": [
    "..........",
    "...hhhh...",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".hhhhhhhh.",
    "hhh....ehh",
  ],
};

export type AgentAvatarEmblem =
  | "owl"
  | "bolt"
  | "wave"
  | "sun"
  | "moon"
  | "heart"
  | "wheat"
  | "hammer"
  | "sword"
  | "feather"
  | "wing"
  | "skull";

const EMBLEM_X = 15;
const EMBLEM_Y = 1;

const EMBLEMS: Record<AgentAvatarEmblem, readonly string[]> = {
  owl: [".e.e.", "eeeee", "edede", "eeeee", ".e.e."],
  bolt: ["...ee", "..ee.", ".eeee", "...ee", "..ee."],
  wave: [".....", "..ee.", ".e..e", "ee.ee", "....."],
  sun: ["..d..", ".eee.", "deeed", ".eee.", "..d.."],
  moon: [".eee.", "ee...", "ee...", "ee...", ".eee."],
  heart: [".e.e.", "eeeee", "eeeee", ".eee.", "..e.."],
  wheat: ["..d..", ".eee.", "..e..", ".eee.", "..e.."],
  hammer: ["eeee.", "eeee.", "..d..", "..d..", "..d.."],
  sword: ["...ee", "..ee.", ".ded.", "ee...", "e...."],
  feather: [".eee.", "eddde", "edwde", "eddde", ".eee."],
  wing: ["e....", "eee..", "eeeee", "eee..", "e...."],
  skull: [".eee.", "ekeke", "eeeee", ".e.e.", "....."],
};

export type AgentAvatarProp =
  | "scroll"
  | "bolt-shard"
  | "trident"
  | "lyre"
  | "hunting-bow"
  | "rose"
  | "wheat-sheaf"
  | "hammer"
  | "sword"
  | "scepter"
  | "sealed-letter"
  | "shade-flame";

const PROP_X = 13;
const PROP_Y = 8;

/** The working prop is the only thing that moves during focused work, and it
 * moves at most one pixel. */
const PROPS: Record<AgentAvatarProp, readonly string[]> = {
  scroll: [
    "......",
    "......",
    ".pdddp",
    ".pdddp",
    ".pdddp",
    "......",
    "......",
  ],
  "bolt-shard": [
    "...ee.",
    "..ee..",
    ".eeee.",
    "...ee.",
    "..ee..",
    "..e...",
    "......",
  ],
  trident: [
    ".e.e.e",
    ".e.e.e",
    ".eeeee",
    "...e..",
    "...e..",
    "...e..",
    "...e..",
  ],
  lyre: [
    ".e..e.",
    ".e..e.",
    ".edde.",
    ".edde.",
    ".eeee.",
    "......",
    "......",
  ],
  "hunting-bow": [
    "...e..",
    "..e.d.",
    ".e..d.",
    ".e..d.",
    ".e..d.",
    "..e.d.",
    "...e..",
  ],
  rose: [
    "..ee..",
    ".eded.",
    "..ee..",
    "...p..",
    "..pp..",
    "...p..",
    "......",
  ],
  "wheat-sheaf": [
    ".d.d..",
    "..d.d.",
    ".d.d..",
    "..d...",
    "..e...",
    "..e...",
    "..e...",
  ],
  hammer: [
    "..dppd",
    "..dppd",
    "...pp.",
    "...p..",
    "..p...",
    ".p....",
    ".p....",
  ],
  sword: [
    "...e..",
    "...e..",
    "...e..",
    "...e..",
    "..ddd.",
    "...p..",
    "...p..",
  ],
  scepter: [
    "..de..",
    "..ed..",
    "...p..",
    "...p..",
    "...p..",
    "...p..",
    "...p..",
  ],
  "sealed-letter": [
    "......",
    "......",
    "......",
    ".dddd.",
    ".deed.",
    ".dddd.",
    "......",
  ],
  "shade-flame": [
    "...d..",
    "..ded.",
    "..eee.",
    "...e..",
    "......",
    "......",
    "......",
  ],
};

export type AgentAvatarCue = "question" | "check" | "scan" | "spark";

const CUE_X = 0;
const CUE_Y = 1;

/** Small state cues sit in the corner opposite the emblem, clear of every
 * headgear silhouette, so a still frame still says which lifecycle state it
 * is. */
const CUES: Record<AgentAvatarCue, readonly string[]> = {
  question: [".eee.", "e...e", "..ee.", ".....", "..e.."],
  check: [".....", "....d", "...d.", "d.d..", ".d..."],
  scan: [".....", ".....", "d.d.d", ".....", "....."],
  spark: ["..d..", "..d..", "ddddd", "..d..", "..d.."],
};

export type AgentAvatarAura =
  | "rose-vines"
  | "solar-rays"
  | "battle-flare"
  | "moon-arc"
  | "aegis-wings"
  | "harvest-vines"
  | "underworld-rift"
  | "forge-sparks"
  | "royal-fan"
  | "wind-streams"
  | "tide-rings"
  | "storm-field";

const AURA_X = 3;
const AURA_Y = 2;

/** Large, low-alpha silhouettes sit behind the figure. They make the cast
 * distinguishable before the eye reaches the small emblem or held relic. */
const AURAS: Record<AgentAvatarAura, readonly string[]> = {
  "rose-vines": [
    "e............e",
    ".e..........e.",
    "..e........e..",
    ".e..........e.",
    "e....e..e....e",
    ".e..e....e..e.",
    "..e........e..",
    "...e......e...",
    "..e........e..",
    ".e..........e.",
    "e............e",
    ".e..........e.",
    "..e........e..",
    "...e......e...",
    "....e....e....",
    ".....e..e.....",
  ],
  "solar-rays": [
    "......e.......",
    "..e...e...e...",
    "...e..e..e....",
    "....e.e.e.....",
    "ee...eee...eee",
    "...eeeeeeee...",
    ".....eeee.....",
    "...eeeeeeee...",
    "ee...eee...eee",
    "....e.e.e.....",
    "...e..e..e....",
    "..e...e...e...",
    "......e.......",
    "......e.......",
    "..............",
    "..............",
  ],
  "battle-flare": [
    "e............e",
    ".e..........e.",
    "..e...ee...e..",
    "...e.e..e.e...",
    "....e....e....",
    "...e......e...",
    "..e...ee...e..",
    ".e...e..e...e.",
    "e...e....e...e",
    ".e...e..e...e.",
    "..e...ee...e..",
    "...e......e...",
    "....e....e....",
    "...e.e..e.e...",
    "..e...ee...e..",
    ".e..........e.",
  ],
  "moon-arc": [
    "....eeeeee....",
    "..ee......ee..",
    ".e..........e.",
    "e............e",
    "e.............",
    "e.............",
    ".e............",
    "..e...........",
    "...e..........",
    "....e.........",
    ".....e........",
    "......e.......",
    ".......e......",
    "........e.....",
    ".........e....",
    "..............",
  ],
  "aegis-wings": [
    "......ee......",
    "...e..ee..e...",
    "..ee..ee..ee..",
    ".eee..ee..eee.",
    "eeee..ee..eeee",
    ".eee..ee..eee.",
    "..ee..ee..ee..",
    "...e..ee..e...",
    "......ee......",
    ".....eeee.....",
    "....ee..ee....",
    "...ee....ee...",
    "..ee......ee..",
    ".ee........ee.",
    "e............e",
    "..............",
  ],
  "harvest-vines": [
    "e............e",
    "ee..........ee",
    ".ee........ee.",
    "..e........e..",
    ".e.e......e.e.",
    "e..e......e..e",
    ".e.e......e.e.",
    "..e........e..",
    ".e.e......e.e.",
    "e..e......e..e",
    ".e.e......e.e.",
    "..e........e..",
    ".ee........ee.",
    "ee..........ee",
    "e............e",
    "..............",
  ],
  "underworld-rift": [
    "......e.......",
    ".....e........",
    "......e.......",
    "....ee........",
    ".....e........",
    "...ee.........",
    "....ee........",
    "..ee..........",
    "...ee.........",
    ".....ee.......",
    "....ee........",
    "......ee......",
    ".....ee.......",
    ".......ee.....",
    "......e.......",
    "..............",
  ],
  "forge-sparks": [
    "e.....e.....e.",
    "..e.......e...",
    "....e.e.......",
    ".e.........e..",
    ".....e....e...",
    "e.......e.....",
    "...e.......e..",
    "......e.......",
    ".e.........e..",
    "....e.....e...",
    "..e.....e.....",
    "e..........e..",
    ".....e........",
    "...e......e...",
    ".e............",
    "..............",
  ],
  "royal-fan": [
    "e.e.e.ee.e.e.e",
    ".e.e.e..e.e.e.",
    "..e.e....e.e..",
    "...e......e...",
    "....e....e....",
    ".....e..e.....",
    "......ee......",
    "......ee......",
    ".....e..e.....",
    "....e....e....",
    "...e......e...",
    "..e........e..",
    ".e..........e.",
    "e............e",
    "..............",
    "..............",
  ],
  "wind-streams": [
    "..............",
    "...eeeeeee....",
    ".ee.......ee..",
    "e.............",
    "..eeeeeeeeee..",
    "ee..........ee",
    "..............",
    "....eeeeeeee..",
    "..ee........ee",
    ".e............",
    "...eeeeeeeee..",
    "...........ee.",
    "..............",
    "..eeeeeeee....",
    "ee........ee..",
    "..............",
  ],
  "tide-rings": [
    "....eeeeee....",
    "..ee......ee..",
    ".e..........e.",
    "e............e",
    "..............",
    "..eeeeeeeeee..",
    ".e..........e.",
    "e............e",
    "..............",
    "...eeeeeeee...",
    ".ee........ee.",
    "e............e",
    "..............",
    "..eeeeeeeeee..",
    "ee..........ee",
    "..............",
  ],
  "storm-field": [
    "...e......e...",
    "..e......e....",
    ".eeee...eeee..",
    "...e......e...",
    "..e......e....",
    "..............",
    "......e.......",
    ".....e........",
    "....eeee......",
    "......e.......",
    ".....e........",
    "..............",
    ".e......e.....",
    "eeee...eeee...",
    ".e......e.....",
    "..............",
  ],
};

export type AgentAvatarRegalia =
  | "rose-chain"
  | "sun-clasp"
  | "war-plate"
  | "hunter-strap"
  | "aegis"
  | "grain-vines"
  | "shade-chains"
  | "forge-apron"
  | "peacock-bodice"
  | "courier-straps"
  | "scale-mail"
  | "storm-sash";

const REGALIA_X = 3;
const REGALIA_Y = 12;

/** Torso overlays keep the shared body economical without giving every deity
 * the same robe. The project-colored stole remains visible underneath. */
const REGALIA: Record<AgentAvatarRegalia, readonly string[]> = {
  "rose-chain": [
    "..e........e..",
    "...e......e...",
    "....e....e....",
    ".....eeee.....",
    "......ee......",
    ".....e..e.....",
  ],
  "sun-clasp": [
    "......ee......",
    ".....edde.....",
    "....edddde....",
    ".....edde.....",
    "......ee......",
    "..e........e..",
  ],
  "war-plate": [
    "..p........p..",
    ".ppp......ppp.",
    ".p.k......k.p.",
    "..pppppppppp..",
    ".....p..p.....",
    "....pp..pp....",
  ],
  "hunter-strap": [
    "e.............",
    ".e............",
    "..e...........",
    "...e......e...",
    "....e....eee..",
    ".....e....e...",
  ],
  aegis: [
    "pp..........pp",
    ".pp........pp.",
    "..p..eeee..p..",
    "...eekkkkee...",
    "....eekkee....",
    "..p...ee...p..",
  ],
  "grain-vines": [
    "e............e",
    ".e..........e.",
    "..e...dd...e..",
    "...e..dd..e...",
    "....e....e....",
    "..e..e..e..e..",
  ],
  "shade-chains": [
    "p............p",
    ".p..........p.",
    "..p........p..",
    "...p......p...",
    "....p.eep.....",
    ".....eeee.....",
  ],
  "forge-apron": [
    "p.p........p.p",
    ".ppp......ppp.",
    "...pppppppp...",
    "...p.d..d.p...",
    "..pp......pp..",
    "..p..dddd..p..",
  ],
  "peacock-bodice": [
    "e.....dd.....e",
    ".e...deed...e.",
    "..e..eeee..e..",
    "...e..ee..e...",
    "....e....e....",
    "..e...ee...e..",
  ],
  "courier-straps": [
    "p............p",
    ".p..........p.",
    "..p........p..",
    "...p......p...",
    "....p....p....",
    ".....p..p.....",
  ],
  "scale-mail": [
    ".e.e.e..e.e.e.",
    "e.e.e.ee.e.e.e",
    ".e.e.e..e.e.e.",
    "e.e.e.ee.e.e.e",
    ".e.e.e..e.e.e.",
    "..eeeeeeeeee..",
  ],
  "storm-sash": [
    "e............e",
    ".e..........e.",
    "..ee......ee..",
    "...ee....ee...",
    "....eeeeee....",
    "..e...ee...e..",
  ],
};

const RELIC_GLINT: readonly string[] = [".d.", "ded", ".d."];
const RELIC_GLINT_X = 17;
const RELIC_GLINT_Y = 7;

/* ---------------------------------------------------------------------------
 * Personalities
 * ------------------------------------------------------------------------ */

export interface AgentAvatarPersonality {
  name: string;
  crown: AgentAvatarCrown;
  emblem: AgentAvatarEmblem;
  prop: AgentAvatarProp;
  aura: AgentAvatarAura;
  regalia: AgentAvatarRegalia;
}

/** Every deity owns a distinct headgear silhouette, corner emblem, held
 * working prop, aura, and robe overlay; the body underneath is deliberately
 * shared so the twelve characters read as one cast. */
export const AGENT_AVATAR_PERSONALITIES: Record<
  AgentAvatarDeity,
  AgentAvatarPersonality
> = {
  aphrodite: {
    name: "Aphrodite",
    crown: "blossom-hair",
    emblem: "heart",
    prop: "rose",
    aura: "rose-vines",
    regalia: "rose-chain",
  },
  apollo: {
    name: "Apollo",
    crown: "sun-laurel",
    emblem: "sun",
    prop: "lyre",
    aura: "solar-rays",
    regalia: "sun-clasp",
  },
  ares: {
    name: "Ares",
    crown: "war-helm",
    emblem: "sword",
    prop: "sword",
    aura: "battle-flare",
    regalia: "war-plate",
  },
  artemis: {
    name: "Artemis",
    crown: "crescent-tiara",
    emblem: "moon",
    prop: "hunting-bow",
    aura: "moon-arc",
    regalia: "hunter-strap",
  },
  athena: {
    name: "Athena",
    crown: "crested-helm",
    emblem: "owl",
    prop: "scroll",
    aura: "aegis-wings",
    regalia: "aegis",
  },
  demeter: {
    name: "Demeter",
    crown: "wheat-wreath",
    emblem: "wheat",
    prop: "wheat-sheaf",
    aura: "harvest-vines",
    regalia: "grain-vines",
  },
  hades: {
    name: "Hades",
    crown: "shade-hood",
    emblem: "skull",
    prop: "shade-flame",
    aura: "underworld-rift",
    regalia: "shade-chains",
  },
  hephaestus: {
    name: "Hephaestus",
    crown: "forge-goggles",
    emblem: "hammer",
    prop: "hammer",
    aura: "forge-sparks",
    regalia: "forge-apron",
  },
  hera: {
    name: "Hera",
    crown: "jewel-diadem",
    emblem: "feather",
    prop: "scepter",
    aura: "royal-fan",
    regalia: "peacock-bodice",
  },
  hermes: {
    name: "Hermes",
    crown: "winged-cap",
    emblem: "wing",
    prop: "sealed-letter",
    aura: "wind-streams",
    regalia: "courier-straps",
  },
  poseidon: {
    name: "Poseidon",
    crown: "coral-crown",
    emblem: "wave",
    prop: "trident",
    aura: "tide-rings",
    regalia: "scale-mail",
  },
  zeus: {
    name: "Zeus",
    crown: "storm-laurel",
    emblem: "bolt",
    prop: "bolt-shard",
    aura: "storm-field",
    regalia: "storm-sash",
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

/* ---------------------------------------------------------------------------
 * Timing and frames
 * ------------------------------------------------------------------------ */

export const AGENT_AVATAR_FRAME_COUNT = 4;

/** Calm cadences: a sidebar full of avatars must never read as motion. Even
 * the fastest loop (the starting fade-in) changes only opacity. */
export const AGENT_AVATAR_FRAME_MS: Record<AgentAvatarState, number> = {
  idle: 1100,
  starting: 350,
  working: 560,
  blocked: 800,
  done: 600,
  unknown: 900,
};

/** Most descriptive pose for a non-animated presentation of each state. */
export const AGENT_AVATAR_STATIC_FRAME: Record<AgentAvatarState, number> = {
  idle: 0,
  starting: 3,
  working: 1,
  blocked: 1,
  done: 1,
  unknown: 1,
};

export interface AgentAvatarFrameSpec {
  head: AgentAvatarHead;
  /** Whole-figure breathing bob, never more than one pixel. */
  bodyDy: 0 | 1;
  /** Head lowered into the shoulders (focused work). */
  bow: boolean;
  hands: boolean;
  prop: boolean;
  /** Held-prop tilt, never more than one pixel. */
  propDy: -1 | 0;
  cue: AgentAvatarCue | null;
  cueAlpha: number;
  figureAlpha: number;
  emblemAlpha: number;
  auraAlpha: number;
  glintAlpha: number;
}

const FULL = {
  bodyDy: 0,
  bow: false,
  hands: false,
  prop: false,
  propDy: 0,
  cue: null,
  cueAlpha: 1,
  figureAlpha: 1,
  emblemAlpha: 0.85,
  auraAlpha: 0.12,
  glintAlpha: 0,
} as const satisfies Omit<AgentAvatarFrameSpec, "head">;

export const AGENT_AVATAR_FRAMES: Record<
  AgentAvatarState,
  readonly AgentAvatarFrameSpec[]
> = {
  // A slow breath with one blink at the bottom of it.
  idle: [
    { ...FULL, head: "open" },
    { ...FULL, head: "open", bodyDy: 1 },
    { ...FULL, head: "blink", bodyDy: 1 },
    { ...FULL, head: "open" },
  ],
  // Materialize in place: opacity only, no movement at all.
  starting: [
    {
      ...FULL,
      head: "open",
      figureAlpha: 0.3,
      emblemAlpha: 0.2,
      auraAlpha: 0,
    },
    {
      ...FULL,
      head: "open",
      figureAlpha: 0.55,
      emblemAlpha: 0.4,
      auraAlpha: 0.04,
    },
    {
      ...FULL,
      head: "open",
      figureAlpha: 0.8,
      emblemAlpha: 0.6,
      auraAlpha: 0.1,
      cue: "spark",
      cueAlpha: 0.5,
    },
    {
      ...FULL,
      head: "open",
      cue: "spark",
      cueAlpha: 0.9,
      auraAlpha: 0.16,
    },
  ],
  // Head down over a held prop; the prop taps one pixel.
  working: [
    {
      ...FULL,
      head: "down",
      bow: true,
      hands: true,
      prop: true,
      auraAlpha: 0.16,
      glintAlpha: 0.25,
    },
    {
      ...FULL,
      head: "down",
      bow: true,
      hands: true,
      prop: true,
      propDy: -1,
      emblemAlpha: 1,
      auraAlpha: 0.28,
      glintAlpha: 1,
    },
    {
      ...FULL,
      head: "down",
      bow: true,
      hands: true,
      prop: true,
      propDy: -1,
      auraAlpha: 0.24,
      glintAlpha: 0.65,
    },
    {
      ...FULL,
      head: "down",
      bow: true,
      hands: true,
      prop: true,
      auraAlpha: 0.16,
      glintAlpha: 0.25,
    },
  ],
  // Patient look up with a slowly pulsing question; the tile border already
  // carries the unseen-prompt attention pulse, so the canvas stays still.
  blocked: [
    {
      ...FULL,
      head: "up",
      cue: "question",
      cueAlpha: 0.45,
      auraAlpha: 0.07,
    },
    { ...FULL, head: "up", cue: "question", cueAlpha: 1, auraAlpha: 0.1 },
    { ...FULL, head: "up", cue: "question", cueAlpha: 1, auraAlpha: 0.1 },
    {
      ...FULL,
      head: "up",
      cue: "question",
      cueAlpha: 0.6,
      auraAlpha: 0.07,
    },
  ],
  // Content pose with a check that twinkles once per loop.
  done: [
    {
      ...FULL,
      head: "happy",
      cue: "check",
      cueAlpha: 0.8,
      auraAlpha: 0.18,
    },
    {
      ...FULL,
      head: "happy",
      cue: "check",
      cueAlpha: 1,
      emblemAlpha: 1,
      auraAlpha: 0.28,
    },
    {
      ...FULL,
      head: "happy",
      bodyDy: 1,
      cue: "check",
      cueAlpha: 0.8,
      auraAlpha: 0.22,
    },
    {
      ...FULL,
      head: "happy",
      cue: "check",
      cueAlpha: 0.8,
      auraAlpha: 0.18,
    },
  ],
  // Dimmed, with a quiet scanning blink.
  unknown: [
    {
      ...FULL,
      head: "blink",
      figureAlpha: 0.6,
      emblemAlpha: 0.35,
      cue: "scan",
      cueAlpha: 0.45,
      auraAlpha: 0.03,
    },
    {
      ...FULL,
      head: "open",
      figureAlpha: 0.6,
      emblemAlpha: 0.35,
      cue: "scan",
      cueAlpha: 0.8,
      auraAlpha: 0.05,
    },
    {
      ...FULL,
      head: "open",
      figureAlpha: 0.6,
      emblemAlpha: 0.35,
      cue: "scan",
      cueAlpha: 0.8,
      auraAlpha: 0.05,
    },
    {
      ...FULL,
      head: "blink",
      figureAlpha: 0.6,
      emblemAlpha: 0.35,
      cue: "scan",
      cueAlpha: 0.45,
      auraAlpha: 0.03,
    },
  ],
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

/** An absent session keeps its tile visibly empty — only the ground shadow,
 * so the box never implies a quiet live agent. */
export function composeAgentAvatarEmpty(): AgentAvatarLayer[] {
  return [{ ...SHADOW, alpha: 0.35 }];
}

/** Ordered blit list for one deity/state/frame. Pure: the renderer only maps
 * palette keys to resolved theme colors and fills rectangles. */
export function composeAgentAvatarFrame(
  deity: AgentAvatarDeity,
  state: AgentAvatarState,
  frame: number,
): AgentAvatarLayer[] {
  const frames = AGENT_AVATAR_FRAMES[state];
  const spec = frames[
    ((frame % frames.length) + frames.length) % frames.length
  ] as AgentAvatarFrameSpec;
  const personality = AGENT_AVATAR_PERSONALITIES[deity];
  const dy = spec.bodyDy;
  const alpha = spec.figureAlpha;
  const layers: AgentAvatarLayer[] = [];
  if (spec.auraAlpha > 0) {
    layers.push({
      rows: AURAS[personality.aura],
      x: AURA_X,
      y: AURA_Y,
      alpha: spec.auraAlpha * alpha,
    });
  }
  layers.push(
    { ...SHADOW, alpha: 0.55 * alpha },
    { ...TORSO, y: TORSO.y + dy, alpha },
    {
      rows: REGALIA[personality.regalia],
      x: REGALIA_X,
      y: REGALIA_Y + dy,
      alpha,
    },
  );

  const headDy = dy + (spec.bow ? 1 : 0);
  layers.push({
    rows: HEADS[spec.head],
    x: HEAD_X,
    y: HEAD_Y + headDy,
    alpha,
  });
  layers.push({
    rows: CROWNS[personality.crown],
    x: CROWN_X,
    y: CROWN_Y + headDy,
    alpha,
  });

  if (spec.hands) {
    layers.push({ ...HAND_LEFT, y: HAND_LEFT.y + dy, alpha });
    layers.push({ ...HAND_RIGHT, y: HAND_RIGHT.y + dy, alpha });
  }
  if (spec.prop) {
    layers.push({
      rows: PROPS[personality.prop],
      x: PROP_X,
      y: PROP_Y + dy + spec.propDy,
      alpha,
    });
    if (spec.glintAlpha > 0) {
      layers.push({
        rows: RELIC_GLINT,
        x: RELIC_GLINT_X,
        y: RELIC_GLINT_Y + spec.propDy,
        alpha: spec.glintAlpha,
      });
    }
  }

  layers.push({
    rows: EMBLEMS[personality.emblem],
    x: EMBLEM_X,
    y: EMBLEM_Y,
    alpha: spec.emblemAlpha,
  });
  if (spec.cue) {
    layers.push({
      rows: CUES[spec.cue],
      x: CUE_X,
      y: CUE_Y,
      alpha: spec.cueAlpha,
    });
  }

  return layers;
}

export interface AgentAvatarSelection {
  deity: AgentAvatarDeity;
  state: AgentAvatarState;
  /** Absent sessions render an empty, dim tile rather than implying a quiet
   * live agent. */
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

/** Every authored sprite, for integrity tests and future tooling. */
export const AGENT_AVATAR_SPRITE_SETS = {
  heads: HEADS,
  crowns: CROWNS,
  emblems: EMBLEMS,
  props: PROPS,
  cues: CUES,
  auras: AURAS,
  regalia: REGALIA,
} as const;
