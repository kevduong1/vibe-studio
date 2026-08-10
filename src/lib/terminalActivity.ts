/**
 * Per-pane terminal activity tracking: classifies a pane as busy (a command
 * or agent is producing output) and/or needing attention (it rang the bell,
 * sent a notification, or went quiet while the user was away — e.g. Claude
 * Code stopping to ask a question).
 *
 * Detection is heuristic because stock zsh emits no shell-integration marks:
 *  - busy: sustained output that isn't keystroke echo, debounced at onset
 *    (BUSY_CONFIRM_MS): output must keep flowing briefly before the spinner
 *    shows, so a lone redraw burst (the SIGWINCH repaint when a pane is
 *    dragged or refit) never blips it. Silent commands (`sleep 5`) are
 *    intentionally missed — better than a spinner that can get stuck on.
 *    Alternate-screen TUIs (vim, htop) repaint constantly without "working"
 *    in any meaningful sense, so they never count.
 *  - attention: BEL / OSC 9 / OSC 777 notifications (pty.rs masquerades as a
 *    notification-capable TERM_PROGRAM so agent CLIs actually send these),
 *    plus a busy stretch ≥ ATTENTION_MIN_BUSY_MS ending while the pane was
 *    unwatched ("finished or wants input while you were away") — unwatched
 *    both when the stretch ends and when the grace expires: a user who
 *    watched the end and then left doesn't need to be called back. A stretch
 *    only "ends" once quiet survives PING_GRACE_MS — bursty jobs whose
 *    output merely stalls resume within it and keep their original stretch.
 *    Attention clears when the user types in or clicks into the pane
 *    (acknowledge) — never from the output path: xterm fires onWriteParsed
 *    for the very chunk that delivered a notification, and onData also fires
 *    for terminal-generated replies (focus reports, DA/CPR responses), so
 *    both must be guarded or a ping would wipe itself before being seen.
 *
 * When OSC 133/633 semantic-prompt marks ARE present (iTerm2 / VS Code shell
 * integration sourced in the user's zshrc), they own busy/idle exactly and
 * the output heuristic stands down — until marks go stale mid-stream (e.g.
 * an ssh session with remote integration ended), which falls back. Marks are
 * only ever emitted at command boundaries, so staleness is only judged while
 * idle (a healthy prompt re-marks); a busy command's output never goes
 * "stale", no matter how long it runs.
 */
import type { Terminal } from "@xterm/xterm";
import type { AgentActivitySignal } from "../stores/agentRuntime";

/** Output this soon after a keystroke is treated as echo, not work. */
const ECHO_MS = 250;
/**
 * A new heuristic stretch must keep producing output this long before the
 * busy indicator shows — a lone redraw burst (e.g. the SIGWINCH repaint when
 * a pane is dragged or refit) goes quiet first and never surfaces.
 */
const BUSY_CONFIRM_MS = 250;
/** The busy indicator drops after this long without output. */
const QUIET_MS = 600;
/** Quiet must survive this long before it counts as "the work ended". */
const PING_GRACE_MS = 3000;
/**
 * Only busy stretches at least this long raise attention when they end
 * unwatched, so short unattended bursts (dev-server rebuilds, the odd log
 * line) don't ping the workspace tab.
 */
const ATTENTION_MIN_BUSY_MS = 5000;
/** Output with no mark for this long = shell integration died; fall back. */
const MARK_STALE_MS = 10_000;
/** Failsafe so integrated busy can't be stranded if the final mark is lost. */
const INTEGRATED_QUIET_MS = 30_000;

export interface ActivityTracker {
  /** User clicked into the pane — acknowledge (clear) any attention. */
  acknowledge(): void;
  dispose(): void;
}

