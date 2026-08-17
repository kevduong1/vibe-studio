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
 *    Alternate-screen output is tracked too because Codex uses that buffer.
 *    The semantic runtime applies these signals only while process polling
 *    proves a supported agent is present, so an ordinary vim/htop session in
 *    a discovery-enabled shell cannot become agent work.
 *  - completed: a confirmed stretch whose quiet survived PING_GRACE_MS — the
 *    turn is over. This is the semantic signal (the runtime store turns it
 *    into idle, and into unseen Done when the stretch ran unwatched); it is
 *    reported for every stretch, however short and whoever was watching.
 *    Bursty jobs whose output merely stalls resume within the grace and keep
 *    their original stretch, so a mid-turn pause never announces completion.
 *  - attention: BEL / OSC 9 / OSC 777 notifications (pty.rs masquerades as a
 *    notification-capable TERM_PROGRAM so agent CLIs actually send these),
 *    plus a completing stretch ≥ ATTENTION_MIN_BUSY_MS that ended while the
 *    pane was unwatched ("finished or wants input while you were away") —
 *    unwatched both when the stretch ends and when the grace expires: a user
 *    who watched the end and then left doesn't need to be called back.
 *    Attention clears when the user types in or clicks into the pane
 *    (acknowledge) — never from the output path: xterm fires onWriteParsed
 *    for the very chunk that delivered a notification, and onData also fires
 *    for terminal-generated replies (focus reports, DA/CPR responses), so
 *    both must be guarded or a ping would wipe itself before being seen.
 *
 * When OSC 133/633 semantic-prompt marks ARE present (iTerm2 / VS Code shell
 * integration sourced in the user's zshrc), they supply exact command
 * boundaries: C starts a stretch immediately (no onset debounce) and A/B/D
 * end one immediately (no grace). They do NOT own busy for the duration in
 * between, because these trackers exist for agent panes: an agent CLI is one
 * long command, emitting a single C at launch and no D until it exits, so
 * mark-owned busy would report "working" for the entire session and drown
 * every quiet turn boundary. Between marks the ordinary quiet heuristic runs,
 * which costs a silent shell command its spinner (`sleep 60` under shell
 * integration) but never reports a turn that did not happen. Marks going
 * stale mid-stream (an ssh session with remote integration ended) drops the
 * tracker back to pure heuristics, so OSC 9 progress is honoured again.
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
 * Only busy stretches at least this long raise ATTENTION when they end
 * unwatched, so short unattended bursts (dev-server rebuilds, the odd log
 * line) don't ping the workspace tab. It deliberately no longer gates
 * semantic completion: a five-second floor on `completed` meant quick agent
 * turns never settled at all (no idle, no Done). The floor stays where its
 * noise argument holds — the ping — and the turn boundary is reported
 * regardless.
 */
const ATTENTION_MIN_BUSY_MS = 5000;
/** Output with no mark for this long = shell integration died; fall back. */
const MARK_STALE_MS = 10_000;

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
  /** A stretch ended and stayed ended — the turn boundary the store needs. */
  let completed = false;
  /** Start of the current busy stretch; survives sub-grace output stalls. */
  let busySince = 0;
  /** First output of a not-yet-confirmed heuristic stretch (0 = none). */
  let pendingSince = 0;
  let lastOutputAt = 0;
  let lastInputAt = 0;
  let lastMarkAt = 0;
  /** OSC 133/633 marks seen — they supply exact command boundaries. */
  let integrated = false;
  /** Skip the onWriteParsed of a chunk that only delivered a notification. */
  let skipWrite = false;
  /**
   * The user reached the pane while a stretch was settling: the pending
   * completion must still be reported (it is the only turn boundary the
   * runtime gets) but it no longer deserves an attention ping.
   */
  let pingSuppressed = false;
  let quietTimer: number | null = null;
  let pingTimer: number | null = null;

  const update = (patch: Partial<AgentActivitySignal>) => {
    const nextBusy = patch.busy ?? busy;
    const nextAttention = patch.attention ?? attention;
    const nextSource = nextAttention
      ? (patch.attentionSource ?? attentionSource)
      : undefined;
    const nextCompleted = patch.completed ?? completed;
    if (
      nextBusy === busy &&
      nextAttention === attention &&
      nextSource === attentionSource &&
      nextCompleted === completed
    ) return;
    busy = nextBusy;
    attention = nextAttention;
    attentionSource = nextSource;
    completed = nextCompleted;
    onChange({
      busy,
      attention,
      ...(attentionSource && { attentionSource }),
      ...(completed && { completed }),
    });
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
  const armQuietTimer = (ms: number) => {
    stopQuietTimer();
    quietTimer = window.setTimeout(() => endBusy(), ms);
  };

  /**
   * Output stopped (or progress was cleared): the busy indicator drops now,
   * but the turn is only declared over once the quiet survives the grace
   * window — output resuming in time cancels it (same stretch). Whether the
   * completion also deserves a ping is decided at the same moment.
   */
  const endBusy = () => {
    stopQuietTimer();
    pendingSince = 0; // an unconfirmed candidate went quiet — never was work
    if (!busy) return;
    update({ busy: false });
    const stretch = lastOutputAt - busySince;
    // "Ended while you were away" means unwatched at the END of the stretch
    // too, not just when the grace expires — a user who watched the command
    // finish and then switched away mustn't be pinged back.
    const endedWatched = watched();
    stopPingTimer();
    pingSuppressed = false;
    pingTimer = window.setTimeout(() => {
      pingTimer = null;
      const ping =
        !pingSuppressed &&
        !endedWatched &&
        !watched() &&
        stretch >= ATTENTION_MIN_BUSY_MS;
      update(
        ping
          ? { completed: true, attention: true, attentionSource: "completion" }
          : { completed: true },
      );
    }, PING_GRACE_MS);
  };

  const beginBusy = () => {
    lastOutputAt = Date.now();
    armQuietTimer(QUIET_MS);
    if (busy) return;
    if (pingTimer !== null) {
      // Resumed within grace: the same, already-proven stretch (original
      // busySince) — no re-confirmation, and the turn was never over.
      stopPingTimer();
      update({ busy: true, completed: false });
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
      update({ busy: true, completed: false });
    }
  };

  const notify = () => {
    // The chunk delivering a notification mustn't also start a busy stretch
    // (which is what its own onWriteParsed would do).
    skipWrite = true;
    // Recorded even while the pane is watched: the ring is evidence that the
    // agent stopped for input, and dropping it left a still-pending prompt
    // invisible the moment the user looked away. Watchedness decides only
    // whether it arrives already acknowledged — the store reads that from
    // the same watched() the caller passes it.
    update({ attention: true, attentionSource: "notification" });
  };

  const disposables = [
    term.onWriteParsed(() => {
      if (skipWrite) {
        skipWrite = false;
        return;
      }
      // Marks that stopped arriving while nothing is running (an ssh session
      // with remote integration ended) mean the integration died; only then
      // do mark-specific paths like OSC 9 progress come back.
      if (integrated && !busy && Date.now() - lastMarkAt > MARK_STALE_MS) {
        integrated = false;
      }
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
      // The user responded — whatever wanted them has them now. The settling
      // stretch still owes the runtime its boundary, so only the ping is
      // cancelled; killing the timer would strand the turn as unknown.
      pingSuppressed = true;
      if (attention) update({ attention: false });
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
        pendingSince = 0; // an exact boundary supersedes any heuristic candidate
        if (kind === "C") {
          // An exact command start needs no onset debounce, but the stretch
          // it opens is bounded by the ordinary quiet window — an agent's
          // one session-long command must not read as one endless turn.
          if (!busy) busySince = lastMarkAt;
          lastOutputAt = lastMarkAt;
          stopPingTimer();
          armQuietTimer(QUIET_MS);
          update({ busy: true, completed: false });
        } else {
          // A/B/D all mean any in-flight command is over (A/B: the prompt
          // is back — the only signal a prompt-only integration ever
          // sends). An explicit end completes immediately — no grace
          // needed — and pings only for stretches long enough to matter. If
          // the quiet window already dropped busy, its pending grace ping
          // keeps its own appointment and owns the decision.
          const ping =
            busy && !watched() && lastMarkAt - busySince >= ATTENTION_MIN_BUSY_MS;
          update(
            ping
              ? { busy: false, completed: true, attention: true, attentionSource: "completion" }
              : { busy: false, completed: true },
          );
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
      // The user has seen it — don't ping after they leave. The pending
      // timer is deliberately left running: it carries the completion of a
      // stretch that is still settling, and reaching the pane (a click, an
      // inbox jump, a file drop, any reveal) must not delete the only turn
      // boundary the runtime will ever see for that stretch.
      pingSuppressed = true;
      // Only the alert is cleared. The runtime keeps a blocked lifecycle
      // until new terminal evidence changes it: viewing is not an answer.
      update({ attention: false });
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
