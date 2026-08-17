import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { trackActivity } from "./terminalActivity";
import type { AgentActivitySignal } from "../stores/agentRuntime";

/**
 * Minimal xterm stand-in: the tracker only ever subscribes to write/data/bell
 * and registers OSC handlers, so the harness just replays those.
 */
const fakeTerm = () => {
  const writes: Array<() => void> = [];
  const inputs: Array<() => void> = [];
  const bells: Array<() => void> = [];
  const osc = new Map<number, (data: string) => boolean>();
  const buffer = { active: { type: "normal" as "normal" | "alternate" } };
  const disposable = { dispose: () => {} };
  const term = {
    buffer,
    onWriteParsed: (fn: () => void) => (writes.push(fn), disposable),
    onData: (fn: () => void) => (inputs.push(fn), disposable),
    onBell: (fn: () => void) => (bells.push(fn), disposable),
    parser: {
      registerOscHandler: (code: number, fn: (data: string) => boolean) => {
        osc.set(code, fn);
        return disposable;
      },
    },
  } as unknown as Terminal;
  return {
    term,
    buffer,
    write: () => writes.forEach((fn) => fn()),
    input: () => inputs.forEach((fn) => fn()),
    bell: () => bells.forEach((fn) => fn()),
    mark: (kind: string) => osc.get(133)!(kind),
  };
};

const setup = (watched = false) => {
  const term = fakeTerm();
  const signals: AgentActivitySignal[] = [];
  let isWatched = watched;
  const tracker = trackActivity(
    term.term,
    () => isWatched,
    (signal) => signals.push(signal),
  );
  return {
    ...term,
    tracker,
    signals,
    latest: () => signals[signals.length - 1],
    unwatch: () => {
      isWatched = false;
    },
  };
};

/** Sustained output for `ms`, confirming a heuristic stretch of that length. */
const produceOutput = (harness: ReturnType<typeof setup>, ms: number) => {
  harness.write();
  vi.advanceTimersByTime(300); // > BUSY_CONFIRM_MS
  harness.write();
  for (let elapsed = 300; elapsed < ms; elapsed += 500) {
    vi.advanceTimersByTime(500); // < QUIET_MS, so the stretch continues
    harness.write();
  }
};

/** Quiet long enough to drop busy and settle the turn. */
const goQuiet = () => vi.advanceTimersByTime(600 + 3000 + 10);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shell-integration marks", () => {
  it("does not let an agent's single launch mark report busy for the session", () => {
    const h = setup();
    h.mark("C"); // the shell marks `claude` starting; no D until it exits
    expect(h.latest()).toMatchObject({ busy: true });

    h.write(); // startup banner
    goQuiet();

    expect(h.latest()).toMatchObject({ busy: false, completed: true });
    h.tracker.dispose();
  });

  it("reports each turn between marks instead of one session-long command", () => {
    const h = setup();
    h.mark("C");
    goQuiet();
    expect(h.latest()).toMatchObject({ busy: false, completed: true });

    produceOutput(h, 1000);
    expect(h.latest()).toMatchObject({ busy: true });
    expect(h.latest().completed).toBeFalsy();
    goQuiet();
    expect(h.latest()).toMatchObject({ busy: false, completed: true });
    h.tracker.dispose();
  });

  it("completes immediately on an explicit end mark and pings a long unwatched stretch", () => {
    const h = setup();
    h.mark("C");
    produceOutput(h, 6000); // output keeps flowing until the command ends
    h.mark("D"); // no grace wait: an explicit boundary is authoritative

    expect(h.latest()).toMatchObject({
      busy: false,
      completed: true,
      attention: true,
      attentionSource: "completion",
    });
    h.tracker.dispose();
  });
});

describe("output buffers", () => {
  it("tracks sustained alternate-screen output for Codex fallback", () => {
    const h = setup();
    h.buffer.active.type = "alternate";

    produceOutput(h, 1000);

    expect(h.latest()).toMatchObject({ busy: true, attention: false });
    h.tracker.dispose();
  });
});

