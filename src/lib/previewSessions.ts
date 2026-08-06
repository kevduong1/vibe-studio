import {
  previewBack,
  previewClose,
  previewCreate,
  previewFocus,
  previewForward,
  previewNavigate,
  previewReload,
  previewSetBounds,
  previewSetVisible,
  type PreviewBounds,
} from "./ipc";

export interface PreviewSession {
  readonly id: string;
  ensure(url: string, bounds: PreviewBounds): Promise<void>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  setBounds(bounds: PreviewBounds): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  focus(): Promise<void>;
  /** Forget a disappeared native child view without changing tab ownership. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const sessions = new Map<string, PreviewSessionImpl>();

let visibilityQueue: Promise<void> = Promise.resolve();

const enqueueVisibility = (operation: () => Promise<void>): Promise<void> => {
  const result = visibilityQueue.then(operation, operation);
  visibilityQueue = result.catch(() => undefined);
  return result;
};

class PreviewSessionImpl implements PreviewSession {
  readonly id: string;

  private created = false;
  private visible = false;
  /**
   * Conservative native-state bit. Set before a show IPC starts because the
   * command may reach native even when its completion becomes stale (or its
   * promise rejects). Only a successful queued hide can prove it false.
   */
  private nativeMayBeVisible = false;
  private closed = false;
  private generation = 0;
  private visibilityGeneration = 0;
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  constructor(id: string) {
    this.id = id;
  }

  ensure(url: string, bounds: PreviewBounds): Promise<void> {
    return this.enqueue(async (isCurrent) => {
      if (this.created) return;
      try {
        await previewCreate(this.id, url, bounds);
        if (isCurrent()) this.created = true;
      } catch (error) {
        // A failed create is the only case in which a later ensure retries.
        this.created = false;
        throw error;
      }
    });
  }

  navigate(url: string): Promise<void> {
    return this.enqueue(() => previewNavigate(this.id, url));
  }

  back(): Promise<void> {
    return this.enqueue(() => previewBack(this.id));
  }

  forward(): Promise<void> {
    return this.enqueue(() => previewForward(this.id));
  }

  reload(): Promise<void> {
    return this.enqueue(() => previewReload(this.id));
  }

  setBounds(bounds: PreviewBounds): Promise<void> {
    return this.enqueue(() => previewSetBounds(this.id, bounds));
  }

  setVisible(visible: boolean): Promise<void> {
    this.visibilityGeneration += 1;
    const generation = this.generation;
    const visibilityGeneration = this.visibilityGeneration;

    if (!visible) return this.hide();

    // Keep this out of the per-session queue: the coordinator enqueues peer
    // hides on their own queues, then enqueues this target's show. Putting
    // the coordinator inside this queue would recreate the A↔B wait cycle.
    return enqueueVisibility(async () => {
      if (!this.isVisibilityRequestCurrent(generation, visibilityGeneration)) {
        return;
      }
      await Promise.all(
        [...sessions.entries()]
          .filter(([id]) => id !== this.id)
          .map(([, session]) => session.hideForVisibilityCoordinator()),
      );
      if (!this.isVisibilityRequestCurrent(generation, visibilityGeneration)) {
        return;
      }
      await this.showForVisibilityCoordinator(generation, visibilityGeneration);
    });
  }

  focus(): Promise<void> {
    return this.enqueue(() => previewFocus(this.id));
  }

  reset(): Promise<void> {
    if (this.closed) return Promise.resolve();

    // Invalidate queued controls and visibility-coordinator work first. The
    // close itself remains ordered after any native operation already in
    // flight, and ensure() calls made after this reset queue behind it.
    this.generation += 1;
    this.visibilityGeneration += 1;
    const generation = this.generation;
    this.created = false;

    const reset = this.queue.then(async () => {
      if (this.closed || this.generation !== generation) return;
      // Native close is idempotent. Keeping this same registry object avoids
      // an old asynchronous close ever targeting a replacement with this id.
      await previewClose(this.id);
      if (!this.closed && this.generation === generation) {
        // Like hide(), only a successful native operation proves the old
        // child cannot still cover the error card or another native overlay.
        this.visible = false;
        this.nativeMayBeVisible = false;
      }
    });
    this.queue = reset.catch(() => undefined);
    return reset;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    this.visible = false;
    this.generation += 1;
    const close = this.queue.then(() => previewClose(this.id));
    this.queue = close.catch(() => undefined);
    this.closePromise = close.finally(() => {
      if (sessions.get(this.id) === this) sessions.delete(this.id);
    });
    return this.closePromise;
  }

  private enqueue(
    operation: (isCurrent: () => boolean) => Promise<void> | void,
  ): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => !this.closed && this.generation === generation;
    const run = async (): Promise<void> => {
      if (!isCurrent()) return;
      await operation(isCurrent);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private hide(): Promise<void> {
    return this.enqueue(async (isCurrent) => {
      if (!this.visible && !this.nativeMayBeVisible) return;
      await previewSetVisible(this.id, false);
      if (isCurrent()) {
        this.visible = false;
        this.nativeMayBeVisible = false;
      }
    });
  }

  /** The registry coordinator waits for this ordinary queued hide. */
  private hideForVisibilityCoordinator(): Promise<void> {
    return this.hide();
  }

  /** The registry coordinator queues the target show only after peer hides. */
  private showForVisibilityCoordinator(
    generation: number,
    visibilityGeneration: number,
  ): Promise<void> {
    return this.enqueue(async (isCurrent) => {
      const requestCurrent = this.isVisibilityRequestCurrent(
        generation,
        visibilityGeneration,
      );
      if (!isCurrent() || !requestCurrent) return;
      // Mark this before invoking native. A hide can be requested while the
      // promise is pending; if the show then reaches native, that queued hide
      // must not trust the still-false `visible` cache and short-circuit.
      this.nativeMayBeVisible = true;
      await previewSetVisible(this.id, true);
      if (isCurrent() && this.isVisibilityRequestCurrent(
        generation,
        visibilityGeneration,
      )) {
        this.visible = true;
      }
    });
  }

  private isVisibilityRequestCurrent(
    generation: number,
    visibilityGeneration: number,
  ): boolean {
    return !this.closed
      && this.generation === generation
      && this.visibilityGeneration === visibilityGeneration;
  }
}

export function getOrCreatePreviewSession(id: string): PreviewSession {
  const existing = sessions.get(id);
  if (existing) return existing;

  const session = new PreviewSessionImpl(id);
  sessions.set(id, session);
  return session;
}

/** Returns whether this call awaited a tracked registry session's close. */
export async function disposePreviewSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  await session.close();
  return true;
}

export async function disposePreviewSessions(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => disposePreviewSession(id)));
}

export async function hideAllPreviewSessions(exceptId?: string): Promise<void> {
  await Promise.all(
    [...sessions.entries()]
      .filter(([id]) => id !== exceptId)
      .map(([, session]) => session.setVisible(false)),
  );
}
