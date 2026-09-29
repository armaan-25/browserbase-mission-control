/**
 * SIMULATED Browserbase Agents API, for tests and the demo. Not Browserbase.
 *
 * Implements the endpoints `api.ts` calls, in the documented shapes, with runs
 * that follow a scripted list of steps instead of an LLM. Anything the docs do
 * not specify is a guess and is marked GUESS below; the live tests in Part 2 are
 * what settle those.
 *
 * It exists so the inbox's hard cases can be produced on demand, deterministically
 * and for free: a resume whose response is lost after it took effect, a 500 that
 * did nothing, a 409 race, a session expiring while paused.
 *
 * Contexts are modelled as a set of sites a browser is signed in to. A session
 * started with a Context loads its sign-ins; with `persist`, the session's
 * sign-ins are written back when the session ends (documented: "persist the
 * context after browsing"). Real Contexts hold a whole user-data directory.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Step =
  | { readonly say: string }
  | { readonly tool: string; readonly input?: Record<string, unknown>; readonly page?: FakePage }
  /** With `onlyIfChallenged`, skipped when the current page has no challenge (the site already let the agent in). */
  | { readonly pause: string; readonly onlyIfChallenged?: boolean }
  | { readonly complete: string };

export interface FakePage {
  readonly url: string;
  readonly title: string;
  /** A step a person has to do in the browser (shown as a button on the live page). */
  readonly challenge?: {
    readonly label: string;
    readonly then: { readonly url: string; readonly title: string };
    /** Completing it signs the browser in to this site; a browser already signed in skips straight to `then`. */
    readonly signsIn?: string;
  };
}

/** How the next resume call misbehaves. */
export type ResumeFault =
  /** Resumes the run, then answers 500 "Resume outcome is unknown". */
  | "unknown_applied"
  /** Does nothing, answers 500 "Resume outcome is unknown". */
  | "unknown_not_applied"
  /** Resumes the run, then never answers (the client times out). */
  | "hang_applied"
  /** Does nothing, answers 503. */
  | "unavailable";

type Status = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "STOPPED" | "TIMED_OUT";

interface Message {
  id: string;
  createdAt: string;
  message: { role: "assistant" | "tool"; content: unknown[] };
}

interface FakeRun {
  runId: string;
  task: string;
  pauseWhen: string | null;
  status: Status;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  steps: readonly Step[];
  pc: number;
  messages: Message[];
  pendingPause: string | null;
  resumeCalls: number;
  receivedVariables: string[];
}

interface FakeSession {
  id: string;
  status: "RUNNING" | "COMPLETED" | "TIMED_OUT";
  expiresAt: number;
  page: FakePage;
  /** Sites this browser is signed in to (its cookie jar). */
  signedIn: Set<string>;
  context: { id: string; persist: boolean } | null;
}

export interface FakeBrowserbase {
  readonly url: string;
  /** Start a run with a script. What `POST /v1/agents/runs` does, with a chosen script. */
  startRun(input: RunInput): string;
  /** Script for the next run created over HTTP (default: say one line, then complete). */
  nextScript(steps: readonly Step[], sessionTtlMs?: number): void;
  injectResumeFault(fault: ResumeFault): void;
  resumeCalls(runId: string): number;
  /** Names of secret variables delivered to a run (values are not kept). */
  receivedVariables(runId: string): readonly string[];
  /** Someone resumes the run without the inbox (another script, the API directly). */
  resumeElsewhere(runId: string, task: string): void;
  /** End a run's browser session now. */
  expireSession(runId: string): void;
  close(): Promise<void>;
}

