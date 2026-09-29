/**
 * The two Browserbase calls the handoff service makes itself.
 *
 *   sessionAlive — is the browser a person is holding still there?
 *   liveViewUrl  — the embeddable, clickable view of it, for the inbox card.
 *
 * Plain `fetch` against the documented REST endpoints (GET /v1/sessions/{id} and
 * GET /v1/sessions/{id}/debug), as drop-session did. No retries: these are reads,
 * and the caller polls again on its own schedule.
 *
 * "Could not tell" is its own answer. A network error must not be read as "the
 * session ended" (which would stop the run) or as "still fine" (which would hide a
 * real expiry): the watcher simply looks again next time.
 *
 * The Live View URL grants control of a live browser to whoever holds it. It is
 * fetched on demand, handed only to the inbox page, and never stored or logged.
 */
const API = "https://api.browserbase.com/v1";
const TIMEOUT_MS = 10_000;

export type Liveness = "alive" | "ended" | "unknown";

export interface BrowserbaseApi {
  sessionAlive(sessionId: string): Promise<Liveness>;
  liveViewUrl(sessionId: string): Promise<string | null>;
}

export function browserbaseApi(apiKey: string): BrowserbaseApi {
  const get = (path: string) =>
    fetch(`${API}${path}`, { headers: { "x-bb-api-key": apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) });

  return {
    async sessionAlive(sessionId) {
      try {
        const response = await get(`/sessions/${encodeURIComponent(sessionId)}`);
        if (response.status === 404) return "ended";
        if (!response.ok) return "unknown";
        const session = (await response.json()) as { status?: string; expiresAt?: string };
        // Session statuses: PENDING | RUNNING | ERROR | TIMED_OUT | COMPLETED.
        if (session.status === "ERROR" || session.status === "TIMED_OUT" || session.status === "COMPLETED") {
          return "ended";
        }
        if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return "ended";
        return session.status === "RUNNING" || session.status === "PENDING" ? "alive" : "unknown";
      } catch {
        return "unknown";
      }
    },

    async liveViewUrl(sessionId) {
      try {
        const response = await get(`/sessions/${encodeURIComponent(sessionId)}/debug`);
        if (!response.ok) return null;
        const debug = (await response.json()) as { debuggerFullscreenUrl?: string };
        return debug.debuggerFullscreenUrl ?? null;
      } catch {
        return null;
      }
    },
  };
}
