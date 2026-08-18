export interface TerminalRecipe {
  id: string;
  name: string;
  command: string;
}

export const validTerminalRecipe = (value: unknown): value is TerminalRecipe => {
  const recipe = value as Partial<TerminalRecipe> | null;
  return Boolean(
    recipe &&
    typeof recipe.id === "string" && recipe.id &&
    typeof recipe.name === "string" && recipe.name.trim() &&
    typeof recipe.command === "string" && recipe.command.trim(),
  );
};
