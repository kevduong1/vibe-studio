/**
 * Framework-free xterm + PTY session, owned by lib/termSessions' registry
 * rather than a React component. Dock terminals are dragged between layout
 * groups, which reparents them in the React tree — an "unmount kills the
 * PTY" component lifecycle would murder the shell on every drop. Instead
 * the session owns its own DOM element: React hosts call attach()
 * (appendChild) on mount and detach() on unmount, and ONLY dispose() — an
 * explicit user/exit/workspace-close path — kills the PTY.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onPtyData,
  onPtyExit,
  ptyAck,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "./ipc";
import { boundedLogicalTail, classifyAgentScreen } from "./agentProfiles";
import type { AgentKind, AgentRuntimeState } from "./agentState";
import {
  acknowledgeAgentRuntime,
  applyAgentActivity,
  applyAgentScreen,
  markAgentLaunching as markRuntimeLaunching,
  markAgentTerminalExited,
  registerAgentRuntime,
  unregisterAgentRuntime,
  useAgentRuntimeStore,
} from "../stores/agentRuntime";
import { trackActivity, type ActivityTracker } from "./terminalActivity";
import { trackedCommandProgram } from "./trackedCommand";
import { terminalPromptInput } from "./terminalPrompt";
import {
  noteAgentPromptOutput,
  settleAgentPromptTurn,
} from "../stores/agentTasks";
import "@xterm/xterm/css/xterm.css";

/** Terminal colors, mirroring theme.css (sanctioned hardcoded-color site:
 *  xterm themes are JS objects, they can't read CSS variables). */
export const XTERM_THEME = {
  background: "#0f1218",
  foreground: "#e3e6ed",
  cursor: "#e3e6ed",
  selectionBackground: "rgba(124,111,242,0.35)",
  black: "#353b46",
  red: "#f06a6a",
  green: "#52c97d",
  yellow: "#e7b75b",
  blue: "#71a7f6",
  magenta: "#b476f4",
  cyan: "#51c5cf",
  white: "#e3e6ed",
  brightBlack: "#626b7a",
  brightRed: "#ff8585",
  brightGreen: "#6edb94",
  brightYellow: "#f2c96e",
  brightBlue: "#8bb8fa",
  brightMagenta: "#c68df8",
  brightCyan: "#70d5dc",
  brightWhite: "#ffffff",
};

/**
 * cols/rows of the most recent dock-session resize, used to seed sessions
 * created hidden (session restore with the panel closed or another group
 * tab in front) so their PTY doesn't start at xterm's 80×24 default and
 * reflow the prompt on first reveal. Dock groups vary in size, so the seed
 * is approximate — cosmetic only, the reveal fit corrects it.
 */
let lastDockFitDims: { cols: number; rows: number } | null = null;

/**
 * A shell exiting non-zero this soon after spawn is treated as "failed to
 * start" (bad $SHELL, broken dotfiles, deleted cwd): the terminal stays open
 * showing the exit code instead of flashing and vanishing.
 */
const EARLY_EXIT_MS = 5000;
/** A trailing screen-classification debounce may be refreshed by chatty
 * output, but never postponed forever. */
const SEMANTIC_MAX_DEBOUNCE_MS = 800;

export type SemanticRuntimeTransitionAction =
  | "none"
  | "generation-inspect"
  | "generation-reset-wait"
  | "recovery-inspect"
  | "reset-wait";

/** Pure transition policy for generation screen boundaries. A true PID
 * replacement cannot inspect the previous occupant's static tail, while a
 * same-generation query recovery must reconsider output received during the
 * outage. */
