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
  private closed = false;
  private generation = 0;
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
    return this.enqueue(async (isCurrent) => {
      if (!visible) {
        if (!this.visible) return;
        await previewSetVisible(this.id, false);
        if (isCurrent()) this.visible = false;
        return;
      }

      await enqueueVisibility(async () => {
        if (!isCurrent()) return;
        await Promise.all(
          [...sessions.entries()]
            .filter(([id]) => id !== this.id)
            .map(([, session]) => session.hideForVisibilityCoordinator()),
        );
        if (!isCurrent()) return;
        await previewSetVisible(this.id, true);
        if (isCurrent()) this.visible = true;
      });
    });
  }

  focus(): Promise<void> {
    return this.enqueue(() => previewFocus(this.id));
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

  /**
   * The registry visibility coordinator calls this directly rather than
   * enqueueing behind a peer's active show. That avoids a cycle where A's
   * show waits for B to hide while B's show waits for A to hide.
   */
  private async hideForVisibilityCoordinator(): Promise<void> {
    const generation = this.generation;
    if (this.closed || !this.visible) return;

    await previewSetVisible(this.id, false);
    if (!this.closed && this.generation === generation) this.visible = false;
  }
}

export function getOrCreatePreviewSession(id: string): PreviewSession {
  const existing = sessions.get(id);
  if (existing) return existing;

  const session = new PreviewSessionImpl(id);
  sessions.set(id, session);
  return session;
}

export async function disposePreviewSession(id: string): Promise<void> {
  await sessions.get(id)?.close();
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
