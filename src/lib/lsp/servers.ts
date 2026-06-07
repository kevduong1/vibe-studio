/**
 * Workspace-scoped LSP facade + registry — the service's public API. The
 * editor extension (cmLsp.ts), settings UI, workspaces store, and the future
 * IDE MCP server import THIS module and nothing deeper.
 *
 * Registry keyed by workspace root (termSessions.ts pattern: synchronous
 * check-then-set, StrictMode-safe). Each facade owns the DURABLE state —
 * which docs are open (as getText closures, so no text is ever copied into
 * the service), the latest published diagnostics, and subscriber sets —
 * while LspClient instances (one per language) are ephemeral wire state,
 * re-created on crash/restart with every matching doc's didOpen replayed
 * from fresh text. Servers start lazily on the first opened doc of an
 * enabled language and die only via disposeWorkspaceLsp (closeWorkspace),
 * settings disable, or the backend page-reload kill_all.
 */
import { create } from "zustand";

import { lspResolve, type LspExit, type LspResolveResult } from "../ipc";
import { createLspClient, isLspAbort, type LspClient } from "./client";
import { isLanguageEnabled, subscribeLspSettings } from "./settings";
import {
  serverLangForPath,
  type LspCompletionContext,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspPosition,
  type LspRange,
  type ServerLang,
  type ServerStatus,
} from "./types";

/** Re-exported for the editor layer (cmLsp matches abort rejections). */
export { isLspAbort } from "./client";

/** Spawn config per language. Local candidates (relative to the workspace
    root) are preferred over the login-shell PATH so a repo's pinned
    typescript/pyright wins. `init` rides initialize's initializationOptions. */
const SERVER_SPEC: Record<
  ServerLang,
  { bin: string; args: string[]; localBins: string[]; init: unknown }
> = {
  typescript: {
    bin: "typescript-language-server",
    args: ["--stdio"],
    localBins: ["node_modules/.bin/typescript-language-server"],
    // No syntax server: it's a SECOND tsserver process (~150 MB per
    // workspace) that only accelerates syntax-only requests while large
    // projects load — every feature we wire (hover, completion, definition,
    // diagnostics) is semantic, so it would be pure memory overhead.
    init: { tsserver: { useSyntaxServer: "never" } },
  },
  python: {
    bin: "pyright-langserver",
    args: ["--stdio"],
    localBins: ["node_modules/.bin/pyright-langserver"],
    init: null,
  },
};

/** Crash policy: auto-restart once iff the server had proven itself... */
const CRASH_MIN_UPTIME_MS = 30_000;
/** ...and not more often than this (never loop on a broken setup). */
const CRASH_RESTART_COOLDOWN_MS = 5 * 60_000;

/** Retention cap on stored diagnostics per file: cmLsp renders at most 200,
    but a pathological file can publish thousands — uncapped, the facade
    retains a multi-MB array re-allocated on every publish. */
const STORE_DIAG_CAP = 1000;

/** Idle policy: servers follow the ACTIVE workspace. A server stack is
    hundreds of MB (and background tsservers re-typecheck on every
    agent-driven file change a hidden editor reloads), so a deactivated
    workspace's servers stop after this grace — docs stay tracked and replay
    into a fresh server when the workspace is activated again. */
const BACKGROUND_STOP_MS = 15 * 60_000;
/** ...and a language with no open docs at all stops sooner (the last code
    tab closed; nothing left to diagnose). */
const IDLE_STOP_MS = 5 * 60_000;
/** Re-check cadence when a stop fires while a start is still in flight
    (disposing mid-start would let the start mint an untracked client). */
const STOP_RETRY_MS = 60_000;

export interface LspServerInfo {
  status: ServerStatus;
  /** Failure detail (stderr tail / startup error) when crashed or missing. */
  error: string | null;
  /** Last binary resolution, for the settings UI. */
  resolved: LspResolveResult | null;
}