export function semanticRuntimeTransitionAction(
  previous: AgentRuntimeState | undefined,
  current: AgentRuntimeState | undefined,
  inspectedGeneration: number | undefined,
  boundaryArmed: boolean,
): SemanticRuntimeTransitionAction {
  if (current?.occupancy === "present") {
    if (current.generation !== inspectedGeneration) {
      const replacedPid =
        !boundaryArmed &&
        previous?.occupantPid !== undefined &&
        previous.occupantPid !== current.occupantPid;
      return replacedPid ? "generation-reset-wait" : "generation-inspect";
    }
    if (previous?.occupancy === "unknown") return "recovery-inspect";
  }
  if (
    current &&
    (current.occupancy === "absent" || current.occupancy === "exited") &&
    previous?.occupancy !== current.occupancy
  ) return "reset-wait";
  return "none";
}

export interface SemanticDebounceWindow {
  key: string | null;
  since: number | null;
}

/** Preserve the bounded debounce only while equivalent semantic evidence is
 * repeating. A changed classification gets its own full stability window. */
export function advanceSemanticDebounceWindow(
  previous: SemanticDebounceWindow,
  key: string,
  now: number,
): { window: SemanticDebounceWindow; remaining: number } {
  const since = previous.key === key && previous.since !== null
    ? previous.since
    : now;
  return {
    window: { key, since },
    remaining: SEMANTIC_MAX_DEBOUNCE_MS - (now - since),
  };
}

export interface TermSessionOptions {
  /** Terminal id; doubles as the PTY id. */
  id: string;
  /** Spawn directory (the bound project's root). */
  cwd: string;
  /** Agent sessions get semantic tracking + TERM_PROGRAM masquerade. */
  agent: boolean;
  /** Dedicated agent identity and rollup metadata. Plain shells omit these. */
  agentKind?: AgentKind;
  /** Monitor an ordinary shell for exact Claude/Codex descendants. */
  discoverAgents?: boolean;
  workspacePath?: string;
  agentScope?: "global" | "workspace";
  /** OSC 0/2 window-title changes (agent sessions only). Claude Code
   *  auto-generates topic summaries and emits them as OSC 0 titles for
   *  recognized terminals — the TERM_PROGRAM masquerade satisfies its
   *  allowlist. An empty title (Claude Code's exit reset) clears it. */
  onTitle?: (title: string) => void;
  /** Web link activation. Owners route loopback URLs into native Preview. */
  onLink?: (url: string) => void;
  /** Called before an Enter reaches a live agent prompt. Used to snapshot the
   * task checkout without retaining the submitted text. */
  onUserSubmit?: () => Promise<void>;
  /** PTY exit. `early` = non-zero exit within EARLY_EXIT_MS of spawn (the
   *  corpse is kept readable; the caller should NOT remove the terminal). */
  onExit?: (code: number | null, early: boolean) => void;
}

export interface TermSession {
  readonly id: string;
  readonly term: Terminal;
  /** True once the PTY has exited. Early-exit corpses stay attached and
   *  readable, but writes to them vanish (the backend dropped the PTY) —
   *  callers that reuse sessions (taskRunner) must check this first. */
  readonly exited: boolean;
  /**
   * (Re)parent the session into a React-owned host element. First call
   * opens xterm and spawns the shell; later calls just move the live DOM
   * (drag-and-drop between groups, structural rewraps).
   */
  attach(host: HTMLElement): void;
  /** Remove from the DOM WITHOUT disposing — buffer, PTY, listeners survive. */
  detach(): void;
  focus(): void;
  /** Type text into the shell (queued until the PTY spawn settles, so it's
   *  safe immediately after the session is created — the task runner sends
   *  the command line before the pane host has even mounted). */
  sendText(data: string): void;
  /** Submit one sanitized prompt. Multiline content uses bracketed paste when
   * the live terminal mode supports it, then exactly one Enter. An optional
   * prepare callback runs inside the terminal input queue and returns a
   * synchronous commit callback that is invoked immediately before the PTY
   * write. */
  sendPrompt(
    text: string,
    prepareWrite?: () => void | (() => void) | Promise<void | (() => void)>,
  ): Promise<void>;
  /** Privacy-bounded logical tail for an explicit, in-memory context peek. */
  readTail(maxLines: number, maxChars: number): string[];
  /** Run a shell line with an unforgeable private OSC completion marker.
   * Terminal prose is never interpreted as an exit status. */
  runTrackedCommand(command: string, runId: string): Promise<TrackedCommandResult>;
  /** Set semantic occupancy before typing a launch command into the shell. */
  markAgentLaunching(): void;
  /** Clear the tracker's attention state (user clicked into the terminal). */
  acknowledge(): void;
  /** The ONLY path that kills the PTY. Idempotent. */
  dispose(): void;
}

