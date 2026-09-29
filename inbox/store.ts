/**
 * Durable inbox state in `node:sqlite`.
 *
 *   runs           a mirror of what Browserbase last said about each run. Written
 *                  only by the poller; never edited to reflect what we hope.
 *   messages       a compact, redacted copy of each run's transcript: evidence
 *                  for the card, and where a pause's result is looked up.
 *   interventions  one row per pause: our state machine (`intervention.ts`).
 *   events         append-only log: the timeline and the receipt.
 *
 * `tx` runs a function inside BEGIN IMMEDIATE, which takes the write lock up
 * front. Two replies to the same pause both read, but only one reads "open".
 */
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, RunMessage } from "./api.ts";
import type { Intervention, RunStatus } from "./intervention.ts";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    status TEXT,
    missing INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    session_status TEXT,
    session_expires_at INTEGER,
    context_id TEXT,
    cause TEXT,
    message_cursor TEXT,
    paused_on TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    run_id TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    tool_name TEXT,
    tool_call_id TEXT,
    text TEXT NOT NULL,
    PRIMARY KEY (run_id, id, seq)
  );
  CREATE TABLE IF NOT EXISTS interventions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    paused_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    intervention_id TEXT,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    detail TEXT
  );
`;

export interface StoredRun {
  readonly runId: string;
  readonly task: string;
  /** Null until Browserbase has described the run: never guessed. */
  readonly status: RunStatus | null;
  /** Browserbase answered 404 for this id. */
  readonly missing: boolean;
  readonly sessionId: string | null;
  readonly sessionStatus: string | null;
  readonly sessionExpiresAt: number | null;
  /** The Context the run's browser session loaded (from the session record). */
  readonly contextId: string | null;
  readonly cause: string | null;
  readonly messageCursor: string | null;
  /** toolCallId of the trailing pause call, while the run is paused on one. */
  readonly pausedOn: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly syncedAt: number;
}

/** A message part as stored: already redacted and truncated. */
export interface StoredPart {
  readonly messageId: string;
  readonly createdAt: number;
  readonly role: string;
  readonly kind: string;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly text: string;
}

export interface InboxEvent {
  readonly runId: string;
  readonly interventionId: string | null;
  readonly type: string;
  readonly at: number;
  readonly detail: unknown;
}

type Row = Record<string, unknown>;
const nullable = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toRun(row: Row): StoredRun {
  return {
    runId: String(row.run_id),
    task: String(row.task),
    status: row.status === null ? null : (row.status as RunStatus),
    missing: Number(row.missing) === 1,
    sessionId: nullable(row.session_id),
    sessionStatus: nullable(row.session_status),
    sessionExpiresAt: nullableNumber(row.session_expires_at),
    contextId: nullable(row.context_id),
    cause: nullable(row.cause),
    messageCursor: nullable(row.message_cursor),
    pausedOn: nullable(row.paused_on),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    syncedAt: Number(row.synced_at),
  };
}

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Databases created before `context_id` existed get the column added once.
  const columns = (db.prepare("PRAGMA table_info(runs)").all() as Row[]).map((c) => String(c.name));
  if (!columns.includes("context_id")) db.exec("ALTER TABLE runs ADD COLUMN context_id TEXT");

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

  const log = (runId: string, interventionId: string | null, type: string, at: number, detail?: unknown) => {
    db.prepare("INSERT INTO events (run_id, intervention_id, type, at, detail) VALUES (?, ?, ?, ?, ?)").run(
      runId,
      interventionId,
      type,
      at,
      detail === undefined ? null : JSON.stringify(detail),
    );
  };

  const getRun = (runId: string): StoredRun | null => {
    const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? toRun(row) : null;
  };

  const getIntervention = (id: string): Intervention | null => {
    const row = db.prepare("SELECT body FROM interventions WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(String(row.body)) as Intervention) : null;
  };

  return {
    tx,
    log,
    getRun,
    getIntervention,

    /** Start tracking a run we know only by id (discovered or added by hand). */
    trackRun(runId: string, now: number): void {
      db.prepare(
        "INSERT OR IGNORE INTO runs (run_id, task, status, created_at, updated_at, synced_at) VALUES (?, '', NULL, ?, ?, 0)",
      ).run(runId, now, now);
    },

    /** Record what Browserbase says about a run. Returns the previous status. */
    saveRunState(
      run: AgentRun,
      extra: { sessionStatus: string | null; sessionExpiresAt: number | null; contextId: string | null; pausedOn: string | null; cursor: string | null },
      now: number,
    ): RunStatus | null {
      const before = getRun(run.runId);
      db.prepare(
        `INSERT INTO runs (run_id, task, status, session_id, session_status, session_expires_at, context_id, cause, message_cursor,
                           paused_on, created_at, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET task = excluded.task, status = excluded.status,
           session_id = excluded.session_id, session_status = excluded.session_status,
           session_expires_at = excluded.session_expires_at, context_id = excluded.context_id, cause = excluded.cause,
           message_cursor = excluded.message_cursor, paused_on = excluded.paused_on,
           updated_at = excluded.updated_at, synced_at = excluded.synced_at, missing = 0`,
      ).run(
        run.runId,
        run.task,
        run.status,
        run.sessionId,
        extra.sessionStatus,
        extra.sessionExpiresAt,
        extra.contextId,
        run.cause,
        extra.cursor,
        extra.pausedOn,
        run.createdAt || now,
        run.updatedAt || now,
        now,
      );
      if (before?.status !== run.status) log(run.runId, null, "run.status", now, { from: before?.status ?? null, to: run.status });
      return before?.status ?? null;
    },

    /** Record the Context a finished run's session used, learned after the fact. */
    setContextId(runId: string, contextId: string): void {
      db.prepare("UPDATE runs SET context_id = ? WHERE run_id = ?").run(contextId, runId);
    },

    /** Browserbase has no run with this id (mistyped, deleted, other project). */
    markMissing(runId: string, now: number): void {
      const before = getRun(runId);
      db.prepare("UPDATE runs SET missing = 1, synced_at = ? WHERE run_id = ?").run(now, runId);
      if (before && !before.missing) log(runId, null, "run.missing", now);
    },

    listRuns(): StoredRun[] {
      return (db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Row[]).map(toRun);
    },

    appendMessages(runId: string, messages: readonly RunMessage[], redact: (s: string) => string): void {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO messages (run_id, id, seq, created_at, role, kind, tool_name, tool_call_id, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const message of messages) {
        message.parts.forEach((part, seq) => {
          const body = part.text ?? part.payload ?? "";
          // A pause's result is our own reply, and the receipt compares against it
          // in full; everything else is evidence for the card and is truncated.
          const limit = part.type === "tool-result" && part.toolName === "pause" ? 65_536 : 2_000;
          insert.run(runId, message.id, seq, message.createdAt, message.role, part.type, part.toolName, part.toolCallId, redact(body).slice(0, limit));
        });
      }
    },

    /** The last `limit` message parts of a run, oldest first. */
    recentParts(runId: string, limit: number): StoredPart[] {
      const rows = db
        .prepare("SELECT * FROM messages WHERE run_id = ? ORDER BY created_at DESC, id DESC, seq DESC LIMIT ?")
        .all(runId, limit) as Row[];
      return rows.reverse().map((row) => ({
        messageId: String(row.id),
        createdAt: Number(row.created_at),
        role: String(row.role),
        kind: String(row.kind),
        toolName: nullable(row.tool_name),
        toolCallId: nullable(row.tool_call_id),
        text: String(row.text),
      }));
    },

    /**
     * The newest `pause` tool call that has no result yet: what the run is waiting
     * on while it is PAUSED. Does not assume it is the very last message.
     */
    unansweredPause(runId: string): { callId: string; payload: string; createdAt: number } | null {
      const row = db
        .prepare(
          `SELECT tool_call_id, text, created_at FROM messages m
           WHERE run_id = ? AND kind = 'tool-call' AND tool_name = 'pause' AND tool_call_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.run_id = m.run_id AND r.kind = 'tool-result' AND r.tool_call_id = m.tool_call_id)
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(runId) as Row | undefined;
      return row ? { callId: String(row.tool_call_id), payload: String(row.text), createdAt: Number(row.created_at) } : null;
    },

    /** The recorded result of a pause call, if the transcript has one. */
    pauseResult(runId: string, pauseCallId: string): string | null {
      const row = db
        .prepare("SELECT text FROM messages WHERE run_id = ? AND kind = 'tool-result' AND tool_call_id = ? LIMIT 1")
        .get(runId, pauseCallId) as Row | undefined;
      return row ? String(row.text) : null;
    },

    saveIntervention(i: Intervention): void {
      db.prepare(
        `INSERT INTO interventions (id, run_id, body, state, paused_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET body = excluded.body, state = excluded.state`,
      ).run(i.id, i.runId, JSON.stringify(i), i.state, i.pausedAt);
    },

    interventionsForRun(runId: string): Intervention[] {
      return (db.prepare("SELECT body FROM interventions WHERE run_id = ? ORDER BY paused_at").all(runId) as Row[]).map(
        (row) => JSON.parse(String(row.body)) as Intervention,
      );
    },

    interventionsIn(states: readonly string[]): Intervention[] {
      const marks = states.map(() => "?").join(", ");
      return (db.prepare(`SELECT body FROM interventions WHERE state IN (${marks}) ORDER BY paused_at`).all(...states) as Row[]).map(
        (row) => JSON.parse(String(row.body)) as Intervention,
      );
    },

    /** Unresolved first, then the most recent others. */
    inbox(limit = 50): Intervention[] {
      return (
        db
          .prepare(
            `SELECT body FROM interventions
             ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'outcome_unknown' THEN 1 WHEN 'resuming' THEN 2 ELSE 3 END, paused_at DESC
             LIMIT ?`,
          )
          .all(limit) as Row[]
      ).map((row) => JSON.parse(String(row.body)) as Intervention);
    },

    events(runId: string): InboxEvent[] {
      return (db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map((row) => ({
        runId: String(row.run_id),
        interventionId: nullable(row.intervention_id),
        type: String(row.type),
        at: Number(row.at),
        detail: row.detail === null ? null : (JSON.parse(String(row.detail)) as unknown),
      }));
    },

    close(): void {
      db.close();
    },
  };
}
