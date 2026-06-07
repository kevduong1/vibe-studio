/**
 * One LSP connection: JSON-RPC correlation + protocol lifecycle + document
 * sync. Framework-free — the future IDE MCP server drives this same code.
 *
 * A client is EPHEMERAL wire state (request ids, document versions): it is
 * created per server process and thrown away on crash/stop. Durable state
 * (which docs are open, latest diagnostics) lives in the facade (servers.ts),
 * which re-creates clients and replays didOpens with fresh text.
 *
 * Two rules with silent-failure modes if broken:
 * - EVERY server→client request gets a response (even just null; unknown
 *   methods get -32601) — an unanswered request hangs the server with no
 *   error anywhere (pyright sends workspace/configuration, tls sends
 *   client/registerCapability).
 * - Position-based requests flush the doc's pending didChange batch first,
 *   or their positions reference a document the server hasn't seen.
 */
import { basename } from "../path";
import type { LspExit } from "../ipc";
import { createLspTransport } from "./transport";
import { fileUriToPath, pathToFileUri } from "./uri";
import {
  lspLanguageIdFor,
  type JsonRpcMessage,
  type LspCompletionContext,
  type LspCompletionItem,
  type LspCompletionList,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspMarkedString,
  type LspPosition,
  type LspRange,
  type LspTextChange,
  type ServerStatus,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;
const INITIALIZE_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
/** Position requests arriving while the server is still initializing are
    queued (and run on ready); past this they reject instead. */
const READY_QUEUE_CAP = 100;
/** didChange coalescing: flush after this much idle time... */
const CHANGE_FLUSH_MS = 150;
/** ...or immediately past these caps (a find-and-replace-all must not
    accumulate unboundedly). */
const CHANGE_FLUSH_COUNT = 400;
const CHANGE_FLUSH_BYTES = 128 * 1024;

export interface LspClientOptions {
  serverPath: string;
  args: string[];
  cwd: string;
  root: string;
  /** Server-specific initialize.initializationOptions (null/undefined = omit). */
  initializationOptions?: unknown;
  /** Post-staleness-filter diagnostics, keyed by plain absolute path. */
  onDiagnostics: (path: string, diags: LspDiagnostic[]) => void;
  /** "starting" → "running" transitions (the facade owns the rest). */
  onStatusChange: (status: ServerStatus) => void;
  /** Unexpected death (process exit or failed startup) — the client has
      already cleaned itself up; the facade decides restart policy. */
  onCrash: (exit: LspExit) => void;
}

export interface LspClient {
  status(): ServerStatus;
  /** Completion trigger characters declared by the server (post-init). */
  triggerCharacters(): string[];
  /** Idempotent; `getText` is pulled lazily (didOpen/full-sync/replay). */
  openDocument(path: string, getText: () => string): void;
  /** Incremental edits in pre-change coordinates; within one batch they must
      be ordered DESCENDING by position (LSP applies contentChanges
      sequentially, each against the doc the previous one produced — emitting
      a transaction's original-coordinate changes last-to-first keeps every
      range valid). Batches from consecutive transactions just concatenate. */
  changeDocument(path: string, changes: LspTextChange[]): void;
  closeDocument(path: string): void;
  /** Position requests take an optional AbortSignal: aborting while the
      request is in flight sends `$/cancelRequest` (the server stops working
      and its response never crosses the IPC channel) and rejects with
      Error("lsp request aborted") — an already-aborted signal rejects
      without sending. Settling normally detaches the listener, so
      long-lived signals don't accumulate them. */
  hover(
    path: string,
    pos: LspPosition,
    signal?: AbortSignal,
  ): Promise<{ markdown: string; range: LspRange | null } | null>;
  completions(
    path: string,
    pos: LspPosition,
    context?: LspCompletionContext,
    signal?: AbortSignal,
  ): Promise<{ isIncomplete: boolean; items: LspCompletionItem[] }>;
  definition(
    path: string,
    pos: LspPosition,
    signal?: AbortSignal,
  ): Promise<{ path: string; range: LspRange }[]>;
  /** Graceful teardown: shutdown → exit → transport stop. Fire-and-forget —
      never blocks the caller; the Rust SIGTERM→SIGKILL is the backstop. */
  dispose(): void;
}

/** Message carried by the cancellation rejection (position requests). */
const ABORT_MESSAGE = "lsp request aborted";

/** True for the rejection produced by a caller's AbortSignal cancelling a
    position request — every layer matches with this predicate, never the
    message literal (servers.ts re-exports it for the editor layer). */
export const isLspAbort = (e: unknown): boolean =>
  e instanceof Error && e.message === ABORT_MESSAGE;

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
  method: string;
  /** Detaches the caller's AbortSignal listener; EVERY settle path must
      call it or listeners pile up on long-lived signals. */
  unabort?: () => void;
}