export type TrackedCommandResult =
  | { runId: string; nonce: string; status: "exited"; exitCode: number }
  | { runId: string; nonce: string; status: "cancelled" };

export function createTermSession(opts: TermSessionOptions): TermSession {
  const { id, cwd, agent } = opts;

  // The session's own wrapper: xterm opens into this exactly once, and
  // reattachment moves the wrapper — term.element never moves relative to
  // it, so xterm itself never notices the reparenting. Reuses the host
  // styling from TerminalPanel.css (fill the pane, .xterm padding/viewport
  // fixes), which is always loaded via TerminalPanel's static import.
  const el = document.createElement("div");
  el.className = "terminal-xterm";
  // Lets lib/termFileDrop resolve a native file drop to its session.
  el.dataset.sessionId = id;

  let disposed = false;
  let spawnStarted = false;
  let spawnPromise: Promise<void> | null = null;
  let spawnedAt = 0;
  let shellReady = false;
  let exited = false;
  /** Input from sendText() before the PTY exists; flushed after spawn. */
  let pendingInput = "";
  let opened = false;
  let unData: UnlistenFn | null = null;
  let unExit: UnlistenFn | null = null;
  let webglLost = false;
  let webglDead = false;
  let runtimeRegistered = false;
  let unRuntime: (() => void) | null = null;
  let semanticTimer: number | null = null;
  let semanticPendingSince: number | null = null;
  let semanticPendingKey: string | null = null;
  let semanticBoundary: { bufferType: string; firstLine: number } | null = null;
  let semanticBoundaryArmed = false;
  const tracked = new Map<
    string,
    { runId: string; resolve: (result: TrackedCommandResult) => void }
  >();

  const watched = () => document.hasFocus() && el.offsetParent !== null;

  const ensureRuntime = () => {
    if (
      runtimeRegistered ||
      (!opts.agentKind && !opts.discoverAgents) ||
      !opts.workspacePath ||
      !opts.agentScope
    ) return;
    runtimeRegistered = true;
    registerAgentRuntime({
      terminalId: id,
      workspacePath: opts.workspacePath,
      scope: opts.agentScope,
      kind: opts.agentKind ?? "claude",
      discovery: opts.discoverAgents,
    });
    let runtimeState = useAgentRuntimeStore.getState().states[id];
    let generation = runtimeState?.generation;
    unRuntime = useAgentRuntimeStore.subscribe((store) => {
      const next = store.states[id];
      const previous = runtimeState;
      runtimeState = next;
      const action = semanticRuntimeTransitionAction(
        previous,
        next,
        generation,
        semanticBoundaryArmed,
      );
      if (action === "generation-inspect") {
        generation = next?.generation;
        clearSemanticTimer();
        // App-owned launches arm an exact pre-command boundary. For a manually
        // typed launch, reuse the boundary captured when the prior occupant
        // became absent; on the first discovered occupant, bound inspection to
        // its current cursor line. Inspect immediately because a static
        // idle/question screen may produce no later write event.
        if (!semanticBoundaryArmed && !semanticBoundary) resetSemanticBoundary();
        inspectSemanticScreen();
        semanticBoundaryArmed = false;
      } else if (action === "generation-reset-wait") {
        generation = next?.generation;
        clearSemanticTimer();
        // A replacement PID has no app-owned pre-command boundary. Start at
        // discovery and require new parsed output so old static scrollback can
        // never become evidence for the replacement generation.
        resetSemanticBoundary();
        semanticBoundaryArmed = false;
      } else if (action === "recovery-inspect") {
        clearSemanticTimer();
        // Writes parsed during occupancy=unknown were intentionally rejected;
        // reconsider the current bounded tail now that the same PID is proven.
        inspectSemanticScreen();
      } else if (action === "reset-wait") {
        clearSemanticTimer();
        resetSemanticBoundary();
        semanticBoundaryArmed = false;
      }
    });
  };

  const term = new Terminal({
    // Sessions are constructed detached and can't be measured yet; seed with
    // the last known dock geometry instead of xterm's 80×24 default.
    ...(lastDockFitDims ?? null),
    fontFamily: "SF Mono, ui-monospace, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: XTERM_THEME,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    opts.onLink?.(uri);
  }));

  // WebGL renderer with silent fallback to the DOM renderer. Unlike the
  // static panes, dock sessions get reparented, and moving a live canvas can
  // lose its GL context — onContextLoss marks it for recreation on the next
  // attach/reveal instead of silently degrading forever. A recreation that
  // throws retires WebGL for this session (DOM renderer from then on).
  const tryWebgl = () => {
    if (webglDead || disposed) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglLost = true;
        // A loss while still visible (the canvas was DOM-moved in place by a
        // keyed reorder — no detach, so no reveal is coming) would leave the
        // terminal blank; recreate right away. setTimeout avoids re-entering
        // the loss event, and the visibility guard keeps hidden sessions on
        // the attach/reveal recovery path.
        window.setTimeout(() => {
          if (!disposed && webglLost && el.offsetParent !== null) {
            tryWebgl();
            term.refresh(0, term.rows - 1);
          }
        }, 0);
      });
      term.loadAddon(webgl);
      webglLost = false;
    } catch {
      webglDead = true;
    }
  };

  let inputChain = Promise.resolve();
  const dataSub = term.onData((data) => {
    inputChain = inputChain
      .then(async () => {
        if ((data.includes("\r") || data.includes("\n")) && opts.onUserSubmit) {
          try {
            await opts.onUserSubmit();
          } catch {
            // Keep the already-typed prompt at the agent input. Its Enter is
            // withheld so the user can retry after the owner surfaces the
            // checkpoint failure.
            return;
          }
        }
        if (semanticEnabled && (data.includes("\r") || data.includes("\n"))) {
          clearSemanticTimer();
          resetSemanticBoundary();
        }
        await ptyWrite(id, data);
      })
      .catch(() => {});
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    lastDockFitDims = { cols, rows };
    void ptyResize(id, cols, rows).catch(() => {});
  });
  const titleSub = opts.onTitle
    ? term.onTitleChange((title) => opts.onTitle!(title.trim()))
    : null;

  // Activity fallback. A pane is considered watched whenever it is visible
  // in the foreground app: semantic completion is about unseen results, not
  // which split currently owns keyboard focus.
  const semanticEnabled = Boolean(opts.agentKind || opts.discoverAgents);
  let tracker: ActivityTracker | null =
    semanticEnabled
      ? trackActivity(
          term,
          watched,
          (activity) => {
            applyAgentActivity(id, activity, watched());
          },
        )
      : null;

  const readLogicalTail = (
    maxLines: number,
    maxChars: number,
    firstLine = 0,
  ): string[] => {
    const lineLimit = Math.max(0, Math.floor(maxLines));
    const charLimit = Math.max(0, Math.floor(maxChars));
    if (lineLimit === 0 || charLimit === 0) return [];
    const buffer = term.buffer.active;
    const first = Math.max(
      0,
      firstLine,
      buffer.length - Math.max(120, lineLimit * 8),
    );
    const logical: string[] = [];
    for (let y = first; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && logical.length > 0) logical[logical.length - 1] += text;
      else logical.push(text);
    }
    return boundedLogicalTail(logical, lineLimit, charLimit);
  };

  const readTail = (maxLines: number, maxChars: number): string[] =>
    readLogicalTail(maxLines, maxChars);

  const resetSemanticBoundary = () => {
    const buffer = term.buffer.active;
    semanticBoundary = {
      bufferType: buffer.type,
      // Include the cursor's current line: the launch command and its first
      // response can append to it without increasing buffer.length.
      firstLine: buffer.baseY + buffer.cursorY,
    };
  };

  const logicalScreenTail = (): string[] => {
    const buffer = term.buffer.active;
    const firstLine = semanticBoundary?.bufferType === buffer.type
      ? semanticBoundary.firstLine
      : 0;
    return readLogicalTail(40, 16 * 1024, firstLine);
  };

  // 6973 is app-private. Returning true consumes the marker before xterm
  // renders it; a matching random nonce is required before any promise is
  // completed, so terminal output cannot impersonate a check result.
  const trackedMarkerSub = term.parser.registerOscHandler(6973, (data) => {
    const match = /^vibe;([^;]+);([^;]+);(\d+)$/.exec(data);
    if (!match) return true;
    const pending = tracked.get(match[2]);
    if (!pending || encodeURIComponent(pending.runId) !== match[1]) return true;
    tracked.delete(match[2]);
    pending.resolve({
      runId: pending.runId,
      nonce: match[2],
      status: "exited",
      exitCode: Number(match[3]),
    });
    return true;
  });

  const cancelTracked = () => {
    for (const [nonce, pending] of tracked) {
      pending.resolve({ runId: pending.runId, nonce, status: "cancelled" });
    }
    tracked.clear();
  };

  const clearSemanticTimer = () => {
    if (semanticTimer !== null) window.clearTimeout(semanticTimer);
    semanticTimer = null;
    semanticPendingSince = null;
    semanticPendingKey = null;
  };

  const inspectSemanticScreen = () => {
    if (!semanticEnabled || !runtimeRegistered || disposed) return;
    const state = useAgentRuntimeStore.getState().states[id];
    if (!state) return;
    const generation = state.generation;
    const classification = classifyAgentScreen(state.kind, logicalScreenTail());
    const delay = classification.strong
      ? 0
      : classification.lifecycle === "idle"
        ? 650
        : classification.lifecycle === "working"
          ? 180
          : 250;
    if (classification.strong) {
      clearSemanticTimer();
      applyAgentScreen(id, generation, classification, watched());
      settleAgentPromptTurn(id, generation, classification);
      return;
    }
    const now = Date.now();
    const key = [
      generation,
      classification.lifecycle,
      classification.reason ?? "",
      classification.matchedRule ?? "",
    ].join(":");
    const advanced = advanceSemanticDebounceWindow(
      { key: semanticPendingKey, since: semanticPendingSince },
      key,
      now,
    );
    semanticPendingKey = advanced.window.key;
    semanticPendingSince = advanced.window.since;
    const { remaining } = advanced;
    if (semanticTimer !== null) window.clearTimeout(semanticTimer);
    if (remaining <= 0) {
      semanticTimer = null;
      semanticPendingSince = null;
      semanticPendingKey = null;
      applyAgentScreen(id, generation, classification, watched());
      settleAgentPromptTurn(id, generation, classification);
      return;
    }
    semanticTimer = window.setTimeout(() => {
      semanticTimer = null;
      semanticPendingSince = null;
      semanticPendingKey = null;
      applyAgentScreen(id, generation, classification, watched());
      settleAgentPromptTurn(id, generation, classification);
    }, Math.min(delay, remaining));
  };
  const semanticSub = semanticEnabled ? term.onWriteParsed(() => {
    const state = useAgentRuntimeStore.getState().states[id];
    if (state) noteAgentPromptOutput(id, state.generation);
    inspectSemanticScreen();
  }) : null;
  const onWindowFocus = () => {
    if (el.offsetParent !== null) acknowledgeAgentRuntime(id);
  };
  if (semanticEnabled) window.addEventListener("focus", onWindowFocus);

  // Attach listeners BEFORE spawning so no early output is lost; guard
  // every await against dispose-before-resolve (listen() resolves late).
  const spawnOnce = () => {
    if (spawnStarted || disposed) return;
    spawnStarted = true;
    void (async () => {
      const u1 = await onPtyData(id, (bytes) => {
        // Ack on parse completion: the Rust reader parks once too much
        // output is in flight, so a chatty child can't flood the webview.
        term.write(bytes, () => void ptyAck(id, bytes.length).catch(() => {}));
      });
      if (disposed) {
        u1();
        return;
      }
      unData = u1;

      const u2 = await onPtyExit(id, (code) => {
        exited = true;
        markAgentTerminalExited(id);
        cancelTracked();
        // A shell dying non-zero right after spawn (bad $SHELL, deleted
        // project dir) would close the terminal and destroy its own error
        // output — keep the corpse readable instead.
        if (code && Date.now() - spawnedAt < EARLY_EXIT_MS) {
          // No more output is coming: retire the tracker now so a busy
          // indicator can't sit stuck until its 30s failsafe.
          tracker?.dispose();
          tracker = null;
          applyAgentActivity(id, { busy: false, attention: false }, watched());
          term.write(`\r\n\x1b[31m[process exited with code ${code}]\x1b[0m\r\n`);
          opts.onExit?.(code, true);
          return;
        }
        opts.onExit?.(code, false);
      });
      if (disposed) {
        u2();
        return;
      }
      unExit = u2;

      try {
        const spawnCols = term.cols;
        const spawnRows = term.rows;
        spawnedAt = Date.now();
        spawnPromise = ptySpawn(id, cwd, spawnCols, spawnRows, agent);
        await spawnPromise;
        // A refit while the spawn was in flight lost its ptyResize
        // ("unknown pty", swallowed) — re-sync the grids if they diverged.
        if (!disposed && (term.cols !== spawnCols || term.rows !== spawnRows)) {
          void ptyResize(id, term.cols, term.rows).catch(() => {});
        }
        shellReady = true;
        if (!disposed && pendingInput) {
          void ptyWrite(id, pendingInput).catch(() => {});
        }
        pendingInput = "";
      } catch (e) {
        if (!disposed) {
          term.write(`\r\n\x1b[31mFailed to spawn shell: ${String(e)}\x1b[0m\r\n`);
        }
      }
    })();
  };

  // Fit/visibility discipline: NEVER fit a hidden wrapper
  // (xterm 6 measures glyphs via OffscreenCanvas even unrendered, so FitAddon
  // would size the grid from a bogus ~10×5 computed height); on reveal, refit
  // and repaint IMMEDIATELY (the renderer is paused while hidden and a
  // debounced refit reads as flicker); plain resizes debounce 50ms. The
  // observer follows the wrapper through reparents, and detach/reattach size
  // changes (W → 0 → W) funnel through the same hidden/reveal paths.
  let fitTimer: number | null = null;
  const clearFitTimer = () => {
    if (fitTimer !== null) {
      window.clearTimeout(fitTimer);
      fitTimer = null;
    }
  };
  let hidden = true; // constructed detached
  const ro = new ResizeObserver(() => {
    if (el.offsetParent === null) {
      hidden = true;
      clearFitTimer(); // a pending fit must not land on a hidden wrapper
      return;
    }
    const revealed = hidden;
    hidden = false;
    clearFitTimer();
    if (revealed) {
      if (webglLost) tryWebgl();
      // proposeDimensions() is undefined right after reveal on engines that
      // measure glyphs via the DOM — fall through to the debounce there.
      if (fit.proposeDimensions()) {
        fit.fit(); // no-op when geometry is unchanged — no canvas clear
        term.refresh(0, term.rows - 1);
        return;
      }
    }
    fitTimer = window.setTimeout(() => {
      fitTimer = null;
      if (el.offsetParent !== null) fit.fit();
    }, 50);
  });
  ro.observe(el);

  return {
    id,
    term,
    get exited() {
      return exited;
    },

    attach(host) {
      if (disposed) return;
      ensureRuntime();
      host.appendChild(el);
      if (!opened) {
        opened = true;
        term.open(el); // exactly once, and only while el is in the DOM
        tryWebgl();
        if (el.offsetParent !== null) {
          fit.fit();
          // Seed here too (onResize fired before lastDockFitDims mattered,
          // and a no-change fit emits no resize event).
          lastDockFitDims = { cols: term.cols, rows: term.rows };
        }
        spawnOnce();
        return;
      }
      // Reattach (drop into another group, structural rewrap): a same-size
      // move doesn't fire the ResizeObserver, but the DOM move may have
      // cleared the canvas — repaint synchronously, guarded as always.
      if (webglLost) tryWebgl();
      if (el.offsetParent !== null && fit.proposeDimensions()) {
        fit.fit();
        term.refresh(0, term.rows - 1);
      }
    },

    detach() {
      el.remove();
    },

    focus() {
      if (!disposed) term.focus();
    },

    sendText(data) {
      if (disposed) return;
      if (shellReady) void ptyWrite(id, data).catch(() => {});
      else pendingInput += data;
    },

    async sendPrompt(text, prepareWrite) {
      if (disposed || exited) {
        throw new Error("The terminal is no longer live.");
      }
      const write = inputChain.then(async () => {
        if (disposed || exited) throw new Error("The terminal is no longer live.");
        const commit = await prepareWrite?.();
        if (disposed || exited) throw new Error("The terminal is no longer live.");
        // The callback is deliberately synchronous: checkpoint publication
        // and the PTY invocation share one JavaScript continuation, so no
        // later keyboard input can slip between them.
        commit?.();
        if (semanticEnabled) {
          clearSemanticTimer();
          resetSemanticBoundary();
        }
        const data = terminalPromptInput(text, term.modes.bracketedPasteMode);
        if (shellReady) await ptyWrite(id, data);
        else pendingInput += data;
      });
      // Programmatic prompts share the same ordering boundary as keystrokes,
      // so a paste cannot interleave with user input already headed to the PTY.
      inputChain = write.catch(() => {});
      await write;
    },

    readTail,

    runTrackedCommand(command, runId) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const nonce = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return new Promise<TrackedCommandResult>((resolve) => {
        if (disposed || exited) {
          resolve({ runId, nonce, status: "cancelled" });
          return;
        }
        tracked.set(nonce, { runId, resolve });
        // Values are generated locally and contain no single quotes. The
        // command remains a shell program so task comments and heredocs keep
        // their expected semantics.
        const wrapped = trackedCommandProgram(command, runId, nonce);
        if (shellReady) void ptyWrite(id, `${wrapped}\r`).catch(() => cancelTracked());
        else pendingInput += `${wrapped}\r`;
      });
    },

    markAgentLaunching() {
      resetSemanticBoundary();
      semanticBoundaryArmed = true;
      clearSemanticTimer();
      ensureRuntime();
      markRuntimeLaunching(id);
    },

    acknowledge() {
      tracker?.acknowledge();
      acknowledgeAgentRuntime(id);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      clearFitTimer();
      unData?.();
      unExit?.();
      dataSub.dispose();
      resizeSub.dispose();
      titleSub?.dispose();
      semanticSub?.dispose();
      trackedMarkerSub.dispose();
      cancelTracked();
      if (semanticEnabled) window.removeEventListener("focus", onWindowFocus);
      unRuntime?.();
      clearSemanticTimer();
      if (tracker) {
        tracker.dispose();
        tracker = null;
        // Drop any lingering indicator (no-op if already pruned).
        applyAgentActivity(id, { busy: false, attention: false }, false);
      }
      if (runtimeRegistered) unregisterAgentRuntime(id);
      // Kill only once a dispatched spawn settles; a null spawnPromise means
      // the disposed guards above bailed before the spawn was ever sent.
      const p = spawnPromise;
      if (p) void p.catch(() => {}).then(() => ptyKill(id)).catch(() => {});
      term.dispose();
      el.remove();
    },
  };
}