export function trackActivity(
  term: Terminal,
  /** Whether the user is watching this pane (termSession supplies visible in
   *  the foreground app, matching unseen-completion semantics). */
  watched: () => boolean,
  /** Fired only when the pane's activity actually changes. */
  onChange: (activity: AgentActivitySignal) => void,
): ActivityTracker {
  let busy = false;
  let attention = false;
  let attentionSource: AgentActivitySignal["attentionSource"];
  /** Start of the current busy stretch; survives sub-grace output stalls. */
  let busySince = 0;
  /** First output of a not-yet-confirmed heuristic stretch (0 = none). */
  let pendingSince = 0;
  let lastOutputAt = 0;
  let lastInputAt = 0;
  let lastMarkAt = 0;
  /** OSC 133/633 marks seen — they own busy/idle, heuristics stand down. */
  let integrated = false;
  /**
   * The integrated quiet failsafe ended a stretch without a completion
   * signal; a D mark arriving later may still owe that stretch its ping.
   */
  let quietEnded = false;
  /** Skip the onWriteParsed of a chunk that only delivered a notification. */
  let skipWrite = false;
  let quietTimer: number | null = null;
  let pingTimer: number | null = null;

  const update = (
    nextBusy: boolean,
    nextAttention: boolean,
    nextSource: AgentActivitySignal["attentionSource"] = nextAttention
      ? attentionSource
      : undefined,
  ) => {
    if (
      nextBusy === busy &&
      nextAttention === attention &&
      nextSource === attentionSource
    ) return;
    busy = nextBusy;
    attention = nextAttention;
    attentionSource = nextSource;
    onChange({ busy, attention, ...(attentionSource && { attentionSource }) });
  };

  const stopQuietTimer = () => {
    if (quietTimer !== null) {
      window.clearTimeout(quietTimer);
      quietTimer = null;
    }
  };
  const stopPingTimer = () => {
    if (pingTimer !== null) {
      window.clearTimeout(pingTimer);
      pingTimer = null;
    }
  };
  const armQuietTimer = (ms: number, onQuiet: () => void = endBusy) => {
    stopQuietTimer();
    quietTimer = window.setTimeout(onQuiet, ms);
  };

  /**
   * Output stopped (or progress was cleared): the busy indicator drops now,
   * but whether this deserves a ping is decided only once the quiet survives
   * the grace window — output resuming in time cancels it (same stretch).
   */
  const endBusy = () => {
    stopQuietTimer();
    pendingSince = 0; // an unconfirmed candidate went quiet — never was work
    if (!busy) return;
    update(false, attention);
    const stretch = lastOutputAt - busySince;
    // "Ended while you were away" means unwatched at the END of the stretch
    // too, not just when the grace expires — a user who watched the command
    // finish and then switched away mustn't be pinged back.
    const endedWatched = watched();
    stopPingTimer();
    pingTimer = window.setTimeout(() => {
      pingTimer = null;
      if (!endedWatched && !watched() && stretch >= ATTENTION_MIN_BUSY_MS) {
        update(busy, true, "completion");
      }
    }, PING_GRACE_MS);
  };

  /**
   * Integrated-mode failsafe quiet: recover a stranded busy indicator (lost
   * D mark, silent command) WITHOUT treating it as a completion — no ping.
   * quietEnded lets a D mark that does arrive late still earn its ping.
   */
  const endBusyQuietly = () => {
    stopQuietTimer();
    pendingSince = 0;
    if (!busy) return;
    quietEnded = true;
    update(false, attention);
  };

  const beginBusy = () => {
    lastOutputAt = Date.now();
    quietEnded = false; // heuristic stretch supersedes any failsafe-ended one
    armQuietTimer(QUIET_MS);
    if (busy) return;
    if (pingTimer !== null) {
      // Resumed within grace: the same, already-proven stretch (original
      // busySince) — no re-confirmation.
      stopPingTimer();
      update(true, attention);
      return;
    }
    // Debounced onset: a genuinely new stretch is only a candidate until
    // output has kept flowing for BUSY_CONFIRM_MS — a lone redraw burst
    // (pane drag → SIGWINCH repaint) ends quietly via endBusy instead.
    if (pendingSince === 0) {
      pendingSince = lastOutputAt;
    } else if (lastOutputAt - pendingSince >= BUSY_CONFIRM_MS) {
      busySince = pendingSince; // the stretch started at its first output
      pendingSince = 0;
      update(true, attention);
    }
  };

  const notify = () => {
    // The chunk delivering a notification mustn't also start a busy stretch
    // (which is what its own onWriteParsed would do).
    skipWrite = true;
    if (!watched()) update(busy, true, "notification");
  };

  const disposables = [
    term.onWriteParsed(() => {
      if (skipWrite) {
        skipWrite = false;
        return;
      }
      if (integrated) {
        // Staleness only applies while idle: marks come at command
        // boundaries only, so a busy command's output is never "stale" —
        // a long build must not flip back to the heuristic mid-command
        // (busy flicker + false pings). A stranded busy (lost D mark) is
        // the quiet failsafe's job, after which staleness applies again.
        if (busy || Date.now() - lastMarkAt <= MARK_STALE_MS) {
          lastOutputAt = Date.now(); // keep stretch accounting honest
          if (busy) armQuietTimer(INTEGRATED_QUIET_MS, endBusyQuietly);
          return;
        }
        // Marks are stale and the failsafe quietly ended a C-opened
        // stretch: non-echo output means the command was merely silent
        // (long link phase) and is still running — resume the SAME stretch
        // (original busySince) so the eventual D mark's ping is honest and
        // the heuristic stays out mid-command. Echo instead means the user
        // is typing at a prompt the integration failed to mark: it died.
        if (quietEnded && Date.now() - lastInputAt >= ECHO_MS) {
          quietEnded = false;
          lastOutputAt = Date.now();
          armQuietTimer(INTEGRATED_QUIET_MS, endBusyQuietly);
          update(true, attention);
          return;
        }
        quietEnded = false;
        integrated = false; // marks died mid-stream — heuristics take over
      }
      if (term.buffer.active.type === "alternate") return;
      if (Date.now() - lastInputAt < ECHO_MS) {
        // Echo can't start a busy stretch, but it keeps one alive.
        if (busy) armQuietTimer(QUIET_MS);
        return;
      }
      beginBusy();
    }),

    term.onData(() => {
      // Real input implies a focused, visible pane — terminal-generated
      // replies (focus reports, DA/CPR responses) don't get to impersonate
      // the user while they're away.
      if (!watched()) return;
      lastInputAt = Date.now();
      // The user responded — whatever wanted them has them now.
      stopPingTimer();
      if (attention) update(busy, false);
    }),

    term.onBell(notify),

    // OSC 133 (FinalTerm/iTerm2) / OSC 633 (VS Code) semantic prompts:
    // C = command output starts, D = command finished, A/B = at the prompt.
    ...[133, 633].map((code) =>
      term.parser.registerOscHandler(code, (data) => {
        const kind = data[0];
        if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") {
          return false;
        }
        integrated = true;
        lastMarkAt = Date.now();
        stopQuietTimer();
        pendingSince = 0; // marks own busy/idle — drop any heuristic candidate
        if (kind === "C") {
          if (!busy) busySince = lastMarkAt;
          quietEnded = false;
          lastOutputAt = lastMarkAt;
          stopPingTimer();
          // In case the D mark gets lost.
          armQuietTimer(INTEGRATED_QUIET_MS, endBusyQuietly);
          update(true, attention);
        } else {
          // A/B/D all mean any in-flight command is over (A/B: the prompt
          // is back — the only signal a prompt-only integration ever
          // sends). An explicit end pings immediately — no grace needed —
          // but still only for stretches long enough to matter. busy may
          // already have been dropped by the quiet failsafe (quietEnded);
          // the stretch still counts. A pending heuristic grace ping keeps
          // its own appointment — busy is false then, so this expression
          // stays out of its way.
          const ping =
            (busy || quietEnded) &&
            !watched() &&
            lastMarkAt - busySince >= ATTENTION_MIN_BUSY_MS;
          quietEnded = false;
          update(false, attention || ping, ping ? "completion" : attentionSource);
        }
        return true;
      }),
    ),

    // OSC 9: ConEmu-style progress ("4;<state>;<pct>") or a notification.
    term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("4;")) {
        notify();
        return true;
      }
      const state = data.split(";")[1];
      if (state === "2") notify(); // error state
      else if (!integrated) {
        skipWrite = true;
        if (state === "0") endBusy(); // progress cleared = went quiet
        else beginBusy(); // ticking progress keeps busy alive
      }
      return true;
    }),

    // OSC 777: "notify;<title>;<body>" (Claude Code & friends).
    term.parser.registerOscHandler(777, (data) => {
      if (!data.startsWith("notify;")) return false;
      notify();
      return true;
    }),
  ];

  let disposed = false;
  return {
    acknowledge: () => {
      if (disposed) return; // a click on a dead pane must not re-report
      stopPingTimer(); // the user has seen it — don't ping after they leave
      update(busy, false);
    },
    // Idempotent: a pane whose PTY died early disposes its tracker right
    // away (nothing further to track) and again on unmount.
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopQuietTimer();
      stopPingTimer();
      for (const d of disposables) d.dispose();
    },
  };
}
