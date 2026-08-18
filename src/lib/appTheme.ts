/** The app uses one fixed surface palette. Project accent colors remain
 * independent and continue to tint the active workspace. */
export const APP_THEME = "granite" as const;

const RETIRED_STORAGE_KEY = "talos:theme";

/** Mark the root before React renders and retire any obsolete picker value. */
export function initAppTheme(): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = APP_THEME;
  }
  try {
    localStorage.removeItem(RETIRED_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted webviews.
  }
}
