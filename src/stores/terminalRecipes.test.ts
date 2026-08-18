import { describe, expect, it } from "vitest";
import { validTerminalRecipe } from "./terminalRecipeModel";

describe("terminal recipes", () => {
  it("accepts manual recipes and ignores legacy restore metadata", () => {
    expect(validTerminalRecipe({ id: "a", name: "Dev", command: "pnpm dev" })).toBe(true);
    expect(validTerminalRecipe({ id: "a", name: "Dev", command: "pnpm dev", runOnRestore: true })).toBe(true);
  });

  it("rejects empty commands", () => {
    expect(validTerminalRecipe({ id: "a", name: "Dev", command: " " })).toBe(false);
  });
});
