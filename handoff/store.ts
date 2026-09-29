/**
 * Durable state for handoff: runs, help requests, and an append-only event log.
 *
 * Uses `node:sqlite`, built into Node 22.5+, so persistence adds no dependency.
 * Every change runs as read → pure rule from `ownership.ts` → write, inside one
 * `BEGIN IMMEDIATE` transaction. IMMEDIATE takes the write lock up front, so two
 * processes (or two HTTP requests) cannot both read "open" and both hand back:
 * the second waits, then reads the first one's result.
 *
 * The event log is the receipt: what was asked, when control moved, what the
 * person wrote, what the agent saw afterwards.
 */
import { DatabaseSync } from "node:sqlite";
import {
  expire,
  handBack,
  openRequest,
  reattach,
  recordObservation,
  reusableRequest,
  type HandBackCommand,
  type HelpRequest,
  type Observation,
  type OpenInput,
  type Rejection,
  type Run,
} from "./ownership.ts";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT,
    owner TEXT NOT NULL,
    generation INTEGER NOT NULL,
    holder TEXT NOT NULL,
    current_request_id TEXT,
    stopped_reason TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    context TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    handed_back_at INTEGER,
    note TEXT,
    handback_key TEXT,
    observation TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    request_id TEXT,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    detail TEXT
  );