export interface WorkspaceLsp {
  readonly root: string;
  /** didOpen (lazy server start on first matching file). Idempotent;
      `getText` must return the LIVE buffer text (unsaved edits included). */
  openDocument(path: string, getText: () => string): void;
  /** See LspClient.changeDocument for the descending-order contract. */
  changeDocument(path: string, changes: { range: LspRange; text: string }[]): void;
  closeDocument(path: string): void;
  /** Position requests forward an optional AbortSignal to the client (see
      LspClient: abort sends $/cancelRequest and rejects with the abort
      error — match it with the re-exported isLspAbort). That abort rejection
      is the ONE error these methods rethrow — it's the caller's own
      cancellation, not a degradation to mask as "no result". */
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
  /** Latest published diagnostics (the editor subscribes; an MCP queries). */
  diagnostics(path: string): LspDiagnostic[];
  allDiagnostics(): ReadonlyMap<string, LspDiagnostic[]>;
  /** path = null → every file in this workspace. Returns unsubscribe. */
  onDiagnostics(
    path: string | null,
    cb: (path: string, diags: LspDiagnostic[]) => void,
  ): () => void;
  serverStatus(lang: ServerLang): ServerStatus;
  serverInfo(lang: ServerLang): LspServerInfo;
  completionTriggers(lang: ServerLang): string[];
  /** Manual restart (settings UI): re-resolves the binary (cache-busting,
      so "install then restart" works) and replays open docs. */
  restartServer(lang: ServerLang): void;
}

interface DocEntry {
  getText: () => string;
  lang: ServerLang;
}

interface LangState {
  client: LspClient | null;
  status: ServerStatus;
  error: string | null;
  resolved: LspResolveResult | null;
  /** Single-flights concurrent start attempts. */
  starting: Promise<void> | null;
  runningSince: number;
  lastAutoRestart: number;
  /** Pending zero-docs stop (IDLE_STOP_MS), cancelled by openDocument. */
  idleTimer: number | null;
}

/** Bumped on every server status transition, anywhere — drives the editor's
    LSP re-attach and the settings/status-bar UI. */
const useLspStatusVersion = create<{ version: number }>(() => ({ version: 0 }));
const bumpStatusVersion = () =>
  useLspStatusVersion.setState((s) => ({ version: s.version + 1 }));

/** Vanilla status-change subscription (Editor.tsx recheck). */
export function subscribeLspStatus(cb: () => void): () => void {
  return useLspStatusVersion.subscribe(cb);
}

/** Reactive hook for components (settings modal, status bar). */
export function useLspStatusVersionValue(): number {
  return useLspStatusVersion((s) => s.version);
}

/** Binary detection for the settings UI; refresh re-runs the login shell. */
export function resolveServerBinary(
  root: string,
  lang: ServerLang,
  refresh = false,
): Promise<LspResolveResult> {
  const spec = SERVER_SPEC[lang];
  return lspResolve(
    spec.bin,
    spec.localBins.map((b) => `${root}/${b}`),
    refresh,
  );
}

class WorkspaceLspImpl implements WorkspaceLsp {
  readonly root: string;
  private docs = new Map<string, DocEntry>();
  private diags = new Map<string, LspDiagnostic[]>();
  private diagSubs = new Set<{
    path: string | null;
    cb: (path: string, diags: LspDiagnostic[]) => void;
  }>();
  private langs = new Map<ServerLang, LangState>();
  private disposed = false;
  /** Whether this is the ACTIVE workspace (setActiveLspWorkspace). Inactive
      facades track docs but never spawn servers — activation resumes them. */
  private active: boolean;
  /** Pending whole-workspace stop (BACKGROUND_STOP_MS after deactivation). */
  private bgTimer: number | null = null;

  constructor(root: string, active: boolean) {
    this.root = root;
    this.active = active;
  }

  private lang(lang: ServerLang): LangState {
    let st = this.langs.get(lang);
    if (!st) {
      st = {
        client: null,
        status: isLanguageEnabled(lang) ? "stopped" : "disabled",
        error: null,
        resolved: null,
        starting: null,
        runningSince: 0,
        lastAutoRestart: 0,
        idleTimer: null,
      };
      this.langs.set(lang, st);
    }
    return st;
  }

