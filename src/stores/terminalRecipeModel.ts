export interface TerminalRecipe {
  id: string;
  name: string;
  command: string;
  /** Explicit user opt-in; false recipes never execute during app restore. */
  runOnRestore: boolean;
}

export const validTerminalRecipe = (value: unknown): value is TerminalRecipe => {
  const recipe = value as Partial<TerminalRecipe> | null;
  return Boolean(
    recipe &&
    typeof recipe.id === "string" && recipe.id &&
    typeof recipe.name === "string" && recipe.name.trim() &&
    typeof recipe.command === "string" && recipe.command.trim() &&
    typeof recipe.runOnRestore === "boolean",
  );
};
