/**
 * The inbox's HTTP surface.
 *
 *   GET  /                                  the inbox page
 *   GET  /api/state                         runs by bucket, every pause with its context, saved-login stories
 *   GET  /api/runs/:runId/timeline          the run's event log (the receipt)
 *   POST /api/runs                          track a run by id  { runId }
 *   GET  /api/interventions/:id/live        Live View URL and open tabs, only while the pause is open
 *   POST /api/interventions/:id/takeover    record that a person opened the browser
 *   POST /api/interventions/:id/reply       answer or hand back  { key, type, text?, secret?, note? }
 *
 * Local only: binds 127.0.0.1, rejects other Host headers (DNS rebinding) and
 * cross-origin POSTs. The Browserbase API key never reaches the page. Live View
 * URLs control a live browser; they are fetched per request, never stored.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentsApi } from "./api.ts";
import { afterReply, savedLogins } from "./evidence.ts";
import { TERMINAL, type Intervention } from "./intervention.ts";
import { resolvePause, startTakeover, type ReplyInput, type ResolveOutcome } from "./resolve.ts";
import type { StoredRun, Store } from "./store.ts";
import type { Sync } from "./sync.ts";

const PAGE = new URL("./page.html", import.meta.url);
const MAX_BODY_BYTES = 64 * 1024;

/** `unknown`: tracked by id, but Browserbase has not described it (yet, or ever). */
export type Bucket = "needs_attention" | "running" | "completed" | "failed" | "expired" | "unknown";

export interface InboxServerOptions {
  readonly store: Store;
  readonly api: AgentsApi;
  readonly sync: Sync;
  /** True when `api` is not the real Browserbase: every run is labelled SIMULATED. */
  readonly simulated: boolean;
  readonly port?: number;
  readonly now?: () => number;
}

export interface RunningInbox {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const UNRESOLVED = new Set(["open", "resuming", "outcome_unknown"]);

export function bucketOf(run: StoredRun, pauses: readonly Intervention[]): Bucket {
  if (run.status === "PAUSED" || pauses.some((p) => UNRESOLVED.has(p.state))) return "needs_attention";
  if (run.status === null) return "unknown";
  if (run.status === "COMPLETED") return "completed";
  if (run.status === "TIMED_OUT") return "expired";
  if (TERMINAL.has(run.status)) return "failed";
  return "running";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "bad_json", "body must be a JSON object");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function parseReply(body: Record<string, unknown>): ReplyInput {
  const key = body.key;
  if (typeof key !== "string" || key.length < 8) throw new HttpError(400, "bad_field", "key must be an idempotency key");
  if (body.type === "answer") {
    if (typeof body.text !== "string") throw new HttpError(400, "bad_field", "text is required");
    return { key, type: "answer", text: body.text, secret: body.secret === true };
  }
  if (body.type === "takeover") {
    return { key, type: "takeover", note: typeof body.note === "string" ? body.note : null };
  }
  throw new HttpError(400, "bad_field", "type must be answer or takeover");
}

function outcome(res: ServerResponse, result: ResolveOutcome): void {
  if (result.ok) return send(res, 200, result);
  const status = result.code === "not_found" ? 404 : result.code === "bad_input" ? 400 : 409;
  send(res, status, { error: result.code, message: result.message });
}

export async function startInboxServer(options: InboxServerOptions): Promise<RunningInbox> {
  const { store, api, sync } = options;
  const now = options.now ?? Date.now;
  const deps = { store, api, now };
  let port = 0;

  function state() {
    const runs = store.listRuns();
    const pausesByRun = new Map(runs.map((r) => [r.runId, store.interventionsForRun(r.runId)]));
    const byId = new Map(runs.map((r) => [r.runId, r]));
    // Cards waiting for a person first, soonest-expiring browser first; then the rest.
    const expiry = (p: Intervention) => byId.get(p.runId)?.sessionExpiresAt ?? Number.MAX_SAFE_INTEGER;
    const all = store.inbox();
    const ordered = [
      ...all.filter((p) => p.state === "open").sort((a, b) => expiry(a) - expiry(b)),
      ...all.filter((p) => p.state !== "open"),
    ];
    return {
      simulated: options.simulated,
      now: now(),
      runs: runs.map((run) => ({
        runId: run.runId,
        task: run.task,
        status: run.missing ? "NOT FOUND" : (run.status ?? "loading"),
        bucket: bucketOf(run, pausesByRun.get(run.runId) ?? []),
        sessionExpiresAt: run.sessionExpiresAt,
        cause: run.cause,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
      interventions: ordered.map((pause) => {
        const run = byId.get(pause.runId);
        // Evidence: what the agent did just before it paused (the pause call itself excluded).
        const steps = store
          .recentParts(pause.runId, 60)
          .filter((p) => p.createdAt <= pause.pausedAt && p.toolCallId !== pause.pauseCallId)
          .filter((p) => p.kind === "text" || p.kind === "tool-call")
          .slice(-6)
          .map((p) => ({ kind: p.kind, toolName: p.toolName, text: p.text.slice(0, 240), at: p.createdAt }));
        return {
          ...pause,
          // Internal bookkeeping the page does not need.
          attemptKey: undefined,
          task: run?.task ?? "",
          runStatus: run?.status ?? null,
          sessionExpiresAt: run?.sessionExpiresAt ?? null,
          // Agents may finish a task without ever opening a browser (Run 1 used an
          // HTTP strategy): then there is nothing to take over.
          hasBrowser: Boolean(run?.sessionId),
          contextId: run?.contextId ?? null,
          steps,
          // What the agent did once it had the reply; null until the reply is in its transcript.
          after: pause.state === "open" ? null : afterReply(store.recentParts(pause.runId, 200), pause.pauseCallId),
        };
      }),
      savedLogins: savedLogins(runs, (runId) => pausesByRun.get(runId) ?? []),
    };
  }

  const checkOrigin = (req: IncomingMessage) => {
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host ?? "")) throw new HttpError(421, "bad_host", "unexpected Host header");
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin !== undefined && !allowed.some((h) => origin === `http://${h}`)) {
      throw new HttpError(403, "bad_origin", "cross-origin request refused");
    }
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkOrigin(req);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(PAGE));
      return;
    }
    if (parts[0] !== "api") throw new HttpError(404, "not_found", "no such route");

