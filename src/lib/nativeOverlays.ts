import { useEffect } from "react";
import { useUiStore } from "../stores/ui";

/** Register a React overlay that must keep native preview webviews hidden. */
export function useNativeOverlay(): void {
  useEffect(() => {
    useUiStore.getState().pushNativeOverlay();
    return () => useUiStore.getState().popNativeOverlay();
  }, []);
}