  private setStatus(st: LangState, status: ServerStatus, error: string | null = null) {
    if (st.status === status && st.error === error) return;
    st.status = status;
    st.error = error;
    bumpStatusVersion();
  }

  private publish(path: string, diags: LspDiagnostic[]) {
    // Cap BEFORE storing and notifying — neither the retained map nor any
    // subscriber ever sees an unbounded array.
    if (diags.length > STORE_DIAG_CAP) diags = diags.slice(0, STORE_DIAG_CAP);
    if (diags.length) this.diags.set(path, diags);
    else this.diags.delete(path); // don't accumulate empties
    for (const sub of this.diagSubs) {
      if (sub.path === null || sub.path === path) sub.cb(path, diags);
    }
  }

  /** Clear (and notify) all diagnostics belonging to a language's files. */
  private clearLangDiagnostics(lang: ServerLang) {
    for (const path of [...this.diags.keys()]) {
      if (serverLangForPath(path) === lang) this.publish(path, []);
    }
  }

  private ensureStarted(
    lang: ServerLang,
    refresh = false,
    initialError: string | null = null,
  ) {
    const st = this.lang(lang);
    if (this.disposed || st.client || st.starting) return;
    if (!isLanguageEnabled(lang)) {
      this.setStatus(st, "disabled");
      return;
    }
    if (!this.active) {
      // Background workspace: don't burn a server stack on a hidden editor.
      // The docs stay tracked; setActive(true) re-runs this and replays them.
      // (Also the crash-restart landing spot for deactivated workspaces.)
      this.setStatus(st, "stopped");
      return;
    }
    // `initialError` (crash-restart path) carries the crash detail into the
    // "starting" state — handleCrash setting it separately would be wiped by
    // this very call (same status, error→null passes the dedupe guard).
    this.setStatus(st, "starting", initialError);
    st.starting = (async () => {
      try {
        const resolved = await resolveServerBinary(this.root, lang, refresh);
        st.resolved = resolved;
        if (this.disposed || st.client) return;
        if (!isLanguageEnabled(lang)) {
          this.setStatus(st, "disabled");
          return;
        }
        if (!this.active) {
          // Deactivated while resolving — same deal as the gate above.
          this.setStatus(st, "stopped");
          return;
        }
        if (!resolved.path) {
          this.setStatus(st, "missing");
          return;
        }
        // The crash policy judges THIS client's uptime: never inherit a
        // predecessor's runningSince, or a startup crash after a long-lived
        // earlier run passes the proven-stable check it never earned.
        st.runningSince = 0;
        const client = createLspClient({
          serverPath: resolved.path,
          args: SERVER_SPEC[lang].args,
          cwd: this.root,
          root: this.root,
          initializationOptions: SERVER_SPEC[lang].init,
          onDiagnostics: (path, diags) => {
            if (st.client === client) this.publish(path, diags);
          },
          onStatusChange: (status) => {
            if (st.client !== client) return; // superseded client
            if (status === "running") st.runningSince = Date.now();
            this.setStatus(st, status);
          },
          onCrash: (exit) => {
            if (st.client === client) this.handleCrash(lang, st, exit);
          },
        });
        st.client = client;
        // Replay every tracked doc of this language; docs opened later go
        // straight to the client (openDocument is idempotent, so overlap with
        // this loop is harmless).
        for (const [path, doc] of this.docs) {
          if (doc.lang === lang) client.openDocument(path, doc.getText);
        }
      } catch (e) {
        // resolveServerBinary rejection (IPC failure): without this the
        // status would stick at "starting" forever — a state the settings
        // UI shows no restart button for.
        if (!this.disposed) this.setStatus(st, "crashed", String(e));
      }
    })().finally(() => {
      st.starting = null;
    });
  }

