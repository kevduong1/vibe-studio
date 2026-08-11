import { create } from "zustand";
import { getOrCreateWorkspaceSession } from "../lib/workspaceSessions";
import type { Workspace } from "./workspaces";
import { validTerminalRecipe, type TerminalRecipe } from "./terminalRecipeModel";

export type { TerminalRecipe } from "./terminalRecipeModel";

const STORAGE_KEY = "vibe-studio:terminal-recipes";

type RecipeMap = Record<string, TerminalRecipe[]>;

const load = (): RecipeMap => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
      version?: number;
      projects?: Record<string, unknown>;
    } | null;
    if (parsed?.version !== 1 || !parsed.projects) return {};
    return Object.fromEntries(
      Object.entries(parsed.projects).map(([path, values]) => [
        path,
        Array.isArray(values) ? values.filter(validTerminalRecipe) : [],
      ]),
    );
  } catch {
    return {};
  }
};

interface TerminalRecipesState {
  projects: RecipeMap;
  add: (workspacePath: string, name: string, command: string) => void;
  update: (workspacePath: string, recipe: TerminalRecipe) => void;
  remove: (workspacePath: string, recipeId: string) => void;
}

export const useTerminalRecipesStore = create<TerminalRecipesState>((set) => ({
  projects: load(),
  add: (workspacePath, name, command) => set((state) => ({
    projects: {
      ...state.projects,
      [workspacePath]: [
        ...(state.projects[workspacePath] ?? []),
        {
          id: crypto.randomUUID(),
          name: name.trim(),
          command: command.trim(),
          runOnRestore: false,
        },
      ],
    },
  })),
  update: (workspacePath, recipe) => set((state) => ({
    projects: {
      ...state.projects,
      [workspacePath]: (state.projects[workspacePath] ?? []).map((item) =>
        item.id === recipe.id ? recipe : item,
      ),
    },
  })),
  remove: (workspacePath, recipeId) => set((state) => ({
    projects: {
      ...state.projects,
      [workspacePath]: (state.projects[workspacePath] ?? []).filter(
        (item) => item.id !== recipeId,
      ),
    },
  })),
}));

useTerminalRecipesStore.subscribe((state, previous) => {
  if (state.projects === previous.projects) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    projects: state.projects,
  }));
});

export function runTerminalRecipe(workspace: Workspace, recipe: TerminalRecipe): string {
  const id = workspace.terminal.getState().newTerminal(recipe.name, "shell");
  const session = getOrCreateWorkspaceSession(workspace, id);
  session.sendText(`${recipe.command}\r`);
  return id;
}

export function runRestoreTerminalRecipes(workspace: Workspace): void {
  const recipes = useTerminalRecipesStore.getState().projects[workspace.path] ?? [];
  for (const recipe of recipes) {
    if (recipe.runOnRestore) runTerminalRecipe(workspace, recipe);
  }
}
