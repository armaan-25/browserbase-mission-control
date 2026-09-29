/**
 * Browserbase Agents and Sessions over REST.
 *
 * Endpoints (docs.browserbase.com/reference/api, checked 2026-09-27):
 *   POST /v1/contexts                        create a Context (a saved browser profile)
 *   POST /v1/agents/runs                     run an agent (task, pauseWhen, browserSettings.context)
 *   GET  /v1/agents/runs?status=             list runs
 *   GET  /v1/agents/runs/{id}                get a run
 *   GET  /v1/agents/runs/{id}/messages       list messages (since, all)
 *   POST /v1/agents/runs/{id}/resume         resume a paused run (task, variables)
 *   GET  /v1/sessions/{id}                   session status and expiresAt
 *   GET  /v1/sessions/{id}/debug             Live View URLs and open tabs
 *
 * Why not `@browserbasehq/sdk`: its 2.21.0 release has no `resume` method, and
 * its client retries 409 and 5xx responses by default, including on POST. For
 * resume that would resend a reply whose first delivery may have worked, which
 * is the one thing this inbox must never do. So: plain fetch, no retries.
 *
 * Responses are parsed into known shapes here, at the edge.
 */
import { RUN_STATUSES, type ResumeResult, type RunStatus } from "./intervention.ts";

export const BROWSERBASE_API = "https://api.browserbase.com";

export interface AgentRun {
  readonly runId: string;
  readonly task: string;
  readonly status: RunStatus;
  readonly sessionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cause: string | null;
}

/** One message part, reduced to what the inbox shows or reasons about. */
export interface MessagePart {
  readonly type: string;
  readonly text: string | null;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  /** Tool-call input or tool-result output, as JSON text. */
  readonly payload: string | null;
}

export interface RunMessage {
  readonly id: string;
  readonly createdAt: number;
  readonly role: string;
  readonly parts: readonly MessagePart[];
}

export interface SessionState {
  readonly status: string;
  readonly expiresAt: number | null;
  /** The Context this session's browser loaded, if any (confirmed on live sessions, 2026-09-29). */
  readonly contextId: string | null;
}

export interface LiveView {
  readonly url: string;
  readonly pages: ReadonlyArray<{ readonly url: string; readonly title: string }>;
}

export interface AgentsApi {
  readonly baseUrl: string;
  /** A Context keeps cookies and storage between sessions. `name` must be unique among the project's active Contexts. */
  createContext(name?: string): Promise<{ id: string }>;
  /** With `context.persist`, what happens in the run's browser (a person signing in) is saved for later runs. */
  createRun(input: { task: string; pauseWhen?: string; context?: { id: string; persist: boolean } }): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun | null>;
  listRuns(status?: RunStatus): Promise<AgentRun[]>;
  listMessages(runId: string, since: string | null): Promise<{ messages: RunMessage[]; nextSince: string | null }>;
  resume(runId: string, body: { task: string; variables?: Record<string, { value: string; description?: string }> }): Promise<ResumeResult>;
  getSession(sessionId: string): Promise<SessionState | null>;
  liveView(sessionId: string): Promise<LiveView | null>;
}

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const time = (value: unknown): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};

function parseRun(value: unknown): AgentRun {
  if (!isRecord(value) || typeof value.runId !== "string") throw new Error("unexpected run shape");
  const status = value.status;
  if (typeof status !== "string" || !RUN_STATUSES.includes(status as RunStatus)) {
    throw new Error(`unexpected run status ${String(status)}`);
  }
  const cause = isRecord(value.cause) ? [text(value.cause.code), text(value.cause.message)].filter(Boolean).join(": ") : null;
  return {
    runId: value.runId,
    task: text(value.task) ?? "",
    status: status as RunStatus,
    sessionId: text(value.sessionId),
    createdAt: time(value.createdAt),
    updatedAt: time(value.updatedAt),
    cause: cause || null,
  };
}

