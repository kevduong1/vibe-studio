/**
 * Stable per-project accent colors. Each project (workspace path) is assigned
 * an index into the `--project-N` palette (styles/theme.css) on first ask and
 * keeps it — across restarts (localStorage) and for agent terminals whose
 * project isn't currently open — until the user explicitly recolors it via
 * `setProjectColorIndex` (titlebar tab right-click). The active project's
 * color is applied app-wide by overriding `--accent` on the .app root
 * (App.tsx); the rest of the accent family derives from it via color-mix in
 * theme.css.
 *
 * Reactivity: lazy first assignment is synchronous and idempotent (it happens
 * during the very render that reads it), so plain reads need no store. Only
 * explicit recolors change an existing assignment — components that render a
 * project color must read it through the useProjectColor* hooks, which
 * subscribe to those changes.
 */
import { create } from "zustand";

/** Picker tooltips, index-matched to (and the size source of truth for) the
    `--project-N` variables in theme.css. */
export const PROJECT_COLOR_NAMES = [
  "Blue",
  "Purple",
  "Green",
  "Orange",
  "Pink",
  "Cyan",
  "Yellow",
  "Red",
] as const;

const PALETTE_SIZE = PROJECT_COLOR_NAMES.length;

const STORAGE_KEY = "vibe-studio:project-colors";
/** Growth bound: oldest assignments are dropped past this (colors for repos
    not touched in ages may eventually rotate — acceptable). */
const MAX_ASSIGNMENTS = 64;

interface PersistedColors {
  version: 1;
  /** Insertion-ordered path → palette index. */
  assignments: Record<string, number>;
}

const loadAssignments = (): Map<string, number> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as PersistedColors;
    if (parsed.version !== 1) return new Map();
    return new Map(
      Object.entries(parsed.assignments).filter(
        ([, i]) => Number.isInteger(i) && i >= 0 && i < PALETTE_SIZE,
      ),
    );
  } catch {
    return new Map();
  }
};

const assignments = loadAssignments();

const save = () => {
  const data: PersistedColors = {
    version: 1,
    assignments: Object.fromEntries(assignments),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
};

/** Bumped on every explicit recolor so the hooks below re-render their
    subscribers; lazy first assignments never notify (nothing rendered the
    path's color before the read that assigns it). */
const useColorsVersion = create<{ version: number }>(() => ({ version: 0 }));

/**
 * The project's palette index, assigned on first ask: the least-used index
 * among existing assignments (ties → lowest), so open projects stay visually
 * distinct until the palette is exhausted.
 */
export function projectColorIndex(path: string): number {
  const existing = assignments.get(path);
  if (existing !== undefined) return existing;

  const counts = new Array<number>(PALETTE_SIZE).fill(0);
  for (const i of assignments.values()) counts[i]++;
  const index = counts.indexOf(Math.min(...counts));

  assignments.set(path, index);
  while (assignments.size > MAX_ASSIGNMENTS) {
    // Map iteration is insertion-ordered — first key = oldest assignment.
    assignments.delete(assignments.keys().next().value!);
  }
  save();
  return index;
}

/**
 * The project's palette index ONLY when one already exists — never assigns.
 * For callers that probe many candidate paths at once (the commit graph asks
 * about every linked worktree); a lazy assignment there would burn palette
 * entries on projects the user has never opened.
 */
export function assignedProjectColorIndex(path: string): number | undefined {
  return assignments.get(path);
}

/** Explicitly recolor a project (titlebar tab context menu). */
export function setProjectColorIndex(path: string, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE) return;
  // projectColorIndex (not the raw map) so a missing entry is assigned first —
  // the set below then never grows the map past MAX_ASSIGNMENTS.
  if (projectColorIndex(path) === index) return;
  assignments.set(path, index);
  save();
  useColorsVersion.setState((s) => ({ version: s.version + 1 }));
}

/** CSS color for a palette index, as a theme var() reference. */
export const paletteColor = (index: number): string =>
  `var(--project-${index})`;

/** CSS color for the project, as a theme-palette var() reference. */
export const projectColorVar = (path: string): string =>
  paletteColor(projectColorIndex(path));

/**
 * Recolor subscription for components that resolve colors for a whole SET of
 * paths inside a memo (the commit graph) rather than one path per hook.
 */
export function useProjectColorsVersion(): number {
  return useColorsVersion((s) => s.version);
}

/** Reactive projectColorIndex: re-renders the caller on explicit recolors. */
export function useProjectColorIndex(path: string): number {
  useColorsVersion();
  return projectColorIndex(path);
}

/** Reactive projectColorVar; null path (no active project) → undefined. */
export function useProjectColorVar(path: string): string;
export function useProjectColorVar(path: string | null): string | undefined;
export function useProjectColorVar(path: string | null): string | undefined {
  useColorsVersion();
  return path === null ? undefined : projectColorVar(path);
}
