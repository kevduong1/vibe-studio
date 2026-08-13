/**
 * Persisted, app-wide surface palette. CSS owns the actual colors in
 * styles/theme.css; this module only owns the stable theme IDs, selection,
 * persistence, and change notification needed by non-CSS renderers (xterm).
 */
import { create } from "zustand";

export const APP_THEMES = [
  {
    id: "midnight",
    label: "Midnight",
    description: "Deep blue-black",
    group: "neutral",
  },
  {
    id: "obsidian",
    label: "Obsidian",
    description: "Near pure black",
    group: "neutral",
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Dense pencil gray",
    group: "neutral",
  },
  {
    id: "charcoal",
    label: "Charcoal",
    description: "Neutral dark gray",
    group: "neutral",
  },
  {
    id: "soft-gray",
    label: "Soft Gray",
    description: "Gentler, brighter gray",
    group: "neutral",
  },
  {
    id: "slate",
    label: "Slate",
    description: "Cool blue-gray",
    group: "cool",
  },
  {
    id: "steel",
    label: "Steel",
    description: "Crisp industrial gray",
    group: "cool",
  },
  {
    id: "arctic",
    label: "Arctic",
    description: "Frosted blue-gray",
    group: "cool",
  },
  {
    id: "deep-ocean",
    label: "Deep Ocean",
    description: "Submerged teal-blue",
    group: "cool",
  },
  {
    id: "navy",
    label: "Navy",
    description: "Inky midnight blue",
    group: "cool",
  },
  {
    id: "espresso",
    label: "Espresso",
    description: "Roasted near-black",
    group: "warm",
  },
  {
    id: "mocha",
    label: "Mocha",
    description: "Soft coffee brown",
    group: "warm",
  },
  {
    id: "taupe",
    label: "Taupe",
    description: "Muted warm gray",
    group: "warm",
  },
  {
    id: "ember",
    label: "Ember",
    description: "Smoldering red-brown",
    group: "warm",
  },
  {
    id: "forest",
    label: "Forest",
    description: "Deep evergreen",
    group: "earth",
  },
  {
    id: "moss",
    label: "Moss",
    description: "Soft woodland green",
    group: "earth",
  },
  {
    id: "olive",
    label: "Olive",
    description: "Earthy yellow-green",
    group: "earth",
  },
  {
    id: "eucalyptus",
    label: "Eucalyptus",
    description: "Muted green-teal",
    group: "earth",
  },
  {
    id: "aubergine",
    label: "Aubergine",
    description: "Deep purple-black",
    group: "jewel",
  },
  {
    id: "plum",
    label: "Plum",
    description: "Soft smoky purple",
    group: "jewel",
  },
  {
    id: "burgundy",
    label: "Burgundy",
    description: "Dark wine red",
    group: "jewel",
  },
  {
    id: "indigo",
    label: "Indigo",
    description: "Velvety blue-violet",
    group: "jewel",
  },
] as const;

export type AppThemeId = (typeof APP_THEMES)[number]["id"];
export type AppThemeGroupId = (typeof APP_THEMES)[number]["group"];

export const APP_THEME_GROUPS: ReadonlyArray<{
  id: AppThemeGroupId;
  label: string;
}> = [
  { id: "neutral", label: "Neutral" },
  { id: "cool", label: "Cool" },
  { id: "warm", label: "Warm" },
  { id: "earth", label: "Earth" },
  { id: "jewel", label: "Jewel" },
];

const DEFAULT_THEME: AppThemeId = "midnight";
const STORAGE_KEY = "vibe-studio:theme";

export function normalizeAppTheme(value: unknown): AppThemeId {
  return APP_THEMES.some((theme) => theme.id === value)
    ? (value as AppThemeId)
    : DEFAULT_THEME;
}

const loadTheme = (): AppThemeId => {
  try {
    return normalizeAppTheme(
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(STORAGE_KEY),
    );
  } catch {
    return DEFAULT_THEME;
  }
};

const applyTheme = (theme: AppThemeId): void => {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
};

const persistTheme = (theme: AppThemeId): void => {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A blocked storage backend should not prevent the live theme change.
  }
};

interface AppThemeState {
  theme: AppThemeId;
  setTheme: (theme: AppThemeId) => void;
}

export const useAppTheme = create<AppThemeState>((set, get) => ({
  theme: loadTheme(),
  setTheme: (theme) => {
    if (get().theme === theme) return;
    applyTheme(theme);
    persistTheme(theme);
    set({ theme });
  },
}));

/** Apply the persisted palette before React renders the app shell. */
export const initAppTheme = (): void => applyTheme(useAppTheme.getState().theme);

export const setAppTheme = (theme: AppThemeId): void =>
  useAppTheme.getState().setTheme(theme);

/** Subscribe without making framework-free terminal sessions React-aware. */
export const onAppThemeChange = (
  listener: (theme: AppThemeId) => void,
): (() => void) =>
  useAppTheme.subscribe((state, previous) => {
    if (state.theme !== previous.theme) listener(state.theme);
  });
