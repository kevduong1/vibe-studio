import { describe, expect, it } from "vitest";
import { APP_THEME_GROUPS, APP_THEMES, normalizeAppTheme } from "./appTheme";

describe("app themes", () => {
  it("keeps every published theme id", () => {
    for (const theme of APP_THEMES) {
      expect(normalizeAppTheme(theme.id)).toBe(theme.id);
    }
  });

  it("falls back to Midnight for missing or stale persisted values", () => {
    expect(normalizeAppTheme(null)).toBe("midnight");
    expect(normalizeAppTheme("old-theme")).toBe("midnight");
  });

  it("publishes unique ids and at least four options in every group", () => {
    expect(new Set(APP_THEMES.map((theme) => theme.id)).size).toBe(
      APP_THEMES.length,
    );
    for (const group of APP_THEME_GROUPS) {
      expect(APP_THEMES.filter((theme) => theme.group === group.id).length)
        .toBeGreaterThanOrEqual(4);
    }
  });
});