    if (method === "GET" && parts[1] === "state") return send(res, 200, state());

    if (parts[1] === "runs") {
      if (method === "POST" && parts.length === 2) {
        const body = await readJson(req);
        if (typeof body.runId !== "string" || !body.runId) throw new HttpError(400, "bad_field", "runId is required");
        store.trackRun(body.runId, now());
        await sync.syncRun(body.runId).catch(() => {});
        return send(res, 200, { run: store.getRun(body.runId) });
      }
      if (method === "GET" && parts[3] === "timeline" && parts[2]) {
        return send(res, 200, { events: store.events(parts[2]) });
      }
    }

    if (parts[1] === "interventions" && parts[2]) {
      const id = parts[2];
      const pause = store.getIntervention(id);
      if (!pause) throw new HttpError(404, "not_found", `no pause ${id}`);

      if (method === "GET" && parts[3] === "live") {
        // Only while a person is meant to be able to act on this pause.
        const run = store.getRun(pause.runId);
        if (pause.state !== "open" || !run?.sessionId) return send(res, 200, { url: null, pages: [] });
        const live = await api.liveView(run.sessionId);
        return send(res, 200, live ?? { url: null, pages: [] });
      }
      if (method === "POST" && parts[3] === "takeover") return outcome(res, startTakeover(deps, id));
      if (method === "POST" && parts[3] === "reply") {
        const result = await resolvePause(deps, id, parseReply(await readJson(req)));
        // Pick up the run's new state promptly rather than on the next tick.
        void sync.syncRun(pause.runId).catch(() => {});
        return outcome(res, result);
      }
    }

    throw new HttpError(404, "not_found", "no such route");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message });
      console.error(`inbox: ${req.method ?? "?"} request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      send(res, 500, { error: "internal", message: "internal error" });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("inbox did not bind a port");
  port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