  /** The client has already cleaned itself up; decide what happens next. */
  private handleCrash(lang: ServerLang, st: LangState, exit: LspExit) {
    st.client = null;
    this.clearLangDiagnostics(lang); // no zombie squiggles
    const detail =
      exit.stderrTail.trim() ||
      (exit.code !== null ? `exited with code ${exit.code}` : "exited unexpectedly");
    const now = Date.now();
    const provenStable =
      st.runningSince > 0 && now - st.runningSince >= CRASH_MIN_UPTIME_MS;
    const cooledDown = now - st.lastAutoRestart >= CRASH_RESTART_COOLDOWN_MS;
    if (!this.disposed && provenStable && cooledDown) {
      // Transparent recovery from a one-off server OOM; never a loop — a
      // persistently broken setup lands in "crashed" below. The crash detail
      // rides ensureStarted's first setStatus so it survives into "starting".
      st.lastAutoRestart = now;
      this.ensureStarted(lang, false, detail);
    } else {
      this.setStatus(st, "crashed", detail);
    }
  }

  /** Stop a language's client under the idle policy: dispose it but KEEP its
      docs tracked — ensureStarted replays them on resume. False when a start
      is in flight (the caller reschedules; disposing mid-start would let the
      starting closure mint a client nothing tracks). No-client is a success:
      "crashed"/"missing" states pass through untouched. */
  private stopClient(lang: ServerLang, st: LangState): boolean {
    if (st.starting) return false;
    if (!st.client) return true;
    // Null-before-dispose: see restartServer.
    const client = st.client;
    st.client = null;
    client.dispose();
    st.runningSince = 0;
    this.clearLangDiagnostics(lang);
    this.setStatus(st, "stopped");
    return true;
  }

  private scheduleIdleStop(lang: ServerLang, st: LangState, delay: number) {
    if (st.idleTimer !== null) clearTimeout(st.idleTimer);
    st.idleTimer = window.setTimeout(() => {
      st.idleTimer = null;
      if (this.disposed) return;
      // A doc (re)opened during the grace cancels via openDocument, but the
      // re-check is what makes a missed cancel merely redundant, not fatal.
      for (const doc of this.docs.values()) if (doc.lang === lang) return;
      if (!this.stopClient(lang, st)) this.scheduleIdleStop(lang, st, STOP_RETRY_MS);
    }, delay);
  }

  private scheduleBackgroundStop(delay: number) {
    if (this.bgTimer !== null) clearTimeout(this.bgTimer);
    this.bgTimer = window.setTimeout(() => {
      this.bgTimer = null;
      if (this.disposed || this.active) return;
      let retry = false;
      for (const [lang, st] of this.langs) {
        if (!this.stopClient(lang, st)) retry = true;
      }
      if (retry) this.scheduleBackgroundStop(STOP_RETRY_MS);
    }, delay);
  }