`;

type Row = Record<string, unknown>;

function toRun(row: Row): Run {
  return {
    runId: String(row.run_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    owner: row.owner as Run["owner"],
    generation: Number(row.generation),
    holder: String(row.holder),
    currentRequestId: row.current_request_id === null ? null : String(row.current_request_id),
    stoppedReason: row.stopped_reason === null ? null : String(row.stopped_reason),
    updatedAt: Number(row.updated_at),
  };
}

function toRequest(row: Row): HelpRequest {
  return {
    requestId: String(row.request_id),
    runId: String(row.run_id),
    key: String(row.key),
    kind: row.kind as HelpRequest["kind"],
    reason: String(row.reason),
    context: JSON.parse(String(row.context)) as HelpRequest["context"],
    generation: Number(row.generation),
    state: row.state as HelpRequest["state"],
    createdAt: Number(row.created_at),
    handedBackAt: row.handed_back_at === null ? null : Number(row.handed_back_at),
    note: row.note === null ? null : String(row.note),
    handbackKey: row.handback_key === null ? null : String(row.handback_key),
    observation: row.observation === null ? null : (JSON.parse(String(row.observation)) as Observation),
  };
}

export interface HandoffEvent {
  readonly runId: string;
  readonly requestId: string | null;
  readonly type: string;
  readonly at: number;
  readonly detail: unknown;
}

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const selectRun = db.prepare("SELECT * FROM runs WHERE run_id = ?");
  const selectRequest = db.prepare("SELECT * FROM requests WHERE request_id = ?");
  const insertRun = db.prepare(
    "INSERT INTO runs (run_id, session_id, owner, generation, holder, current_request_id, stopped_reason, updated_at) VALUES (?, ?, 'agent', 1, ?, NULL, NULL, ?)",
  );
  const updateRun = db.prepare(
    "UPDATE runs SET owner = ?, generation = ?, holder = ?, current_request_id = ?, stopped_reason = ?, updated_at = ? WHERE run_id = ?",
  );
  const upsertRequest = db.prepare(`
    INSERT INTO requests (request_id, run_id, key, kind, reason, context, generation, state, created_at,
                          handed_back_at, note, handback_key, observation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (request_id) DO UPDATE SET state = excluded.state, handed_back_at = excluded.handed_back_at,
      note = excluded.note, handback_key = excluded.handback_key, observation = excluded.observation`);
  const insertEvent = db.prepare("INSERT INTO events (run_id, request_id, type, at, detail) VALUES (?, ?, ?, ?, ?)");

  const tx = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const getRun = (runId: string): Run | null => {
    const row = selectRun.get(runId) as Row | undefined;
    return row ? toRun(row) : null;
  };
  const getRequest = (requestId: string): HelpRequest | null => {
    const row = selectRequest.get(requestId) as Row | undefined;
    return row ? toRequest(row) : null;
  };
  const currentRequest = (run: Run): HelpRequest | null =>
    run.currentRequestId ? getRequest(run.currentRequestId) : null;

  const saveRun = (run: Run) =>
    updateRun.run(run.owner, run.generation, run.holder, run.currentRequestId, run.stoppedReason, run.updatedAt, run.runId);
  const saveRequest = (r: HelpRequest) =>
    upsertRequest.run(
      r.requestId,
      r.runId,
      r.key,
      r.kind,
      r.reason,
      JSON.stringify(r.context),
      r.generation,
      r.state,
      r.createdAt,
      r.handedBackAt,
      r.note,
      r.handbackKey,
      r.observation ? JSON.stringify(r.observation) : null,
    );
  const log = (runId: string, requestId: string | null, type: string, at: number, detail?: unknown) =>
    insertEvent.run(runId, requestId, type, at, detail === undefined ? null : JSON.stringify(detail));

  return {
    getRun,
    getRequest,

    /** Register a run, or re-attach to it as `holder`. Re-attaching fences out earlier loop processes. */
    attachRun(runId: string, sessionId: string | null, holder: string, now: number): { run: Run; pending: HelpRequest | null } {
      return tx(() => {
        const existing = getRun(runId);
        if (!existing) {
          insertRun.run(runId, sessionId, holder, now);
          log(runId, null, "run.attached", now, { generation: 1 });
          return { run: getRun(runId) as Run, pending: null };
        }
        const run = reattach(existing, holder, now);
        if (run !== existing) saveRun(run);
        log(runId, null, "run.reattached", now, { owner: run.owner, generation: run.generation });
        const current = currentRequest(run);
        const pending = current && reusableRequest(current, current.key) ? current : null;
        return { run, pending };
      });
    },

    /** Open a request, or re-join the current one when a restarted loop asks the same question. */
    openRequest(
      runId: string,
      input: OpenInput,
      now: number,
    ): { ok: true; run: Run; request: HelpRequest; reused: boolean } | Rejection {
      return tx(() => {
        const run = getRun(runId);
        if (!run) return { ok: false, code: "stale", message: `unknown run ${runId}` } as const;
        const reusable = reusableRequest(currentRequest(run), input.key);
        if (reusable && run.holder !== input.holder) {
          return { ok: false, code: "superseded", message: "another loop process has attached to this run" } as const;
        }
        if (reusable) {
          log(runId, reusable.requestId, "request.rejoined", now);
          return { ok: true, run, request: reusable, reused: true } as const;
        }
        const result = openRequest(run, input, now);
        if (!result.ok) return result;
        saveRun(result.run);
        saveRequest(result.request);
        log(runId, result.request.requestId, "request.opened", now, {
          kind: result.request.kind,
          reason: result.request.reason,
          generation: result.request.generation,
        });
        return { ...result, reused: false };
      });
    },

    handBack(
      requestId: string,
      command: HandBackCommand,
      now: number,
    ): { ok: true; run: Run; request: HelpRequest; replay: boolean } | Rejection {
      return tx(() => {
        const request = getRequest(requestId);
        const run = request ? getRun(request.runId) : null;
        if (!request || !run) return { ok: false, code: "stale", message: `unknown request ${requestId}` } as const;
        const result = handBack(run, request, command, now);
        if (!result.ok) {
          log(run.runId, requestId, "handback.rejected", now, { code: result.code });
          return result;
        }
        if (!result.replay) {
          saveRun(result.run);
          saveRequest(result.request);
          log(run.runId, requestId, "request.handed_back", now, { generation: result.run.generation });
        }
        return result;
      });
    },

    /** The session ended. Stops the run; an open request becomes expired. */
    expireRun(runId: string, reason: string, now: number): Run | null {
      return tx(() => {
        const run = getRun(runId);
        if (!run || run.owner === "stopped") return run;
        const result = expire(run, currentRequest(run), reason, now);
        saveRun(result.run);
        if (result.request) saveRequest(result.request);
        log(runId, run.currentRequestId, "run.stopped", now, { reason });
        return result.run;
      });
    },

    recordObservation(requestId: string, observation: Observation, now: number): HelpRequest | null {
      return tx(() => {
        const request = getRequest(requestId);
        if (!request) return null;
        const updated = recordObservation(request, observation);
        if (!updated) return request;
        saveRequest(updated);
        log(request.runId, requestId, "agent.observed", now, { url: observation.url, title: observation.title });
        return updated;
      });
    },

    /** Open requests first, then the most recent others, for the inbox. */
    inbox(limit = 20): Array<{ run: Run; request: HelpRequest }> {
      const rows = db
        .prepare(
          "SELECT * FROM requests ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ?",
        )
        .all(limit) as Row[];
      return rows.map((row) => {
        const request = toRequest(row);
        return { request, run: getRun(request.runId) as Run };
      });
    },

    /** Runs a person currently holds: the ones whose session expiry matters. */
    runsHeldByHuman(): Run[] {
      return (db.prepare("SELECT * FROM runs WHERE owner = 'human'").all() as Row[]).map(toRun);
    },

    events(runId: string): HandoffEvent[] {
      return (db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map((row) => ({
        runId: String(row.run_id),
        requestId: row.request_id === null ? null : String(row.request_id),
        type: String(row.type),
        at: Number(row.at),
        detail: row.detail === null ? null : JSON.parse(String(row.detail)),
      }));
    },

    close(): void {
      db.close();
    },
  };
}
