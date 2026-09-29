/**
 * The handoff service: the one place that decides who owns a run's browser.
 *
 * The developer's loop (`client.ts`) and the inbox page both talk to it over
 * HTTP; neither holds ownership state of its own. It outlives either of them,
 * which is why a restarted loop or a refreshed inbox finds everything as it was.
 *
 *   POST /api/runs                        attach or re-attach a loop process (holder) to a run
 *   GET  /api/runs/:runId                 current owner, generation, holder (the write gate asks this)
 *   POST /api/runs/:runId/requests        the agent asks for help (gives up the browser)
 *   GET  /api/requests/:id?wait=ms        a request; long-polls while it is still open
 *   POST /api/requests/:id/handback       a person returns the browser (idempotent)
 *   POST /api/requests/:id/observation    the agent's first look afterwards (the receipt)
 *   GET  /api/requests/:id/live           Live View URL, only while that request is open
 *   GET  /api/inbox                       requests for the inbox page
 *   GET  /                                the inbox page
 *
 * Local only. It binds 127.0.0.1, refuses other Host headers (so a web page on
 * another origin cannot reach it through DNS rebinding), and refuses browser
 * POSTs from other origins. Public deployment would need authentication first.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BrowserbaseApi } from "./browserbase.ts";
import type { HelpRequest, Observation, RequestKind, Run } from "./ownership.ts";
import type { Store } from "./store.ts";

const INBOX_HTML = new URL("./inbox.html", import.meta.url);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WAIT_MS = 30_000;

export interface ServiceOptions {
  readonly store: Store;
  /** 0 picks a free port. */
  readonly port?: number;
  /** Absent for local browsers: no expiry watching, no Live View. */
  readonly browserbase?: BrowserbaseApi;
  readonly expiryCheckMs?: number;
  readonly now?: () => number;
}

export interface RunningService {
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

/**
 * Notes are free text typed by a person. Mask what looks like a one-time code or
 * an API key so a careless paste does not end up in the event log.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:bb_live|bb_test|sk-[a-z]*)[-_A-Za-z0-9]{8,}/g, "[redacted key]")
    .replace(/\b\d{6,10}\b/g, "[redacted digits]");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "bad_json", "body must be a JSON object");
}

const str = (body: Record<string, unknown>, field: string, required = true): string | null => {
  const value = body[field];
  if (typeof value === "string" && value.length > 0) return value;
  if (!required && (value === undefined || value === null || value === "")) return null;
  throw new HttpError(400, "bad_field", `${field} must be a non-empty string`);
};
const int = (body: Record<string, unknown>, field: string): number => {
  const value = body[field];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new HttpError(400, "bad_field", `${field} must be an integer`);
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { store } = options;
  const now = options.now ?? Date.now;
  const waiters = new Map<string, Set<() => void>>();
  let port = 0;

  const wake = (requestId: string | null) => {
    if (!requestId) return;
    for (const resolve of waiters.get(requestId) ?? []) resolve();
    waiters.delete(requestId);
  };

  /** Resolve when the request changes, or after `ms`, whichever is first. */
  const waitForChange = (requestId: string, ms: number, abort: AbortSignal) =>
    new Promise<void>((resolve) => {
      const set = waiters.get(requestId) ?? new Set<() => void>();
      waiters.set(requestId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        abort.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      abort.addEventListener("abort", done);
    });

  const requireRequest = (id: string): HelpRequest => {
    const request = store.getRequest(id);
    if (!request) throw new HttpError(404, "not_found", `unknown request ${id}`);
    return request;
  };

  const checkOrigin = (req: IncomingMessage) => {
    const host = req.headers.host ?? "";
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(host)) throw new HttpError(421, "bad_host", "unexpected Host header");
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
      res.end(readFileSync(INBOX_HTML));
      return;
    }
    if (parts[0] !== "api") throw new HttpError(404, "not_found", "no such route");

    // POST /api/runs
    if (method === "POST" && parts.length === 2 && parts[1] === "runs") {
      const body = await readJson(req);
      const { run, pending } = store.attachRun(
        str(body, "runId") as string,
        str(body, "sessionId", false),
        str(body, "holder") as string,
        now(),
      );
      return send(res, 200, { run, pending });
    }

    // GET /api/runs/:runId
    if (method === "GET" && parts.length === 3 && parts[1] === "runs") {
      const run = store.getRun(parts[2] as string);
      if (!run) throw new HttpError(404, "not_found", "unknown run");
      return send(res, 200, { run });
    }

