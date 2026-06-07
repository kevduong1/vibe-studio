/**
 * IPC glue for one language-server process: subscribes the lsp-message /
 * lsp-exit events, starts the process, serializes outgoing messages. The
 * single JSON.parse of incoming frames happens here. No protocol knowledge —
 * that's client.ts.
 *
 * Outgoing FIFO guarantee: each lsp_send runs its write on an independent
 * spawn_blocking task in Rust, so two in-flight invokes could acquire the
 * stdin lock in either order — client.ts's correctness (didChange version
 * sequencing, flush-before-position-request, initialize-first) assumes wire
 * order matches call order. send() therefore chains every message behind the
 * previous one's settled invoke (lspSend resolving means write+flush
 * completed in Rust), with per-link catches so one failure never wedges the
 * chain.
 *
 * Lifecycle discipline mirrors lib/termSession.ts: listeners attach BEFORE
 * lsp_start so no early output is lost, every await is guarded against
 * dispose-before-resolve (listen() resolves late), and dispose sequences
 * lsp_stop behind BOTH the settled start promise (a StrictMode
 * dispose-before-start-resolves can't orphan a server) AND the settled send
 * chain (the graceful `exit` frame reaches the server's stdin before
 * lsp_stop's SIGTERM).
 */
import {
  lspSend,
  lspStart,
  lspStop,
  onLspExit,
  onLspMessage,
  type LspExit,
} from "../ipc";
import type { JsonRpcMessage } from "./types";

export type { LspExit };

export interface LspTransportHandlers {
  onMessage: (msg: JsonRpcMessage) => void;
  onExit: (exit: LspExit) => void;
  /** lsp_send failures (server gone mid-write, IPC error). */
  onTransportError: (err: unknown) => void;
}

export interface LspTransport {
  readonly id: string;
  /** Resolves once the server process is spawned. Idempotent. */
  start(cmd: string, args: string[], cwd: string): Promise<void>;
  /** Host app pid (from lsp_start) — initialize's processId parent-watch.
      Null until start resolves. */
  hostPid(): number | null;
  /** Queue one JSON-RPC message; Rust adds the framing. Sends are serialized
      (FIFO) — resolution means the frame was written+flushed. Failures also
      reach onTransportError, so callers may ignore the promise; awaiting it
      lets a caller correlate a write failure to its own message. */
  send(msg: object): Promise<void>;
  /** Detach listeners + stop the process (idempotent, swallows late stops). */
  dispose(): void;
}

export function createLspTransport(handlers: LspTransportHandlers): LspTransport {
  const id = crypto.randomUUID();
  let disposed = false;
  let startPromise: Promise<void> | null = null;
  let hostPid: number | null = null;
  /** Send chain tail — never rejects (each link's failure is caught). */
  let tail: Promise<void> = Promise.resolve();
  let unMessage: (() => void) | null = null;
  let unExit: (() => void) | null = null;

  return {
    id,

    start(cmd, args, cwd) {
      if (startPromise || disposed) return startPromise ?? Promise.resolve();
      startPromise = (async () => {
        const u1 = await onLspMessage(id, (raw) => {
          if (disposed) return;
          let msg: JsonRpcMessage;
          try {
            msg = JSON.parse(raw) as JsonRpcMessage;
          } catch {
            console.warn("lsp: dropping malformed message", raw.slice(0, 200));
            return;
          }
          handlers.onMessage(msg);
        });
        if (disposed) {
          u1();
          return;
        }
        unMessage = u1;

        const u2 = await onLspExit(id, (exit) => {
          if (!disposed) handlers.onExit(exit);
        });
        if (disposed) {
          u2();
          return;
        }
        unExit = u2;

        hostPid = await lspStart(id, cmd, args, cwd);
      })();
      return startPromise;
    },

    hostPid: () => hostPid,

    send(msg) {
      if (disposed) return Promise.resolve();
      const link = tail.then(() => lspSend(id, JSON.stringify(msg)));
      // Catching on `link` both keeps the chain alive past a failed write
      // AND marks the returned promise handled (callers may ignore it).
      tail = link.catch((e) => {
        if (!disposed) handlers.onTransportError(e);
      });
      return link;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unMessage?.();
      unExit?.();
      // Stop only once a dispatched start AND every queued send settle —
      // the `exit` frame must hit stdin before lsp_stop's SIGTERM. `tail`
      // is read after the start settles, by which point `disposed` has
      // frozen it (it never rejects). A null startPromise means the server
      // was never started ("unknown lsp" from a still-failed start is
      // swallowed below).
      const p = startPromise;
      if (p) {
        void p
          .catch(() => {})
          .then(() => tail)
          .then(() => lspStop(id))
          .catch(() => {});
      }
    },
  };
}
