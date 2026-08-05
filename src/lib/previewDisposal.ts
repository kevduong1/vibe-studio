import { previewClose } from "./ipc";
import { disposePreviewSession } from "./previewSessions";

/**
 * Close through the session registry first so queued session work stays
 * ordered. A rejected registry close removes its session entry by design, so
 * retry once through the idempotent native close command.
 */
export async function disposePreviewWithFallback(id: string): Promise<void> {
  try {
    await disposePreviewSession(id);
  } catch (initialError) {
    try {
      await previewClose(id);
    } catch (retryError) {
      throw new Error(
        `Preview ${id} could not be closed (${String(initialError)}; retry: ${String(retryError)})`,
      );
    }
  }
}

/** Start every close immediately, then wait for all registry-close/fallback
    outcomes before the caller decides whether it can tear down its owner. */
export function disposePreviewsWithFallback(
  ids: string[],
): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(ids.map((id) => disposePreviewWithFallback(id)));
}
