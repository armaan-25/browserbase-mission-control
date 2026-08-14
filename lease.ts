/**
 * A write lease for a browser page shared by multiple CDP clients.
 *
 * Stagehand v4 moved state management into the browser and let other clients
 * (Playwright, Puppeteer) attach alongside it. Browserbase named the resulting
 * hazard in the launch post:
 *
 *   "What they can still do is step on each other inside the browser. Two
 *    clients that navigate or close the same page, set cookies, or intercept
 *    requests, are both writing to the same state, and nothing in CDP monitors
 *    that."
 *      — browserbase.com/blog/stagehand-v4, 2026-08-10
 *
 * That is verifiable: `demo.ts` in this folder has one client type into a form
 * while another navigates, and the form is destroyed with no error raised on
 * either side. CDP delivers both writes faithfully; nobody arbitrates.
 *
 * WHAT THIS IS
 * A lease is a mutual-exclusion token scoped to one page. A client holding it
 * may write; others queue. Reads are never blocked, because concurrent reads
 * cannot corrupt state and blocking them would make the layer a bottleneck
 * rather than a guardrail.
 *
 * WHY A LEASE AND NOT A LOCK
 * Leases expire. A client that crashes mid-write must not wedge the page
 * forever — an automation client dying between `acquire` and `release` is the
 * normal case, not the exception. Every lease carries a TTL and is reclaimed
 * when it lapses, so the failure mode is a late write from a zombie client
 * (detectable, see `isHeldBy`) rather than a permanent deadlock.
 *
 * WHAT THIS IS NOT
 * It does not intercept CDP. Clients opt in by routing writes through
 * `withWrite`. Making it transparent would mean proxying the CDP websocket and
 * classifying every command by whether it mutates state — strictly more
 * powerful, and a different project. Browserbase says they are "working on
 * adding functionality to drive both from a single script"; this is the
 * complementary case, where two clients already exist independently and cannot
 * be merged into one script.
 */

/** Milliseconds a lease survives without renewal before it can be reclaimed. */
const DEFAULT_TTL_MS = 5_000;

export interface LeaseGrant {
  readonly holder: string;
  readonly pageId: string;
  /** Wall-clock ms after which this grant is void. */
  readonly expiresAt: number;
}

export interface LeaseEvent {
  readonly type: "acquired" | "queued" | "released" | "expired" | "rejected";
  readonly holder: string;
  readonly pageId: string;
  /** Clients waiting behind the current holder at the time of the event. */
  readonly waiting: number;
  readonly at: number;
}

interface Waiter {
  readonly holder: string;
  readonly resolve: (grant: LeaseGrant) => void;
  readonly reject: (error: Error) => void;
  readonly ttlMs: number;
}

interface PageState {
  grant: LeaseGrant | null;
  queue: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserLease {
  /** Run `write` while holding the page's lease; queues if another holds it. */
  withWrite<T>(pageId: string, holder: string, write: () => Promise<T>, ttlMs?: number): Promise<T>;
  /** True when `holder` currently holds an unexpired lease on `pageId`. */
  isHeldBy(pageId: string, holder: string): boolean;
  /** Who holds the page right now, or null. */
  holderOf(pageId: string): string | null;
  /** Clients waiting on `pageId`. */
  waiting(pageId: string): number;
  /** Subscribe to lease transitions — the log that makes arbitration visible. */
  onEvent(listener: (event: LeaseEvent) => void): () => void;
  /** Drop all state; queued waiters are rejected. */
  dispose(): void;
}

export function createBrowserLease(options: { now?: () => number } = {}): BrowserLease {
  const now = options.now ?? Date.now;
  const pages = new Map<string, PageState>();
  const listeners = new Set<(event: LeaseEvent) => void>();

  const stateOf = (pageId: string): PageState => {
    let state = pages.get(pageId);
    if (!state) {
      state = { grant: null, queue: [], timer: null };
      pages.set(pageId, state);
    }
    return state;
  };

  const emit = (type: LeaseEvent["type"], holder: string, pageId: string) => {
    const event: LeaseEvent = {
      type,
      holder,
      pageId,
      waiting: pages.get(pageId)?.queue.length ?? 0,
      at: now(),
    };
    for (const listener of listeners) listener(event);
  };

  /** Hand the page to the next waiter, or leave it free. */
  const promote = (pageId: string): void => {
    const state = stateOf(pageId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const next = state.queue.shift();
    if (!next) {
      state.grant = null;
      return;
    }
    state.grant = { holder: next.holder, pageId, expiresAt: now() + next.ttlMs };
    // Expiry is what makes this a lease: a holder that dies mid-write releases
    // the page on its own, instead of wedging every other client forever.
    state.timer = setTimeout(() => {
      if (state.grant?.holder === next.holder) {
        emit("expired", next.holder, pageId);
        promote(pageId);
      }
    }, next.ttlMs);
    emit("acquired", next.holder, pageId);
    next.resolve(state.grant);
  };

  return {
    withWrite(pageId, holder, write, ttlMs = DEFAULT_TTL_MS) {
      const state = stateOf(pageId);
      const grant = new Promise<LeaseGrant>((resolve, reject) => {
        state.queue.push({ holder, resolve, reject, ttlMs });
        // Free page: promote immediately. Held page: the holder's release
        // (or expiry) will promote this waiter.
        if (!state.grant) promote(pageId);
        else emit("queued", holder, pageId);
      });

      return grant.then(async () => {
        try {
          return await write();
        } finally {
          // Release only if still the holder: an expired lease already moved
          // on, and releasing then would evict whoever holds it now.
          if (state.grant?.holder === holder) {
            emit("released", holder, pageId);
            promote(pageId);
          }
        }
      });
    },

    isHeldBy(pageId, holder) {
      const grant = pages.get(pageId)?.grant;
      return grant?.holder === holder && grant.expiresAt > now();
    },

    holderOf(pageId) {
      const grant = pages.get(pageId)?.grant;
      return grant && grant.expiresAt > now() ? grant.holder : null;
    },

    waiting(pageId) {
      return pages.get(pageId)?.queue.length ?? 0;
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      for (const state of pages.values()) {
        if (state.timer) clearTimeout(state.timer);
        for (const waiter of state.queue) waiter.reject(new Error("lease disposed"));
        state.queue.length = 0;
        state.grant = null;
      }
      pages.clear();
      listeners.clear();
    },
  };
}
