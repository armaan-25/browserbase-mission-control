/**
 * Human handoff for a developer-owned Stagehand v4 loop.
 *
 *   const h = await attachHandoff({ stagehand, page, serviceUrl, runId, sessionId });
 *   await h.page.goto("https://example.com");          // guarded write
 *   const reply = await h.requestHuman({ kind: "takeover", reason: "Sign in" });
 *   reply.observation.url                              // what the agent sees now
 *
 * `h.stagehand` and `h.page` are the developer's own objects behind a gate. A
 * write goes through only if the service says this loop is the agent and still
 * holds the generation it was given. While a person has the browser, writes are
 * refused, not queued: a step planned before the person acted was planned against
 * a page that no longer exists.
 *
 * WHAT THE GATE COVERS
 * Calls made through `h.stagehand` and `h.page` (and locators from `h.page`).
 * It cannot see calls on the raw `stagehand`/`page`, on `stagehand.browser`, or
 * anything the Stagehand extension does by itself (a domain policy closing a
 * popup, for example). Those bypass it; do not use them in a handed-off loop.
 *
 * IN-FLIGHT STEPS
 * Measured against the real extension (examples/inflight-experiment.ts): a step
 * `timeout` does not bound how long a step runs, and the extension answers other
 * calls while a step is still running. So "a later call came back" proves nothing
 * about an earlier one. `requestHuman` therefore waits for every write's own
 * promise. If a write ended without a trustworthy answer (the client gave up
 * waiting, or the connection dropped) the step may still be acting on the page,
 * and `requestHuman` refuses to hand the browser over until the developer has
 * checked and called `clearUncertainStep()`.
 */
import { randomUUID } from "node:crypto";
import type { HelpRequest, Observation, RequestKind, Run } from "./ownership.ts";

/** A write was refused because this loop does not hold the browser. */
export class OwnershipError extends Error {
  override name = "OwnershipError";
}
/** The browser session ended. The agent will not be resumed. */
export class SessionEndedError extends Error {
  override name = "SessionEndedError";
}
/** An earlier step's outcome is unknown; it may still be acting on the page. */
export class UncertainStepError extends Error {
  override name = "UncertainStepError";
}

/** The page reads handoff needs. Stagehand v4's `Page` satisfies this. */
export interface ObservablePage {
  url(): Promise<string>;
  title(): Promise<string>;
  snapshot(): Promise<{ formattedTree: string }>;
}

export interface HandoffOptions<S extends object, P extends ObservablePage> {
  readonly stagehand: S;
  readonly page: P;
  readonly serviceUrl: string;
  readonly runId: string;
  /** Browserbase session id, so the service can watch expiry and show Live View. */
  readonly sessionId?: string | null;
}

export interface HumanReply {
  readonly requestId: string;
  readonly note: string | null;
  readonly handedBackAt: number;
  /** A fresh read of the page taken after the hand-back, before any agent write. */
  readonly observation: Observation;
}

export interface Handoff<S extends object, P extends ObservablePage> {
  readonly stagehand: S;
  readonly page: P;
  /** Give the browser to a person and wait for it back. */
  requestHuman(input: { kind: RequestKind; reason: string; key?: string }): Promise<HumanReply>;
  /** Who this loop believes holds the browser. The service is authoritative. */
  readonly phase: Phase;
  /** Call only after confirming the page is idle following an uncertain step. */
  clearUncertainStep(): void;
  /** Stop using the service: pending waits end and every write is refused. */
  detach(): void;
}

type Phase = "agent" | "handing_off" | "human" | "stopped" | "detached";

/** Page methods that only read. Everything else on the page is treated as a write. */
const PAGE_READS = new Set([
  "url",
  "title",
  "snapshot",
  "screenshot",
  "waitForLoadState",
  "waitForSelector",
  "waitForTimeout",
  "on",
]);
const LOCATOR_READS = new Set([
  "count",
  "isChecked",
  "inputValue",
  "isVisible",
  "innerText",
  "innerHtml",
  "textContent",
  "centroid",
]);
/** Stagehand methods that do not touch the page. act/observe/extract are gated. */
const STAGEHAND_READS = new Set(["metrics"]);
/**
 * Methods that return live handles (WebMCP tools, a batch context) whose own
 * methods act on the page. The guard cannot follow them, so they are refused.
 */
const UNSUPPORTED = new Set(["tools", "experimentalBatch"]);

