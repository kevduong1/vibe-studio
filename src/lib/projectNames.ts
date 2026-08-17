/**
 * Cosmetic per-project display names. A project (workspace path) is shown as
 * its folder basename until the user renames it (titlebar tab double-click or
 * context menu); custom names persist across restarts (localStorage) and are
 * purely visual — nothing path-based (git, PTY cwd, tasks) ever sees them.
 *
 * Reactivity: names only change via explicit renames, so components render
 * them through the useProjectDisplayName* hooks, which subscribe to those
 * changes; non-React code (store actions, dialogs) reads projectDisplayName
 * directly.
 */
import { create } from "zustand";
import { basename } from "./path";

const STORAGE_KEY = "talos:project-names";
/** Growth bound: oldest renames are dropped past this (names for repos not
    touched in ages revert to their basename — acceptable). */
const MAX_NAMES = 64;

interface PersistedNames {
  version: 1;
  /** Insertion-ordered path → custom display name. */
  names: Record<string, string>;
}

const loadNames = (): Map<string, string> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as PersistedNames;
    if (parsed.version !== 1) return new Map();
    return new Map(
      Object.entries(parsed.names).filter(
        ([, n]) => typeof n === "string" && n.trim() !== "",
      ),
    );
  } catch {
    return new Map();
  }
};

const names = loadNames();

const save = () => {
  const data: PersistedNames = {
    version: 1,
    names: Object.fromEntries(names),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
};

/** Bumped on every rename so the hooks below re-render their subscribers. */
const useNamesVersion = create<{ version: number }>(() => ({ version: 0 }));

/** The project's display name: the custom name, else the folder basename. */
export function projectDisplayName(path: string): string {
  return names.get(path) ?? basename(path);
}

/**
 * Rename a project (titlebar tab). An empty or basename-equal name reverts
 * to the default (the folder basename).
 */
export function setProjectDisplayName(path: string, name: string): void {
  const next = name.trim();
  const reverting = next === "" || next === basename(path);
  if (reverting ? !names.has(path) : names.get(path) === next) return;
  if (reverting) {
    names.delete(path);
  } else {
    names.set(path, next);
    while (names.size > MAX_NAMES) {
      // Map iteration is insertion-ordered — first key = oldest rename.
      names.delete(names.keys().next().value!);
    }
  }
  save();
  useNamesVersion.setState((s) => ({ version: s.version + 1 }));
}

/** Reactive projectDisplayName: re-renders the caller on renames. */
export function useProjectDisplayName(path: string): string {
  useNamesVersion();
  return projectDisplayName(path);
}

/** Reactive lookup for callers mapping over many paths (the tab strip). */
export function useProjectDisplayNames(): (path: string) => string {
  useNamesVersion();
  return projectDisplayName;
}