function parsePart(value: unknown): MessagePart | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const payload = value.input ?? value.output;
  return {
    type: value.type,
    text: text(value.text),
    toolName: text(value.toolName),
    toolCallId: text(value.toolCallId),
    payload: payload === undefined ? null : typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

function parseMessage(value: unknown): RunMessage | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.message)) return null;
  const { role, content } = value.message;
  const parts =
    typeof content === "string"
      ? [{ type: "text", text: content, toolName: null, toolCallId: null, payload: null }]
      : Array.isArray(content)
        ? content.map(parsePart).filter((p): p is MessagePart => p !== null)
        : [];
  return { id: value.id, createdAt: time(value.createdAt), role: text(role) ?? "assistant", parts };
}

export function agentsApi(options: { apiKey: string; baseUrl?: string; resumeTimeoutMs?: number }): AgentsApi {
  const baseUrl = (options.baseUrl ?? BROWSERBASE_API).replace(/\/$/, "");
  const headers = { "x-bb-api-key": options.apiKey, "content-type": "application/json" };

  async function request(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) throw new ApiError(response.status, raw.slice(0, 300));
    return raw ? (JSON.parse(raw) as unknown) : null;
  }

  return {
    baseUrl,

    async createContext(name) {
      const body = await request("POST", "/v1/contexts", name ? { name } : {});
      if (!isRecord(body) || typeof body.id !== "string") throw new Error("unexpected context shape");
      return { id: body.id };
    },

    async createRun({ context, ...rest }) {
      const body = context ? { ...rest, browserSettings: { context } } : rest;
      return parseRun(await request("POST", "/v1/agents/runs", body));
    },

    async getRun(runId) {
      try {
        return parseRun(await request("GET", `/v1/agents/runs/${encodeURIComponent(runId)}`));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },

    async listRuns(status) {
      const query = status ? `?status=${status}&limit=100` : "?limit=100";
      const body = await request("GET", `/v1/agents/runs${query}`);
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      return data.map(parseRun);
    },

    async listMessages(runId, since) {
      const query = new URLSearchParams({ all: "true" });
      if (since) query.set("since", since);
      const body = await request("GET", `/v1/agents/runs/${encodeURIComponent(runId)}/messages?${query}`);
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      return {
        messages: data.map(parseMessage).filter((m): m is RunMessage => m !== null),
        nextSince: isRecord(body) ? text(body.nextSince) : null,
      };
    },

    async resume(runId, body) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/v1/agents/runs/${encodeURIComponent(runId)}/resume`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.resumeTimeoutMs ?? 20_000),
        });
      } catch (error) {
        // The request may have reached Browserbase before the connection failed.
        return { kind: "unknown", detail: `no response to the resume (${String(error)})` };
      }
      // Response bodies are never kept: an error that echoed the request would
      // carry a secret reply from `variables` into our records.
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status === 202 || status === 200) return { kind: "accepted" };
      if (status === 409) return { kind: "conflict", detail: "409: the run was not waiting on this request, or another reply got there first" };
      if (status === 404) return { kind: "run_missing" };
      if (status === 503) return { kind: "not_applied", detail: "run control temporarily unavailable (503)" };
      if (status >= 500) return { kind: "unknown", detail: `${status}: Browserbase could not say whether the reply was delivered` };
      // 400/401/403/422: rejected before it could act on the run.
      return { kind: "not_applied", detail: `Browserbase rejected the reply (${status})` };
    },

    async getSession(sessionId) {
      try {
        const body = await request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
        if (!isRecord(body)) return null;
        const expires = time(body.expiresAt);
        return { status: text(body.status) ?? "UNKNOWN", expiresAt: expires || null, contextId: text(body.contextId) };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { status: "GONE", expiresAt: null, contextId: null };
        return null;
      }
    },

    async liveView(sessionId) {
      try {
        const body = await request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/debug`);
        if (!isRecord(body)) return null;
        const pages = Array.isArray(body.pages)
          ? body.pages.filter(isRecord).map((p) => ({ url: text(p.url) ?? "", title: text(p.title) ?? "" }))
          : [];
        const url = text(body.debuggerFullscreenUrl);
        return url ? { url, pages } : null;
      } catch {
        return null;
      }
    },
  };
}
