import { describe, expect, it } from "vitest";
import { validTerminalRecipe } from "./terminalRecipeModel";

describe("terminal recipes", () => {
  it("requires an explicit boolean restore policy", () => {
    expect(validTerminalRecipe({ id: "a", name: "Dev", command: "pnpm dev", runOnRestore: false })).toBe(true);
    expect(validTerminalRecipe({ id: "a", name: "Dev", command: "pnpm dev" })).toBe(false);
  });

  it("rejects empty commands", () => {
    expect(validTerminalRecipe({ id: "a", name: "Dev", command: " ", runOnRestore: true })).toBe(false);
  });
});