    // POST /api/runs/:runId/requests
    if (method === "POST" && parts.length === 4 && parts[1] === "runs" && parts[3] === "requests") {
      const body = await readJson(req);
      const kind = str(body, "kind") as string;
      if (kind !== "answer" && kind !== "takeover") throw new HttpError(400, "bad_field", "kind must be answer or takeover");
      const raw = body.context as { url?: unknown; title?: unknown } | undefined;
      const context = {
        url: typeof raw?.url === "string" ? raw.url : "",
        title: typeof raw?.title === "string" ? raw.title : "",
      };
      const result = store.openRequest(
        parts[2] as string,
        {
          requestId: randomUUID(),
          key: str(body, "key") as string,
          kind: kind as RequestKind,
          reason: str(body, "reason") as string,
          context,
          generation: int(body, "generation"),
          holder: str(body, "holder") as string,
        },
        now(),
      );
      if (!result.ok) throw new HttpError(409, result.code, result.message);
      return send(res, result.reused ? 200 : 201, result);
    }

    if (parts[1] === "requests" && parts.length >= 3) {
      const requestId = parts[2] as string;

      // GET /api/requests/:id?wait=ms
      if (method === "GET" && parts.length === 3) {
        let request = requireRequest(requestId);
        const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, MAX_WAIT_MS);
        if (request.state === "open" && wait > 0) {
          const abort = new AbortController();
          res.on("close", () => abort.abort());
          await waitForChange(requestId, wait, abort.signal);
          if (abort.signal.aborted && res.destroyed) return;
          request = requireRequest(requestId);
        }
        return send(res, 200, { request, run: store.getRun(request.runId) });
      }

      // POST /api/requests/:id/handback
      if (method === "POST" && parts[3] === "handback") {
        const body = await readJson(req);
        const note = str(body, "note", false);
        const result = store.handBack(
          requestId,
          {
            generation: int(body, "generation"),
            idempotencyKey: str(body, "idempotencyKey") as string,
            note: note === null ? null : redact(note),
          },
          now(),
        );
        if (!result.ok) throw new HttpError(409, result.code, result.message);
        wake(requestId);
        return send(res, 200, result);
      }

      // POST /api/requests/:id/observation
      if (method === "POST" && parts[3] === "observation") {
        const body = await readJson(req);
        const raw = body.observation as Record<string, unknown> | undefined;
        const text = (value: unknown) => (typeof value === "string" ? value : "");
        const observation: Observation = {
          url: text(raw?.url),
          title: text(raw?.title),
          snapshot: text(raw?.snapshot).slice(0, 8_000),
          observedAt: now(),
        };
        const request = store.recordObservation(requestId, observation, now());
        if (!request) throw new HttpError(404, "not_found", "unknown request");
        return send(res, 200, { request });
      }

      // GET /api/requests/:id/live
      if (method === "GET" && parts[3] === "live") {
        const request = requireRequest(requestId);
        const run = store.getRun(request.runId) as Run;
        // The URL is a capability to drive the browser: only hand it out while a
        // person is meant to have the browser.
        if (request.state !== "open" || !run.sessionId || !options.browserbase) return send(res, 200, { url: null });
        return send(res, 200, { url: await options.browserbase.liveViewUrl(run.sessionId) });
      }
    }

    // GET /api/inbox
    if (method === "GET" && parts.length === 2 && parts[1] === "inbox") {
      return send(res, 200, { items: store.inbox(), live: Boolean(options.browserbase) });
    }

    throw new HttpError(404, "not_found", "no such route");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message });
      console.error(`handoff: ${req.method} ${new URL(req.url ?? "/", "http://x").pathname} failed: ${String(error)}`);
      send(res, 500, { error: "internal", message: "internal error" });
    });
  });

  // Expiry: a browser a person holds can time out. When Browserbase says the
  // session ended, stop the run. "unknown" (network trouble) changes nothing.
  let checking = false;
  const expiryTimer = options.browserbase
    ? setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          for (const run of store.runsHeldByHuman()) {
            if (!run.sessionId) continue;
            const liveness = await (options.browserbase as BrowserbaseApi).sessionAlive(run.sessionId);
            if (liveness !== "ended") continue;
            const stopped = store.expireRun(run.runId, "browser session ended", now());
            wake(stopped?.currentRequestId ?? null);
          }
        } finally {
          checking = false;
        }
      }, options.expiryCheckMs ?? 15_000)
    : null;

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("service did not bind a port");
  port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      if (expiryTimer) clearInterval(expiryTimer);
      for (const id of [...waiters.keys()]) wake(id);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