describe("notifications", () => {
  it("records a bell while the pane is watched", () => {
    const h = setup(true);
    h.bell();
    expect(h.latest()).toMatchObject({
      attention: true,
      attentionSource: "notification",
    });
    h.tracker.dispose();
  });

  it("keeps a watched notification pending once the user looks away", () => {
    const h = setup(true);
    h.bell();
    h.unwatch();
    // Nothing re-reports it, so the recorded attention is the only thing
    // keeping the prompt alive — dropping it at ring time lost it for good.
    expect(h.latest()).toMatchObject({
      attention: true,
      attentionSource: "notification",
    });
    h.tracker.dispose();
  });

  it("keeps a notification through the write that delivered it", () => {
    const h = setup();
    h.bell();
    h.write(); // the same chunk's onWriteParsed
    vi.advanceTimersByTime(300);
    expect(h.latest()).toMatchObject({ attention: true, busy: false });
    h.tracker.dispose();
  });

  it("still reports the turn when the user reaches the pane inside the grace", () => {
    const h = setup();
    produceOutput(h, 6000);
    vi.advanceTimersByTime(600 + 100); // busy dropped, grace still running
    // A reveal, an inbox jump, a pane click or a file drop all land here.
    // Deleting the pending timer would strand the turn as unknown forever.
    h.tracker.acknowledge();
    vi.advanceTimersByTime(3000);
    expect(h.latest()).toMatchObject({ completed: true, attention: false });
    h.tracker.dispose();
  });

  it("still reports the turn when the user types inside the grace", () => {
    const h = setup(true);
    produceOutput(h, 6000);
    vi.advanceTimersByTime(700);
    h.input();
    vi.advanceTimersByTime(3000);
    expect(h.latest()).toMatchObject({ completed: true, attention: false });
    h.tracker.dispose();
  });

  it("clears attention on acknowledgement without unsettling the turn", () => {
    const h = setup();
    produceOutput(h, 6000);
    goQuiet();
    expect(h.latest()).toMatchObject({ completed: true, attention: true });

    h.tracker.acknowledge();
    expect(h.latest()).toMatchObject({ completed: true, attention: false });
    h.tracker.dispose();
  });
});

describe("quiet completion", () => {
  it("settles a short background turn without an attention ping", () => {
    const h = setup();
    produceOutput(h, 1000);
    goQuiet();
    expect(h.latest()).toMatchObject({
      busy: false,
      completed: true,
      attention: false,
    });
    h.tracker.dispose();
  });

  it("pings a long stretch that ended unwatched", () => {
    const h = setup();
    produceOutput(h, 6000);
    goQuiet();
    expect(h.latest()).toMatchObject({
      completed: true,
      attention: true,
      attentionSource: "completion",
    });
    h.tracker.dispose();
  });

  it("settles but does not ping a stretch the user watched end", () => {
    const h = setup(true);
    produceOutput(h, 6000);
    goQuiet();
    expect(h.latest()).toMatchObject({ completed: true, attention: false });
    h.tracker.dispose();
  });

  it("treats output resuming inside the grace as the same, unfinished stretch", () => {
    const h = setup();
    produceOutput(h, 6000);
    vi.advanceTimersByTime(600 + 100); // busy drops, grace still running
    expect(h.latest()).toMatchObject({ busy: false });
    expect(h.latest().completed).toBeFalsy();

    h.write();
    expect(h.latest()).toMatchObject({ busy: true });
    expect(h.signals.some((signal) => signal.completed)).toBe(false);
    h.tracker.dispose();
  });

  it("ignores keystroke echo as work", () => {
    const h = setup(true);
    h.input();
    h.write();
    vi.advanceTimersByTime(100);
    h.write();
    expect(h.signals).toHaveLength(0);
    h.tracker.dispose();
  });
});
