import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_THEME, initAppTheme } from "./appTheme";

describe("app theme", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Granite as the fixed app palette", () => {
    expect(APP_THEME).toBe("granite");
  });

  it("applies Granite and retires a persisted picker value", () => {
    const dataset: Record<string, string> = {};
    const removeItem = vi.fn();
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", { removeItem });

    initAppTheme();

    expect(dataset.theme).toBe("granite");
    expect(removeItem).toHaveBeenCalledWith("talos:theme");
  });
});
