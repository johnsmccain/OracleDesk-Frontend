"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type Politeness = "polite" | "assertive";

export interface AnnounceOptions {
  /** Which live region to write to. Defaults to "polite". */
  politeness?: Politeness;
  /** Identifies the message, so repeats of the same text can be dropped. */
  dedupeKey?: string;
  /** How long the same text is suppressed for the same key. Default 1500 ms. */
  minIntervalMs?: number;
}

/** The minimum time between two identical announcements for the same key. */
export const DEFAULT_MIN_INTERVAL_MS = 1500;
/** Bursts are coalesced: only the last message of a burst is announced. */
export const DEFAULT_COALESCE_WINDOW_MS = 300;

/** The clock and timers the queue uses, so a test can drive them. */
export interface AnnounceClock {
  now(): number;
  setTimeout(handler: () => void, timeout: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: AnnounceClock = {
  now: () => Date.now(),
  setTimeout: (handler, timeout) => setTimeout(handler, timeout),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AnnounceQueue {
  /**
   * Queues a message. Returns false when the message is dropped, either
   * because the same key already produced the same text inside the minimum
   * interval, or because it was coalesced into an identical pending message.
   */
  push(key: string, text: string, emit: (text: string) => void, minIntervalMs?: number): boolean;
  /** Emits every pending message right away. */
  flush(): void;
  /** How many messages are waiting for their window to close. */
  pending(): number;
}

interface PendingMessage {
  text: string;
  handle: unknown;
  emit: (text: string) => void;
}

/**
 * The queue behind the announcer.
 *
 * A screen reader repeats the same text, so the same message for the same
 * key is dropped inside `minIntervalMs`. A burst of messages (the phases of
 * one transaction) is coalesced: only the last one of the burst is announced,
 * after a short trailing window.
 */
export function createAnnounceQueue(clock: AnnounceClock = systemClock): AnnounceQueue {
  const seen = new Map<string, { text: string; at: number }>();
  const pending = new Map<string, PendingMessage>();

  const emitPending = (key: string) => {
    const message = pending.get(key);
    if (!message) return;
    pending.delete(key);
    message.emit(message.text);
  };

  return {
    push(key, text, emit, minIntervalMs = DEFAULT_MIN_INTERVAL_MS) {
      const now = clock.now();
      const last = seen.get(key);
      if (last && last.text === text && now - last.at < minIntervalMs) return false;
      seen.set(key, { text, at: now });

      const existing = pending.get(key);
      if (existing) clock.clearTimeout(existing.handle);
      const handle = clock.setTimeout(() => emitPending(key), DEFAULT_COALESCE_WINDOW_MS);
      pending.set(key, { text, handle, emit });
      return true;
    },
    flush() {
      for (const key of [...pending.keys()]) {
        const message = pending.get(key);
        if (message) clock.clearTimeout(message.handle);
        emitPending(key);
      }
    },
    pending() {
      return pending.size;
    },
  };
}

type Announce = (message: string, options?: AnnounceOptions) => void;

const AnnouncerContext = createContext<Announce | null>(null);

/**
 * Mounts the app's live regions once.
 *
 * Every user-visible status change goes through `useAnnounce()` so that a
 * screen reader hears it once, in the right order, and without the visual
 * text being replaced mid-sentence.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const queue = useRef<AnnounceQueue | null>(null);
  if (queue.current === null) queue.current = createAnnounceQueue();

  const write = useCallback((channel: Politeness, text: string) => {
    const setter = channel === "assertive" ? setAssertive : setPolite;
    // Clear first, then write on the next frame: a live region only
    // announces a change, so an identical message needs the empty beat.
    setter("");
    const writeNow = () => setter(text);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(writeNow);
    else setTimeout(writeNow, 0);
  }, []);

  const announce = useCallback<Announce>(
    (message, options = {}) => {
      const channel = options.politeness ?? "polite";
      const key = options.dedupeKey ?? `${channel}:${message}`;
      queue.current?.push(
        key,
        message,
        (text) => write(channel, text),
        options.minIntervalMs,
      );
    },
    [write],
  );

  useEffect(() => {
    const current = queue.current;
    return () => current?.flush();
  }, []);

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

/** Announces a message in the app's live regions. */
export function useAnnounce(): Announce {
  const ctx = useContext(AnnouncerContext);
  if (!ctx) throw new Error("useAnnounce must be used inside <AnnouncerProvider>");
  return ctx;
}

/**
 * Remembers where the focus was before the wallet took it, and puts it back
 * when the wallet closes.
 *
 * A wallet extension opens its own window and the browser drops the focus
 * when it comes back. Without this, the focus lands on the document body and
 * a screen-reader user has no idea whether they signed or rejected.
 */
export function useFocusReturn(): {
  capture: () => void;
  restore: (fallback?: HTMLElement | null) => void;
} {
  const saved = useRef<HTMLElement | null>(null);

  const capture = useCallback(() => {
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    saved.current = active instanceof HTMLElement ? active : null;
  }, []);

  const restore = useCallback((fallback?: HTMLElement | null) => {
    const target = saved.current;
    saved.current = null;
    if (target && target.isConnected) {
      target.focus();
      return;
    }
    if (fallback && fallback.isConnected) {
      fallback.focus();
    }
  }, []);

  return useMemo(() => ({ capture, restore }), [capture, restore]);
}
