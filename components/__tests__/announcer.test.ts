import { describe, expect, it } from "vitest";
import { createAnnounceQueue, DEFAULT_MIN_INTERVAL_MS, type AnnounceClock } from "../ui/announcer";

/** A clock the test drives by hand. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: AnnounceClock = {
    now: () => now,
    setTimeout: (run, timeout) => {
      const id = nextId++;
      timers.set(id, { at: now + timeout, run });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    pendingTimers: () => timers.size,
  };
}

describe("announce queue", () => {
  it("drops an identical message for the same key inside the minimum interval", () => {
    const { clock, advance } = fakeClock();
    const queue = createAnnounceQueue(clock);
    const emitted: string[] = [];

    expect(queue.push("k", "Bought 10 shares.", (text) => emitted.push(text))).toBe(true);
    expect(queue.push("k", "Bought 10 shares.", (text) => emitted.push(text))).toBe(false);

    advance(1000);
    expect(emitted).toEqual(["Bought 10 shares."]);
  });

  it("announces the same text again once the interval has passed", () => {
    const { clock, advance } = fakeClock();
    const queue = createAnnounceQueue(clock);
    const emitted: string[] = [];

    queue.push("k", "Bought 10 shares.", (text) => emitted.push(text));
    advance(DEFAULT_MIN_INTERVAL_MS + 1);
    queue.push("k", "Bought 10 shares.", (text) => emitted.push(text));
    advance(1000);

    expect(emitted).toEqual(["Bought 10 shares.", "Bought 10 shares."]);
  });

  it("coalesces a burst to its last message", () => {
    const { clock, advance } = fakeClock();
    const queue = createAnnounceQueue(clock);
    const emitted: string[] = [];

    queue.push("k", "Quoting…", (text) => emitted.push(text));
    queue.push("k", "Sending…", (text) => emitted.push(text));
    queue.push("k", "Confirmed.", (text) => emitted.push(text));
    expect(emitted).toEqual([]);

    advance(1000);
    expect(emitted).toEqual(["Confirmed."]);
  });

  it("keeps different keys independent", () => {
    const { clock, advance } = fakeClock();
    const queue = createAnnounceQueue(clock);
    const emitted: string[] = [];

    queue.push("buy", "Bought 10 shares.", (text) => emitted.push(text));
    queue.push("sell", "Bought 10 shares.", (text) => emitted.push(text));
    expect(queue.pending()).toBe(2);

    advance(1000);
    expect(emitted).toEqual(["Bought 10 shares.", "Bought 10 shares."]);
  });

  it("flushes the pending messages when asked", () => {
    const { clock } = fakeClock();
    const queue = createAnnounceQueue(clock);
    const emitted: string[] = [];

    queue.push("k", "One", (text) => emitted.push(text));
    queue.push("k", "Two", (text) => emitted.push(text));
    expect(queue.pending()).toBe(1);

    queue.flush();
    expect(emitted).toEqual(["Two"]);
    expect(queue.pending()).toBe(0);
  });
});
