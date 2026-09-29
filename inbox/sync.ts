/**
 * The poller: keeps the inbox in line with Browserbase.
 *
 * Browserbase Agents has no webhooks yet ("Integration is poll-based today"), so
 * each tick:
 *   1. discovers recent runs in the project (optional: `GET /v1/agents/runs`)
 *   2. for every run that is not finished, or still has an unresolved pause:
 *      reads the run, its new messages, and its session
 *   3. turns a new unanswered `pause` tool call into an open intervention
 *   4. reconciles every unresolved intervention with what the run shows now
 *
 * Two rules keep stale reads from doing damage:
 *   - Syncs of the same run never overlap: a second request waits for the first
 *     and then reads afresh. (Otherwise an older read can finish last and write
 *     an older picture of the run over a newer one.)
 *   - Every judgement is dated by when its reads *started* (`observedAt`), and
 *     evidence older than the card or the reply it would judge is ignored.
 */
import type { AgentsApi } from "./api.ts";
import { newIntervention, reconcile, recoverAfterRestart, TERMINAL } from "./intervention.ts";
import { redact } from "./redact.ts";
import type { Store } from "./store.ts";

const ENDED_SESSION = new Set(["TIMED_OUT", "COMPLETED", "ERROR", "GONE"]);
const UNRESOLVED = new Set(["open", "outcome_unknown"]);

export interface SyncOptions {
  readonly store: Store;
  readonly api: AgentsApi;
  /** Discover recent runs across the project, not only runs added by id. */
  readonly discover?: boolean;
  /** How long an uncertain resume may still show the same pause before the card reopens. */
  readonly graceMs?: number;
  readonly now?: () => number;
  /** Called after anything changed, so the page can refresh. */
  readonly onChange?: () => void;
}

export interface Sync {
  /** Mark replies that were in flight when the process stopped as uncertain. */
  recover(): void;
  syncRun(runId: string): Promise<void>;
  tick(): Promise<void>;
  /** Read the session of each run whose Context is not recorded (finished before this was tracked). Reads only. */
  backfillContexts(): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

/** The pause request text from a stored tool-call payload (`{"message": ...}`). */
function pauseMessage(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Truncated or not JSON: show it as it is.
  }
  return payload;
}

/**
 * A tool result's text. Stored payloads are JSON (`{"type":"text","value":...}`
 * in the AI SDK shape, or a bare string); collect every string inside so quotes
 * and newlines compare unescaped.
 */
function resultText(stored: string | null): string | null {
  if (stored === null) return null;
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(stored));
    return strings.join("\n");
  } catch {
    return stored;
  }
}

export function createSync(options: SyncOptions): Sync {
  const { store, api } = options;
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? 15_000;
  const inFlight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function readAndReconcile(runId: string): Promise<void> {
    const observedAt = now();
    const before = store.getRun(runId);
    const run = await api.getRun(runId);
    if (!run) {
      store.markMissing(runId, now());
      return;
    }

    let cursor = before?.messageCursor ?? null;
    const { messages, nextSince } = await api.listMessages(runId, cursor);
    if (messages.length > 0) {
      store.appendMessages(runId, messages, redact);
      cursor = nextSince ?? cursor;
    }
    const waitingOn = store.unansweredPause(runId);

    let sessionStatus = before?.sessionStatus ?? null;
    let sessionExpiresAt = before?.sessionExpiresAt ?? null;
    let contextId = before?.contextId ?? null;
    // Read the session while the run goes on, and once more for a run whose session
    // was never read (it finished between polls): that read is where its Context shows.
    if (run.sessionId && (!TERMINAL.has(run.status) || sessionStatus === null)) {
      const session = await api.getSession(run.sessionId);
      if (session) {
        sessionStatus = session.status;
        sessionExpiresAt = session.expiresAt;
        contextId = session.contextId ?? contextId;
      }
    }
    store.saveRunState(run, { sessionStatus, sessionExpiresAt, contextId, pausedOn: waitingOn?.callId ?? null, cursor }, now());

    const sessionEnded =
      (sessionStatus !== null && ENDED_SESSION.has(sessionStatus)) ||
      (sessionExpiresAt !== null && sessionExpiresAt <= observedAt);
    const pausedOn = run.status === "PAUSED" ? (waitingOn?.callId ?? null) : null;
    let changed = before?.status !== run.status;

    store.tx(() => {
      if (pausedOn && waitingOn && !store.getIntervention(`${runId}:${pausedOn}`)) {
        const created = newIntervention({
          runId,
          pauseCallId: pausedOn,
          message: pauseMessage(waitingOn.payload),
          pausedAt: waitingOn.createdAt || observedAt,
          // Dated by this read, so only reads that started after it can judge it.
          detectedAt: observedAt,
        });
        store.saveIntervention(created);
        store.log(runId, created.id, "pause.detected", now(), { message: created.message });
        changed = true;
      }
      for (const current of store.interventionsForRun(runId)) {
        if (!UNRESOLVED.has(current.state)) continue;
        const next = reconcile(
          current,
          { status: run.status, pausedOn, pauseResult: resultText(store.pauseResult(runId, current.pauseCallId)), sessionEnded },
          observedAt,
          graceMs,
        );
        if (next !== current) {
          store.saveIntervention(next);
          store.log(runId, next.id, `intervention.${next.state}`, now(), { detail: next.detail, receipt: next.receipt });
          changed = true;
        }
      }
    });
    if (changed) options.onChange?.();
  }

  /** One sync per run at a time; a request made during one runs after it, afresh. */
  function syncRun(runId: string): Promise<void> {
    const previous = inFlight.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => readAndReconcile(runId));
    const settled = next.finally(() => {
      if (inFlight.get(runId) === settled) inFlight.delete(runId);
    });
    inFlight.set(runId, settled);
    return next;
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      if (options.discover) {
        try {
          // Recent runs of every status, so the overview also shows runs that never
          // needed a person. Finished runs are read once, then skipped below.
          for (const run of await api.listRuns()) store.trackRun(run.runId, now());
        } catch (error) {
          console.error(`inbox: could not list runs: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      for (const run of store.listRuns()) {
        if (run.missing) continue;
        const unresolved = store.interventionsForRun(run.runId).some((i) => UNRESOLVED.has(i.state));
        if (run.status !== null && TERMINAL.has(run.status) && !unresolved) continue;
        try {
          await syncRun(run.runId);
        } catch (error) {
          // A failed read changes nothing; the next tick tries again.
          console.error(`inbox: could not sync run ${run.runId}: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    } finally {
      ticking = false;
    }
  }

  return {
    recover() {
      store.tx(() => {
        for (const current of store.interventionsIn(["resuming"])) {
          const next = recoverAfterRestart(current);
          store.saveIntervention(next);
          store.log(next.runId, next.id, "intervention.outcome_unknown", now(), { detail: next.detail });
        }
      });
    },
    syncRun,
    tick,
    async backfillContexts() {
      for (const run of store.listRuns()) {
        if (run.missing || !run.sessionId || run.contextId) continue;
        const session = await api.getSession(run.sessionId).catch(() => null);
        if (session?.contextId) {
          store.setContextId(run.runId, session.contextId);
          options.onChange?.();
        }
      }
    },
    start(intervalMs) {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