  /** Workspace activation hook (setActiveLspWorkspace). Activation resumes
      eagerly — diagnostics are warm by the time the user looks — and
      deactivation arms the background stop. */
  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      if (this.bgTimer !== null) {
        clearTimeout(this.bgTimer);
        this.bgTimer = null;
      }
      const langs = new Set<ServerLang>();
      for (const doc of this.docs.values()) langs.add(doc.lang);
      for (const lang of langs) this.ensureStarted(lang);
    } else {
      this.scheduleBackgroundStop(BACKGROUND_STOP_MS);
    }
  }

  private clientFor(path: string): LspClient | null {
    const lang = serverLangForPath(path);
    if (!lang) return null;
    const st = this.langs.get(lang);
    return st?.client && st.status === "running" ? st.client : null;
  }

  openDocument(path: string, getText: () => string) {
    const lang = serverLangForPath(path);
    if (!lang || this.disposed) return;
    this.docs.set(path, { getText, lang });
    const st = this.lang(lang);
    if (st.idleTimer !== null) {
      clearTimeout(st.idleTimer);
      st.idleTimer = null;
    }
    this.ensureStarted(lang);
    st.client?.openDocument(path, getText);
  }

  changeDocument(path: string, changes: { range: LspRange; text: string }[]) {
    this.clientFor(path)?.changeDocument(path, changes);
  }

  closeDocument(path: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.docs.delete(path);
    const st = this.langs.get(doc.lang);
    st?.client?.closeDocument(path);
    // Servers usually follow didClose with an empty publish, but not
    // guaranteed — clear ourselves (double-clears are harmless).
    if (this.diags.has(path)) this.publish(path, []);
    // Last doc of this language gone (tab closed / switched to another
    // language): arm the zero-docs stop. Tab SWITCHES within the language
    // didOpen the next doc in the same tick, cancelling it immediately.
    if (st && (st.client || st.starting)) {
      for (const d of this.docs.values()) if (d.lang === doc.lang) return;
      this.scheduleIdleStop(doc.lang, st, IDLE_STOP_MS);
    }
  }

  async hover(path: string, pos: LspPosition, signal?: AbortSignal) {
    const client = this.clientFor(path);
    if (!client) return null;
    try {
      return await client.hover(path, pos, signal);
    } catch (e) {
      if (isLspAbort(e)) throw e; // the caller's own cancellation — see interface
      return null; // graceful degradation — "no LSP here" never throws
    }
  }

  async completions(
    path: string,
    pos: LspPosition,
    context?: LspCompletionContext,
    signal?: AbortSignal,
  ) {
    const client = this.clientFor(path);
    if (!client) return { isIncomplete: false, items: [] };
    try {
      return await client.completions(path, pos, context, signal);
    } catch (e) {
      if (isLspAbort(e)) throw e;
      return { isIncomplete: false, items: [] };
    }
  }

  async definition(path: string, pos: LspPosition, signal?: AbortSignal) {
    const client = this.clientFor(path);
    if (!client) return [];
    try {
      return await client.definition(path, pos, signal);
    } catch (e) {
      if (isLspAbort(e)) throw e;
      return [];
    }
  }

  diagnostics(path: string): LspDiagnostic[] {
    return this.diags.get(path) ?? [];
  }

  allDiagnostics(): ReadonlyMap<string, LspDiagnostic[]> {
    return this.diags;
  }

  onDiagnostics(
    path: string | null,
    cb: (path: string, diags: LspDiagnostic[]) => void,
  ): () => void {
    const sub = { path, cb };
    this.diagSubs.add(sub);
    return () => this.diagSubs.delete(sub);
  }

  serverStatus(lang: ServerLang): ServerStatus {
    return this.lang(lang).status;
  }

  serverInfo(lang: ServerLang): LspServerInfo {
    const st = this.lang(lang);
    return { status: st.status, error: st.error, resolved: st.resolved };
  }

  completionTriggers(lang: ServerLang): string[] {
    return this.langs.get(lang)?.client?.triggerCharacters() ?? [];
  }

  restartServer(lang: ServerLang) {
    const st = this.lang(lang);
    // Public facade API (settings UI today, the MCP server later): a restart
    // during an in-flight start would dispose a just-created client, write a
    // quiet "stopped" the UI never sees, and have the trailing ensureStarted
    // single-flighted away — let the in-flight start finish instead.
    if (st.starting) return;
    // Null st.client BEFORE dispose(): dispose synchronously fires
    // setStatus("stopping") back into our callbacks, and only an
    // already-cleared st.client makes the `st.client !== client` guards
    // drop those mid-dispose echoes (stale status bumps, ghost publishes).
    const client = st.client;
    st.client = null;
    client?.dispose();
    st.runningSince = 0;
    this.clearLangDiagnostics(lang);
    if (!isLanguageEnabled(lang)) {
      this.setStatus(st, "disabled");
      return;
    }
    // Reset QUIETLY (no version bump): a bump here would synchronously
    // re-attach editors, whose openDocument kicks ensureStarted WITHOUT the
    // refresh flag and single-flights this call away — losing the fresh
    // binary resolution that makes install-then-restart work.
    st.status = "stopped";
    st.error = null;
    this.ensureStarted(lang, /* refresh binary resolution */ true);
  }

  /** Settings toggles (called via the module-level subscription). */
  onSettingsChanged() {
    for (const lang of Object.keys(SERVER_SPEC) as ServerLang[]) {
      const st = this.lang(lang);
      if (isLanguageEnabled(lang)) {
        if (st.status === "disabled") this.setStatus(st, "stopped");
        // Restart only where there's something to serve.
        if ([...this.docs.values()].some((d) => d.lang === lang)) {
          this.ensureStarted(lang);
        }
      } else if (st.client || st.status !== "disabled") {
        if (st.idleTimer !== null) {
          clearTimeout(st.idleTimer);
          st.idleTimer = null;
        }
        // Null-before-dispose: see restartServer.
        const client = st.client;
        st.client = null;
        client?.dispose();
        st.runningSince = 0;
        this.clearLangDiagnostics(lang);
        this.setStatus(st, "disabled");
      }
    }
  }

  dispose() {
    this.disposed = true;
    if (this.bgTimer !== null) {
      clearTimeout(this.bgTimer);
      this.bgTimer = null;
    }
    for (const [, st] of this.langs) {
      if (st.idleTimer !== null) {
        clearTimeout(st.idleTimer);
        st.idleTimer = null;
      }
      // Null st.client BEFORE dispose() (see restartServer). Order matters
      // doubly here: dispose's synchronous setStatus("stopping") would
      // otherwise bump the status version → still-mounted editors recheck
      // getLspForFile mid-teardown — the first half of the server-leak chain
      // disposeWorkspaceLsp documents.
      const client = st.client;
      st.client = null;
      client?.dispose();
    }
    this.diagSubs.clear();
    this.diags.clear();
    this.docs.clear();
  }
}