/** Failures after which nobody knows whether the step is still running. */
const UNCERTAIN = /RPC response timed out|RPC client is closed|CDP client closed|socket|disconnect|ECONNRESET/i;

const SNAPSHOT_CHARS = 4_000;
const POLL_MS = 25_000;

export async function attachHandoff<S extends object, P extends ObservablePage>(
  options: HandoffOptions<S, P>,
): Promise<Handoff<S, P>> {
  const base = options.serviceUrl.replace(/\/$/, "");
  const lifetime = new AbortController();
  const inflight = new Set<Promise<unknown>>();
  let uncertain: string | null = null;

  async function call<T>(path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<{ status: number; body: T }> {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(init?.timeoutMs ?? 10_000)]);
    const response = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  // This process's identity. Attaching makes it the run's holder, which fences
  // out any earlier process for the same run, even one still waiting on a hand-back.
  const holder = randomUUID();
  const attached = await call<{ run: Run; pending: HelpRequest | null }>("/api/runs", {
    method: "POST",
    body: { runId: options.runId, sessionId: options.sessionId ?? null, holder },
  });
  if (attached.status !== 200) throw new Error(`could not attach to handoff service: ${JSON.stringify(attached.body)}`);
  const { run } = attached.body;
  if (run.owner === "stopped") throw new SessionEndedError(`run ${run.runId} stopped: ${run.stoppedReason ?? "unknown"}`);

  let generation = run.generation;
  let phase: Phase = run.owner === "human" ? "human" : "agent";

  /** Run one agent write, if and only if this loop holds the browser right now. */
  async function write<T>(label: string, invoke: () => Promise<T>): Promise<T> {
    if (phase !== "agent") throw new OwnershipError(`${label} refused: browser is ${phase}`);
    let current: Run;
    try {
      current = (await call<{ run: Run }>(`/api/runs/${encodeURIComponent(options.runId)}`)).body.run;
    } catch (error) {
      // Cannot confirm ownership, so do not write. Waiting is safe; guessing is not.
      throw new OwnershipError(`${label} refused: handoff service unreachable (${String(error)})`);
    }
    if (current.holder !== holder) {
      phase = "detached";
      throw new OwnershipError(`${label} refused: another loop process has attached to this run`);
    }
    if (current.owner !== "agent" || current.generation !== generation) {
      if (current.owner === "stopped") phase = "stopped";
      throw new OwnershipError(
        `${label} refused: run is ${current.owner} at generation ${current.generation}, this loop holds ${generation}`,
      );
    }
    // requestHuman may have started while we were asking the service.
    if (phase !== "agent") throw new OwnershipError(`${label} refused: browser is ${phase}`);

    const step = invoke();
    inflight.add(step);
    try {
      return await step;
    } catch (error) {
      if (UNCERTAIN.test(String((error as Error)?.message ?? error))) uncertain = `${label}: ${String(error)}`;
      throw error;
    } finally {
      inflight.delete(step);
    }
  }

  /** Wrap an object so that every method not in `reads` goes through `write`. */
  function guard<T extends object>(target: T, reads: Set<string>, label: string, wrapResult?: (prop: string, value: unknown) => unknown): T {
    return new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj) as unknown;
        if (typeof value !== "function" || typeof prop !== "string") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (UNSUPPORTED.has(prop)) {
          return async () => {
            throw new OwnershipError(`${label}.${prop} is not available through handoff: it returns handles the guard cannot see`);
          };
        }
        if (reads.has(prop)) return (...args: unknown[]) => method.apply(obj, args);
        if (wrapResult && (prop === "locator" || prop === "first" || prop === "nth")) {
          // Creating a locator touches nothing; its actions are what get gated.
          return (...args: unknown[]) => wrapResult(prop, method.apply(obj, args));
        }
        return (...args: unknown[]) => write(`${label}.${prop}`, async () => method.apply(obj, args));
      },
    });
  }

  const guardLocator = (locator: object): object =>
    guard(locator, LOCATOR_READS, "locator", (_prop, value) => guardLocator(value as object));
  const page = guard(options.page, PAGE_READS, "page", (_prop, value) => guardLocator(value as object));
  const stagehand = guard(options.stagehand, STAGEHAND_READS, "stagehand");

  /** Wait until the person hands back (or the session ends), then look again. */
  async function awaitOutcome(requestId: string): Promise<HumanReply> {
    for (;;) {
      if (lifetime.signal.aborted) throw new OwnershipError("handoff detached");
      let request: HelpRequest;
      let latest: Run;
      try {
        const got = await call<{ request: HelpRequest; run: Run }>(
          `/api/requests/${encodeURIComponent(requestId)}?wait=${POLL_MS}`,
          { timeoutMs: POLL_MS + 5_000 },
        );
        ({ request, run: latest } = got.body);
      } catch {
        // A lost poll response is harmless: the outcome is stored, ask again.
        if (lifetime.signal.aborted) throw new OwnershipError("handoff detached");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (request.state === "open") continue;
      if (request.state === "expired" || latest.owner === "stopped") {
        phase = "stopped";
        throw new SessionEndedError(`browser session ended while a person held it (${latest.stoppedReason ?? "expired"})`);
      }

      if (latest.holder !== holder) {
        // A newer process for this run re-attached while we waited. It collects
        // the outcome; this one must not write again.
        phase = "detached";
        throw new OwnershipError("another loop process has attached to this run and will continue it");
      }

      // Handed back. Read the page before this loop is allowed to write again, so
      // the observation is the page exactly as the person left it.
      const observation: Observation = {
        url: await options.page.url(),
        title: await options.page.title(),
        snapshot: (await options.page.snapshot()).formattedTree.slice(0, SNAPSHOT_CHARS),
        observedAt: Date.now(),
      };
      // The receipt. Recording it is idempotent, so a lost response can be resent.
      // If it cannot be recorded, do not hand back control: the outcome stays
      // collectable, and requestHuman with the same key re-joins it.
      let recorded = false;
      for (let attempt = 0; attempt < 3 && !recorded; attempt += 1) {
        try {
          const saved = await call(`/api/requests/${encodeURIComponent(requestId)}/observation`, {
            method: "POST",
            body: { observation },
          });
          recorded = saved.status === 200;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (!recorded) {
        throw new OwnershipError(
          "the person handed back, but the receipt could not be recorded; call requestHuman again with the same key to collect it",
        );
      }
      generation = latest.generation;
      phase = latest.owner === "agent" ? "agent" : phase;
      return { requestId, note: request.note, handedBackAt: request.handedBackAt ?? Date.now(), observation };
    }
  }

  return {
    stagehand,
    page,
    get phase() {
      return phase;
    },

    async requestHuman(input) {
      const key = input.key ?? `${input.kind}:${input.reason}`;
      if (phase === "stopped" || phase === "detached" || phase === "handing_off") {
        throw new OwnershipError(`cannot request help: browser is ${phase}`);
      }

      let context = { url: "", title: "" };
      if (phase === "agent") {
        // Stop new writes, then let the ones already running finish.
        phase = "handing_off";
        await Promise.allSettled([...inflight]);
        if (uncertain) {
          phase = "agent";
          throw new UncertainStepError(
            `not handing over: an earlier step may still be running (${uncertain}). Check the page, then call clearUncertainStep().`,
          );
        }
        try {
          context = { url: await options.page.url(), title: await options.page.title() };
        } catch (error) {
          phase = "agent";
          throw error;
        }
      }

      const opened = await call<{ run: Run; request: HelpRequest; error?: string; message?: string }>(
        `/api/runs/${encodeURIComponent(options.runId)}/requests`,
        { method: "POST", body: { key, kind: input.kind, reason: input.reason, context, generation, holder } },
      ).catch((error: unknown) => {
        // Unknown whether the request was stored. Stay out of the browser; a retry
        // with the same key re-joins it if it was.
        phase = "human";
        throw new OwnershipError(`could not reach the handoff service to request help: ${String(error)}`);
      });
      if (opened.status >= 400) {
        const code = opened.body.error ?? "error";
        if (code === "stopped") {
          phase = "stopped";
          throw new SessionEndedError(opened.body.message ?? "run stopped");
        }
        // superseded: a newer process owns this run. request_open: a person
        // already holds it for a different question. Either way, do not write.
        if (code === "superseded") phase = "detached";
        else if (code === "request_open") phase = "human";
        else phase = "agent";
        throw new OwnershipError(`help request refused (${code}): ${opened.body.message ?? ""}`);
      }
      phase = opened.body.request.state === "open" ? "human" : phase;
      return awaitOutcome(opened.body.request.requestId);
    },

    clearUncertainStep() {
      uncertain = null;
    },

    detach() {
      phase = "detached";
      lifetime.abort();
    },
  };
}