interface DocRecord {
  getText: () => string;
  version: number;
  pending: LspTextChange[];
  pendingBytes: number;
  flushTimer: number | null;
}

const markedToMarkdown = (m: LspMarkedString): string =>
  typeof m === "string" ? m : "```" + m.language + "\n" + m.value + "\n```";

const hoverToMarkdown = (c: LspHover["contents"]): string => {
  if (Array.isArray(c)) return c.map(markedToMarkdown).filter(Boolean).join("\n\n");
  if (typeof c === "string") return c;
  if ("kind" in c) return c.value;
  return markedToMarkdown(c);
};

export function createLspClient(opts: LspClientOptions): LspClient {
  let status: ServerStatus = "starting";
  let disposed = false;
  let nextId = 1;
  let triggerChars: string[] = [];
  /** TextDocumentSyncKind: 0 none, 1 full, 2 incremental. */
  let syncKind = 2;
  const pending = new Map<number, PendingRequest>();
  const docs = new Map<string, DocRecord>();
  const readyQueue: { run: () => void; fail: (e: Error) => void }[] = [];

  const transport = createLspTransport({
    onMessage: (msg) => handleMessage(msg),
    onExit: (exit) => handleExit(exit),
    onTransportError: (err) => console.warn("lsp: send failed", err),
  });

  // --- JSON-RPC core ---------------------------------------------------------

  const notify = (method: string, params: unknown) =>
    transport.send({ jsonrpc: "2.0", method, params });

  const respond = (id: number | string, result: unknown) =>
    transport.send({ jsonrpc: "2.0", id, result });

  const respondError = (id: number | string, code: number, message: string) =>
    transport.send({ jsonrpc: "2.0", id, error: { code, message } });

  const request = (
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(ABORT_MESSAGE));
        return;
      }
      const id = nextId++;
      // Timeout and abort share one path: forget the request locally and
      // tell the server to stop working on it (a late response is then a
      // post-settle straggler, dropped by handleMessage).
      const cancel = (why: Error) => {
        const p = pending.get(id);
        if (!p) return; // already settled
        pending.delete(id);
        clearTimeout(p.timer);
        p.unabort?.();
        notify("$/cancelRequest", { id });
        p.reject(why);
      };
      const timer = window.setTimeout(
        () => cancel(new Error(`lsp request timed out: ${method}`)),
        timeoutMs,
      );
      const onAbort = () => cancel(new Error(ABORT_MESSAGE));
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        unabort: signal
          ? () => signal.removeEventListener("abort", onAbort)
          : undefined,
      });
      // A failed write means no response will ever arrive — reject THIS
      // request immediately instead of waiting out the timeout. (No
      // $/cancelRequest: the pipe that just failed won't carry it either.)
      transport.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        p.unabort?.();
        p.reject(new Error(`${method}: send failed: ${String(e)}`));
      });
    });

  const failAllPending = (e: Error) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.unabort?.();
      p.reject(e);
    }
    pending.clear();
    for (const q of readyQueue.splice(0)) q.fail(e);
  };

  const handleMessage = (msg: JsonRpcMessage) => {
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      handleServerRequest(msg as JsonRpcMessage & { id: number | string });
    } else if (msg.method !== undefined) {
      handleNotification(msg);
    } else if (msg.id !== undefined && msg.id !== null) {
      const p = pending.get(msg.id as number);
      if (!p) return; // post-timeout/abort straggler — drop silently
      pending.delete(msg.id as number);
      clearTimeout(p.timer);
      p.unabort?.();
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? null);
    }
  };

  const handleServerRequest = (msg: JsonRpcMessage & { id: number | string }) => {
    switch (msg.method) {
      case "workspace/configuration": {
        // null per item = "use your own defaults / config files" — pyright
        // then reads pyrightconfig.json itself.
        const items = (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        respond(msg.id, items.map(() => null));
        break;
      }
      case "workspace/workspaceFolders":
        // We declare workspace.workspaceFolders: true — answer with the
        // same (static, single-root) set sent in initializeParams.
        respond(msg.id, initializeParams.workspaceFolders);
        break;
      case "client/registerCapability":
      case "client/unregisterCapability": // we declare no dynamicRegistration
      case "window/workDoneProgress/create": // subsequent $/progress ignored
      case "window/showMessageRequest": // null = user dismissed
        respond(msg.id, null);
        break;
      case "workspace/applyEdit":
        respond(msg.id, { applied: false });
        break;
      default:
        // An error response still unblocks the server; silence does not.
        respondError(msg.id, -32601, `method not handled: ${msg.method}`);
    }
  };

  const handleNotification = (msg: JsonRpcMessage) => {
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as {
        uri: string;
        version?: number | null;
        diagnostics: LspDiagnostic[];
      };
      const path = fileUriToPath(params.uri);
      if (!path) return;
      // Staleness: a publish for version N arriving after we synced N+1
      // would paint ghost squiggles at pre-edit positions.
      const rec = docs.get(path);
      if (rec && params.version != null && params.version < rec.version) return;
      opts.onDiagnostics(path, params.diagnostics ?? []);
    }
    // window/logMessage, $/progress, telemetry/event, ... — ignored.
  };

  // --- Lifecycle ---------------------------------------------------------------

  const setStatus = (s: ServerStatus) => {
    status = s;
    opts.onStatusChange(s);
  };

  const handleExit = (exit: LspExit) => {
    if (disposed) return; // expected: we initiated shutdown
    cleanup(new Error("lsp server exited"));
    opts.onCrash(exit);
  };

  /** Internal teardown shared by crash and dispose. */
  const cleanup = (reason: Error) => {
    disposed = true;
    for (const [, rec] of docs) {
      if (rec.flushTimer !== null) clearTimeout(rec.flushTimer);
    }
    failAllPending(reason);
    transport.dispose();
  };

  const initializeParams = {
    // Filled with the host app's pid (transport.hostPid()) once the process
    // is spawned — the spec's parent watch: servers exit when this pid dies,
    // covering crash/SIGKILL paths where neither the shutdown dance nor
    // lsp_stop's SIGTERM ever runs. (tls/pyright also exit on stdin EOF;
    // the pid watch is the belt to that suspender.)
    processId: null as number | null,
    initializationOptions: opts.initializationOptions ?? undefined,
    rootUri: pathToFileUri(opts.root),
    workspaceFolders: [
      { uri: pathToFileUri(opts.root), name: basename(opts.root) },
    ],
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false },
        publishDiagnostics: { versionSupport: true, tagSupport: { valueSet: [1, 2] } },
        hover: { contentFormat: ["markdown", "plaintext"] },
        completion: {
          contextSupport: true,
          completionItem: {
            // CodeMirror has no snippet expansion wired; false makes tsserver
            // emit plain insertions instead of ${1:...} placeholders.
            snippetSupport: false,
            documentationFormat: ["markdown", "plaintext"],
          },
        },
        definition: { linkSupport: false }, // servers return Location[]
      },
      workspace: { workspaceFolders: true, configuration: true },
      window: { workDoneProgress: false },
    },
  };

  /** Run now if ready, queue if starting, reject otherwise. */
  const whenReady = <T,>(fn: () => Promise<T>): Promise<T> => {
    if (status === "running" && !disposed) return fn();
    if (status === "starting" && !disposed) {
      if (readyQueue.length >= READY_QUEUE_CAP) {
        return Promise.reject(new Error("lsp server starting (queue full)"));
      }
      return new Promise<T>((resolve, reject) => {
        readyQueue.push({ run: () => fn().then(resolve, reject), fail: reject });
      });
    }
    return Promise.reject(new Error(`lsp server ${status}`));
  };

  // --- Document sync -----------------------------------------------------------

  const sendDidOpen = (path: string, rec: DocRecord) => {
    rec.version = 1;
    rec.pending = [];
    rec.pendingBytes = 0;
    notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileUri(path),
        languageId: lspLanguageIdFor(path),
        version: rec.version,
        text: rec.getText(),
      },
    });
  };

  const flushDoc = (path: string, rec: DocRecord) => {
    if (rec.flushTimer !== null) {
      clearTimeout(rec.flushTimer);
      rec.flushTimer = null;
    }
    if (!rec.pending.length || syncKind === 0) return;
    const contentChanges =
      syncKind === 1 ? [{ text: rec.getText() }] : rec.pending;
    rec.pending = [];
    rec.pendingBytes = 0;
    notify("textDocument/didChange", {
      textDocument: { uri: pathToFileUri(path), version: ++rec.version },
      contentChanges,
    });
  };

  // --- Startup -------------------------------------------------------------------

  void (async () => {
    try {
      await transport.start(opts.serverPath, opts.args, opts.cwd);
      if (disposed) return;
      initializeParams.processId = transport.hostPid();
      const result = (await request("initialize", initializeParams, INITIALIZE_TIMEOUT_MS)) as {
        capabilities?: {
          textDocumentSync?: number | { change?: number };
          completionProvider?: { triggerCharacters?: string[] };
        };
      };
      if (disposed) return;
      const sync = result.capabilities?.textDocumentSync;
      // Spec default for an absent capability is 0 (none), but older servers
      // omit it while still expecting full sync — default to 1.
      syncKind = typeof sync === "number" ? sync : sync?.change ?? 1;
      triggerChars = result.capabilities?.completionProvider?.triggerCharacters ?? [];
      notify("initialized", {});
      setStatus("running");
      for (const [path, rec] of docs) sendDidOpen(path, rec);
      for (const q of readyQueue.splice(0)) q.run();
    } catch (e) {
      if (disposed) return;
      cleanup(new Error("lsp startup failed"));
      opts.onCrash({ code: null, stderrTail: String(e) });
    }
  })();

  return {
    status: () => status,
    triggerCharacters: () => triggerChars,

    openDocument(path, getText) {
      const existing = docs.get(path);
      if (existing) {
        // Idempotent re-open (StrictMode remount): refresh the text source,
        // no second didOpen.
        existing.getText = getText;
        return;
      }
      const rec: DocRecord = {
        getText,
        version: 1,
        pending: [],
        pendingBytes: 0,
        flushTimer: null,
      };
      docs.set(path, rec);
      if (status === "running" && !disposed) sendDidOpen(path, rec);
    },

    changeDocument(path, changes) {
      const rec = docs.get(path);
      // Before "running" the deltas are no-ops: didOpen pulls fresh full
      // text via getText when the server becomes ready.
      if (!rec || status !== "running" || disposed || syncKind === 0) return;
      rec.pending.push(...changes);
      for (const c of changes) rec.pendingBytes += c.text.length;
      if (
        rec.pending.length >= CHANGE_FLUSH_COUNT ||
        rec.pendingBytes >= CHANGE_FLUSH_BYTES
      ) {
        flushDoc(path, rec);
      } else if (rec.flushTimer === null) {
        rec.flushTimer = window.setTimeout(() => {
          rec.flushTimer = null;
          flushDoc(path, rec);
        }, CHANGE_FLUSH_MS);
      }
    },

    closeDocument(path) {
      const rec = docs.get(path);
      if (!rec) return;
      docs.delete(path);
      if (rec.flushTimer !== null) clearTimeout(rec.flushTimer);
      if (status === "running" && !disposed) {
        notify("textDocument/didClose", {
          textDocument: { uri: pathToFileUri(path) },
        });
      }
    },

    hover(path, pos, signal) {
      return whenReady(async () => {
        const rec = docs.get(path);
        if (rec) flushDoc(path, rec);
        const result = (await request(
          "textDocument/hover",
          {
            textDocument: { uri: pathToFileUri(path) },
            position: pos,
          },
          REQUEST_TIMEOUT_MS,
          signal,
        )) as LspHover | null;
        if (!result || result.contents == null) return null;
        const markdown = hoverToMarkdown(result.contents);
        if (!markdown.trim()) return null;
        return { markdown, range: result.range ?? null };
      });
    },

    completions(path, pos, context, signal) {
      return whenReady(async () => {
        const rec = docs.get(path);
        if (rec) flushDoc(path, rec);
        const result = (await request(
          "textDocument/completion",
          {
            textDocument: { uri: pathToFileUri(path) },
            position: pos,
            context: context ?? { triggerKind: 1 },
          },
          REQUEST_TIMEOUT_MS,
          signal,
        )) as LspCompletionItem[] | LspCompletionList | null;
        if (!result) return { isIncomplete: false, items: [] };
        return Array.isArray(result)
          ? { isIncomplete: false, items: result }
          : { isIncomplete: !!result.isIncomplete, items: result.items ?? [] };
      });
    },

    definition(path, pos, signal) {
      return whenReady(async () => {
        const rec = docs.get(path);
        if (rec) flushDoc(path, rec);
        const result = (await request(
          "textDocument/definition",
          {
            textDocument: { uri: pathToFileUri(path) },
            position: pos,
          },
          REQUEST_TIMEOUT_MS,
          signal,
        )) as LspLocation | (LspLocation | LspLocationLink)[] | null;
        const list = !result ? [] : Array.isArray(result) ? result : [result];
        const out: { path: string; range: LspRange }[] = [];
        for (const loc of list) {
          const uri = "uri" in loc ? loc.uri : loc.targetUri;
          const range =
            "uri" in loc ? loc.range : loc.targetSelectionRange ?? loc.targetRange;
          const p = fileUriToPath(uri);
          if (p) out.push({ path: p, range });
        }
        return out;
      });
    },

    dispose() {
      if (disposed) return;
      setStatus("stopping");
      // Register the polite shutdown BEFORE flipping `disposed` so its
      // response can still resolve; then cancel everything else. The exit
      // event this provokes is ignored by handleExit (disposed = expected).
      const shutdownReq = request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
      disposed = true;
      for (const [, rec] of docs) {
        if (rec.flushTimer !== null) clearTimeout(rec.flushTimer);
      }
      for (const [id, p] of [...pending]) {
        if (p.method === "shutdown") continue;
        pending.delete(id);
        clearTimeout(p.timer);
        p.unabort?.();
        p.reject(new Error("lsp client disposed"));
      }
      for (const q of readyQueue.splice(0)) {
        q.fail(new Error("lsp client disposed"));
      }
      // shutdown → exit → transport stop, for real: the exit notification
      // is queued on the transport's send chain before dispose(), and
      // transport.dispose() sequences lsp_stop's SIGTERM behind that chain.
      void shutdownReq
        .catch(() => {})
        .then(() => {
          notify("exit", undefined);
          transport.dispose();
        });
    },
  };
}