const registry = new Map<string, WorkspaceLspImpl>();

/** The active workspace root — facades created later (hidden editors attach
    during session restore) must still know whether they're background. */
let activeRoot: string | null = null;

/** The facade for a workspace, created on first ask (synchronous
    check-then-set — StrictMode-safe). Cheap until a doc actually opens. */
export function getWorkspaceLsp(root: string): WorkspaceLsp {
  const existing = registry.get(root);
  if (existing) return existing;
  const ws = new WorkspaceLspImpl(root, root === activeRoot);
  registry.set(root, ws);
  return ws;
}

/** Workspace-switch hook (stores/workspaces.ts subscribes the active path):
    servers follow the active workspace — the newly active facade resumes
    eagerly, deactivated ones stop after BACKGROUND_STOP_MS. */
export function setActiveLspWorkspace(root: string | null): void {
  activeRoot = root;
  for (const ws of registry.values()) ws.setActive(ws.root === root);
}

/** closeWorkspace hook: shut this workspace's servers down. */
export function disposeWorkspaceLsp(root: string): void {
  const ws = registry.get(root);
  if (!ws) return;
  // Dispose BEFORE deleting from the registry. Any status bump escaping
  // dispose() makes still-mounted editors recheck getLspForFile →
  // getWorkspaceLsp; with the registry already empty that mints a FRESH
  // facade whose openDocument respawns a server for the closing workspace —
  // a process nothing ever reaps. While the old facade stays registered the
  // recheck resolves to it and the editor's `next === lspHandle` no-ops.
  ws.dispose();
  registry.delete(root);
  // The workspaces-store subscriber reassigns this on the next activePath
  // set; null it now so a facade minted in the window can't be born active
  // for a closed workspace.
  if (activeRoot === root) activeRoot = null;
}

/**
 * The editor's attach gate: the workspace facade when `path` belongs to an
 * enabled, viable language server, else null. Null detaches the CM extension
 * bundle (restoring default completions); "stopped"/"starting"/"running"
 * stay attached so the lazy start can happen — "missing"/"crashed" detach
 * until settings re-enable or restart (status changes re-run this via
 * subscribeLspStatus).
 */
export function getLspForFile(root: string, path: string): WorkspaceLsp | null {
  const lang = serverLangForPath(path);
  if (!lang || !isLanguageEnabled(lang)) return null;
  const ws = getWorkspaceLsp(root);
  const status = ws.serverStatus(lang);
  if (status === "missing" || status === "crashed") return null;
  return ws;
}

// One module-level settings subscription fans out to every facade (and bumps
// the status version so editors re-evaluate getLspForFile).
subscribeLspSettings(() => {
  for (const ws of registry.values()) ws.onSettingsChanged();
  bumpStatusVersion();
});

// Dev seam — manual verification from the webview console, and a preview of
// the future MCP integration surface.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vibeLsp = { getWorkspaceLsp };
}