interface RunInput {
  task: string;
  pauseWhen?: string;
  steps: readonly Step[];
  sessionTtlMs?: number;
  context?: { id: string; persist: boolean };
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export async function startFakeBrowserbase(options: { port?: number; stepMs?: number; sessionTtlMs?: number } = {}): Promise<FakeBrowserbase> {
  const stepMs = options.stepMs ?? 400;
  const defaultTtl = options.sessionTtlMs ?? 60 * 60_000;
  const runs = new Map<string, FakeRun>();
  const sessions = new Map<string, FakeSession>();
  /** Context id → sites it is signed in to. */
  const contexts = new Map<string, Set<string>>();
  const faults: ResumeFault[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const hanging = new Set<ServerResponse>();
  let messageSeq = 0;
  let scripted: { steps: readonly Step[]; ttl?: number } | null = null;
  let baseUrl = "";

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const push = (run: FakeRun, role: "assistant" | "tool", content: unknown[]) => {
    messageSeq += 1;
    run.messages.push({ id: `msg_${String(messageSeq).padStart(6, "0")}`, createdAt: iso(), message: { role, content } });
    run.updatedAt = iso();
  };

  const end = (run: FakeRun, status: Status) => {
    run.status = status;
    run.updatedAt = iso();
    const session = sessions.get(run.sessionId);
    if (session && session.status === "RUNNING") {
      session.status = status === "TIMED_OUT" ? "TIMED_OUT" : "COMPLETED";
      if (session.context?.persist) contexts.set(session.context.id, new Set(session.signedIn));
    }
  };

  /** Show a page; a site the browser is already signed in to skips its sign-in. */
  const load = (session: FakeSession, page: FakePage) => {
    const challenge = page.challenge;
    session.page = challenge?.signsIn && session.signedIn.has(challenge.signsIn) ? { ...challenge.then } : page;
  };

  /** Run steps until the script pauses or finishes. */
  const advance = (run: FakeRun) => {
    later(stepMs, () => {
      if (run.status !== "RUNNING") return;
      const step = run.steps[run.pc];
      if (!step) return end(run, "COMPLETED");
      run.pc += 1;
      if ("say" in step) push(run, "assistant", [{ type: "text", text: step.say }]);
      else if ("tool" in step) {
        const id = `toolu_${randomUUID().slice(0, 12)}`;
        push(run, "assistant", [{ type: "tool-call", toolName: step.tool, toolCallId: id, input: step.input ?? {} }]);
        push(run, "tool", [{ type: "tool-result", toolName: step.tool, toolCallId: id, output: { type: "text", value: "ok" } }]);
        const session = sessions.get(run.sessionId);
        if (session && step.page) load(session, step.page);
      } else if ("pause" in step) {
        if (step.onlyIfChallenged && !sessions.get(run.sessionId)?.page.challenge) return advance(run);
        const id = `toolu_${randomUUID().slice(0, 12)}`;
        push(run, "assistant", [{ type: "tool-call", toolName: "pause", toolCallId: id, input: { message: step.pause } }]);
        run.pendingPause = id;
        run.status = "PAUSED";
        return;
      } else {
        push(run, "assistant", [{ type: "text", text: step.complete }]);
        return end(run, "COMPLETED");
      }
      advance(run);
    });
  };

  const startRun = (input: RunInput): string => {
    const runId = randomUUID();
    const sessionId = randomUUID();
    const ttl = input.sessionTtlMs ?? defaultTtl;
    sessions.set(sessionId, {
      id: sessionId,
      status: "RUNNING",
      expiresAt: Date.now() + ttl,
      page: { url: "about:blank", title: "New tab" },
      signedIn: new Set(input.context ? contexts.get(input.context.id) : []),
      context: input.context ?? null,
    });
    const run: FakeRun = {
      runId,
      task: input.task,
      pauseWhen: input.pauseWhen ?? null,
      status: "RUNNING",
      sessionId,
      createdAt: iso(),
      updatedAt: iso(),
      steps: input.steps,
      pc: 0,
      messages: [],
      pendingPause: null,
      resumeCalls: 0,
      receivedVariables: [],
    };
    runs.set(runId, run);
    // GUESS: the docs do not say what a paused run's status becomes when its
    // session times out before a resume. Here it becomes TIMED_OUT at once.
    later(ttl, () => {
      if (!["COMPLETED", "FAILED", "STOPPED", "TIMED_OUT"].includes(run.status)) end(run, "TIMED_OUT");
    });
    advance(run);
    return runId;
  };

  /** Deliver a reply: the pause call's result, then carry on. */
  const applyResume = (run: FakeRun, task: string, variables: Record<string, unknown> | undefined) => {
    // Matches live Browserbase (Run 1, 2026-09-28): the pause's result is a JSON
    // tool-result carrying the reply and a note telling the agent to re-orient.
    push(run, "tool", [
      {
        type: "tool-result",
        toolName: "pause",
        toolCallId: run.pendingPause,
        output: {
          type: "json",
          value: {
            reply: task,
            note: "The caller replied (see `reply`). The browser session was kept alive but may have changed; take a fresh snapshot or screenshot if you need to re-orient before acting.",
          },
        },
      },
    ]);
    run.receivedVariables.push(...Object.keys(variables ?? {}));
    run.pendingPause = null;
    run.status = "RUNNING";
    advance(run);
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const publicRun = (run: FakeRun) => ({
    runId: run.runId,
    task: run.task,
    status: run.status,
    sessionId: run.sessionId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });
  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const livePage = (session: FakeSession) => `<!doctype html><meta charset="utf-8">
<title>Simulated browser</title>
<style>body{font:15px system-ui;margin:0;background:#fafaf8;color:#222}
.bar{background:#b3261e;color:#fff;font-weight:700;padding:6px 12px;font-size:12px;letter-spacing:.06em}
.url{padding:8px 12px;border-bottom:1px solid #ddd;font:13px ui-monospace,monospace;color:#555}
main{padding:24px}button{font:inherit;font-weight:600;padding:10px 16px;border-radius:6px;border:0;background:#1d5fd1;color:#fff;cursor:pointer}</style>
<div class="bar">SIMULATED BROWSER — not a real Browserbase session</div>
<div class="url" id="url"></div><main><h2 id="title"></h2><div id="body"></div></main>
<script>
  function render(p){document.getElementById('url').textContent=p.url;document.getElementById('title').textContent=p.title;
    var body=document.getElementById('body');body.textContent='';
    if(p.challenge){var b=document.createElement('button');b.textContent=p.challenge.label;
      b.onclick=function(){fetch(location.pathname+'/act',{method:'POST'}).then(function(r){return r.json()}).then(render)};body.appendChild(b);}
    else{body.textContent='Nothing needs doing on this page.';}}
  render(${JSON.stringify(session.page).replace(/</g, "\\u003c")});
</script>`;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    // The simulated Live View: a page with the session's current tab.
    if (parts[0] === "_fake" && parts[1] === "live" && parts[2]) {
      const session = sessions.get(parts[2]);
      if (!session) return json(res, 404, { error: "no session" });
      if (method === "POST" && parts[3] === "act") {
        const challenge = session.status === "RUNNING" ? session.page.challenge : undefined;
        if (challenge) {
          if (challenge.signsIn) session.signedIn.add(challenge.signsIn);
          session.page = { ...challenge.then };
        }
        return json(res, 200, session.page);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(livePage(session));
      return;
    }

    if (parts[0] !== "v1") return json(res, 404, { error: "not found" });
    if (!req.headers["x-bb-api-key"]) return json(res, 401, { error: "missing x-bb-api-key" });

    if (method === "POST" && parts[1] === "contexts" && parts.length === 2) {
      const id = randomUUID();
      contexts.set(id, new Set());
      // Documented response fields; the key material is meaningless here.
      return json(res, 201, { id, publicKey: "SIMULATED", cipherAlgorithm: "AES-256-CBC", initializationVectorSize: 16 });
    }

    if (parts[1] === "sessions" && parts[2]) {
      const session = sessions.get(parts[2]);
      if (!session) return json(res, 404, { error: "no session" });
      if (session.status === "RUNNING" && session.expiresAt <= Date.now()) session.status = "TIMED_OUT";
      if (parts[3] === "debug") {
        const live = `${baseUrl}/_fake/live/${session.id}`;
        return json(res, 200, {
          debuggerFullscreenUrl: live,
          debuggerUrl: live,
          wsUrl: "",
          pages: [{ id: "page-1", url: session.page.url, title: session.page.title, faviconUrl: "", debuggerUrl: live, debuggerFullscreenUrl: live }],
        });
      }
      return json(res, 200, { id: session.id, status: session.status, expiresAt: iso(session.expiresAt), contextId: session.context?.id ?? null });
    }

    if (parts[1] !== "agents" || parts[2] !== "runs") return json(res, 404, { error: "not found" });

    if (method === "POST" && parts.length === 3) {
      const body = await readBody(req);
      const task = typeof body.task === "string" ? body.task : "";
      if (!task) return json(res, 400, { error: "task is required" });
      const script = scripted ?? { steps: [{ say: "Working on it." }, { complete: "Done." }] };
      scripted = null;
      const settings = body.browserSettings as { context?: { id?: unknown; persist?: unknown } } | undefined;
      const contextId = settings?.context?.id;
      // GUESS: the status and message for an unknown context id are undocumented.
      if (contextId !== undefined && (typeof contextId !== "string" || !contexts.has(contextId))) return json(res, 400, { message: "Context not found" });
      const runId = startRun({
        context: typeof contextId === "string" ? { id: contextId, persist: settings?.context?.persist === true } : undefined,
        task,
        pauseWhen: typeof body.pauseWhen === "string" ? body.pauseWhen : undefined,
        steps: script.steps,
        sessionTtlMs: script.ttl,
      });
      return json(res, 201, publicRun(runs.get(runId) as FakeRun));
    }
    if (method === "GET" && parts.length === 3) {
      const status = url.searchParams.get("status");
      const data = [...runs.values()].filter((r) => !status || r.status === status).map(publicRun);
      return json(res, 200, { data, limit: 100, nextCursor: null });
    }

    const run = parts[3] ? runs.get(parts[3]) : undefined;
    if (!run) return json(res, 404, { error: "no such run" });

    if (method === "GET" && parts.length === 4) return json(res, 200, publicRun(run));

    if (method === "GET" && parts[4] === "messages") {
      const since = url.searchParams.get("since");
      const start = since ? run.messages.findIndex((m) => m.id === since) + 1 : 0;
      const data = run.messages.slice(start);
      return json(res, 200, { data, nextSince: data.at(-1)?.id ?? since ?? null });
    }

    if (method === "POST" && parts[4] === "resume") {
      const body = await readBody(req);
      const task = typeof body.task === "string" ? body.task : "";
      if (!task) return json(res, 400, { error: "task is required" });
      run.resumeCalls += 1;
      const fault = faults.shift();
      if (fault === "unavailable") return json(res, 503, { message: "Run control is temporarily unavailable" });
      if (fault === "unknown_not_applied") return json(res, 500, { message: "Resume outcome is unknown" });
      const session = sessions.get(run.sessionId);
      if (run.status === "PAUSED" && session && session.expiresAt <= Date.now()) {
        end(run, "TIMED_OUT");
        return json(res, 409, { message: "The run's browser session has ended" });
      }
      // Matches live Browserbase (Run 1): 409 {"statusCode":409,"error":"Conflict","message":"Run is not paused (RUNNING)."}
      if (run.status !== "PAUSED") return json(res, 409, { statusCode: 409, error: "Conflict", message: `Run is not paused (${run.status}).` });
      const variables = body.variables && typeof body.variables === "object" ? (body.variables as Record<string, unknown>) : undefined;
      applyResume(run, task, variables);
      if (fault === "unknown_applied") return json(res, 500, { message: "Resume outcome is unknown" });
      if (fault === "hang_applied") {
        hanging.add(res);
        return;
      }
      return json(res, 202, publicRun(run));
    }

    return json(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => json(res, 500, { message: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: baseUrl,
    startRun,
    nextScript(steps, sessionTtlMs) {
      scripted = { steps, ttl: sessionTtlMs };
    },
    injectResumeFault(fault) {
      faults.push(fault);
    },
    resumeCalls: (runId) => runs.get(runId)?.resumeCalls ?? 0,
    receivedVariables: (runId) => runs.get(runId)?.receivedVariables ?? [],
    resumeElsewhere(runId, task) {
      const run = runs.get(runId);
      if (run?.status === "PAUSED") applyResume(run, task, undefined);
    },
    expireSession(runId) {
      const run = runs.get(runId);
      const session = run ? sessions.get(run.sessionId) : undefined;
      if (!run || !session) return;
      session.expiresAt = Date.now() - 1;
      if (!["COMPLETED", "FAILED", "STOPPED", "TIMED_OUT"].includes(run.status)) end(run, "TIMED_OUT");
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
