/**
 * Who may write to a run's browser, and the only ways that can change.
 *
 * A run's browser has exactly one owner at a time:
 *
 *   agent   — the developer's loop may write through the guarded handle
 *   human   — a person has it; every agent write is refused
 *   stopped — the session is gone; nobody writes and nothing resumes
 *
 * Every change of owner increments `generation`, and each attached loop process
 * gets its own `holder` id. An agent write must present both, so a process that
 * fell behind (a zombie loop after a restart, a stale hand-back from an old tab)
 * is rejected rather than trusted. This is a fencing token: the lease in
 * `lease.ts` answers "who is writing now", generation + holder answer "is this
 * writer still the one we meant".
 *
 * The holder matters because generation alone is not enough: if a loop restarts
 * while a person holds the browser, both the old and new process are waiting on
 * the same hand-back, and both would read the same new generation from it.
 *
 * WHY NOT THE LEASE'S TTL
 * `lease.ts` expires a holder after a TTL and hands the page to the next waiter,
 * which is right for two automated clients. Here it would be exactly wrong: a
 * person pausing to think would silently return the browser to the agent. So no
 * path in this file moves `human` to `agent` except an explicit hand-back, and
 * expiry moves to `stopped`, never to `agent`.
 *
 * Everything here is pure: no clock, no I/O. `store.ts` persists the results.
 */

export type Owner = "agent" | "human" | "stopped";
export type RequestKind = "answer" | "takeover";
export type RequestState = "open" | "handed_back" | "expired";

/** Where the page was when help was requested. */
export interface PageContext {
  readonly url: string;
  readonly title: string;
}

/** What the agent saw when it looked again after the hand-back. */
export interface Observation {
  readonly url: string;
  readonly title: string;
  /** Stagehand's accessibility-tree snapshot, truncated. */
  readonly snapshot: string;
  readonly observedAt: number;
}

export interface Run {
  readonly runId: string;
  /** Browserbase session id; null for a local browser. */
  readonly sessionId: string | null;
  readonly owner: Owner;
  readonly generation: number;
  /** The loop process that plays the agent. The most recent attach wins. */
  readonly holder: string;
  /** The most recent request, open or not. Only it can be handed back. */
  readonly currentRequestId: string | null;
  readonly stoppedReason: string | null;
  readonly updatedAt: number;
}

export interface HelpRequest {
  readonly requestId: string;
  readonly runId: string;
  /** Identifies the question, so a restarted loop re-joins it instead of asking twice. */
  readonly key: string;
  readonly kind: RequestKind;
  readonly reason: string;
  readonly context: PageContext;
  /** The generation at which the person got control. A hand-back must name it. */
  readonly generation: number;
  readonly state: RequestState;
  readonly createdAt: number;
  readonly handedBackAt: number | null;
  readonly note: string | null;
  /** Idempotency key of the hand-back that succeeded, so a resend is recognised. */
  readonly handbackKey: string | null;
  readonly observation: Observation | null;
}

export type RejectionCode =
  | "stopped"
  | "superseded"
  | "not_agent"
  | "stale_generation"
  | "request_open"
  | "stale"
  | "already_handed_back"
  | "expired";

export interface Rejection {
  readonly ok: false;
  readonly code: RejectionCode;
  readonly message: string;
}

const reject = (code: RejectionCode, message: string): Rejection => ({ ok: false, code, message });

/** True only for the current holder, as the agent, at the current generation. */
export function mayAgentWrite(run: Run, generation: number, holder: string): boolean {
  return run.owner === "agent" && run.generation === generation && run.holder === holder;
}

/**
 * A loop process (re)attached to this run as `holder`. It becomes the holder, so
 * every earlier process for the run is fenced out, whether it is writing now or
 * still waiting on a hand-back. If the agent owns the browser, the generation is
 * bumped too. If a person owns it, the owner is unchanged: re-attaching must
 * never take the browser back.
 */
export function reattach(run: Run, holder: string, now: number): Run {
  if (run.owner === "stopped") return run;
  const generation = run.owner === "agent" ? run.generation + 1 : run.generation;
  return { ...run, holder, generation, updatedAt: now };
}

/**
 * The request a re-attached loop should re-join rather than ask again: the
 * current one, if it has the same key and its outcome has not yet been taken up
 * by the agent (still open, or handed back but never observed).
 */
export function reusableRequest(current: HelpRequest | null, key: string): HelpRequest | null {
  if (!current || current.key !== key) return null;
  if (current.state === "open") return current;
  if (current.state === "handed_back" && current.observation === null) return current;
  return null;
}

export interface OpenInput {
  readonly requestId: string;
  readonly key: string;
  readonly kind: RequestKind;
  readonly reason: string;
  readonly context: PageContext;
  /** The generation the requesting agent holds. */
  readonly generation: number;
  /** The loop process asking. */
  readonly holder: string;
}

/** The agent gives the browser to a person. */
export function openRequest(
  run: Run,
  input: OpenInput,
  now: number,
): { ok: true; run: Run; request: HelpRequest } | Rejection {
  if (run.owner === "stopped") return reject("stopped", `run stopped: ${run.stoppedReason ?? "unknown"}`);
  if (run.holder !== input.holder) return reject("superseded", "another loop process has attached to this run");
  if (run.owner === "human") return reject("request_open", "a person already has this browser");
  if (run.generation !== input.generation) {
    return reject("stale_generation", `agent holds generation ${input.generation}, run is at ${run.generation}`);
  }
  const generation = run.generation + 1;
  const request: HelpRequest = {
    requestId: input.requestId,
    runId: run.runId,
    key: input.key,
    kind: input.kind,
    reason: input.reason,
    context: input.context,
    generation,
    state: "open",
    createdAt: now,
    handedBackAt: null,
    note: null,
    handbackKey: null,
    observation: null,
  };
  return {
    ok: true,
    run: { ...run, owner: "human", generation, currentRequestId: request.requestId, updatedAt: now },
    request,
  };
}

export interface HandBackCommand {
  /** The request's generation, as shown on the card the person acted on. */
  readonly generation: number;
  /** Same key on a resend means "the same click", not a second hand-back. */
  readonly idempotencyKey: string;
  readonly note: string | null;
}

/** A person returns the browser to the agent. The only way back to `agent`. */
export function handBack(
  run: Run,
  request: HelpRequest,
  command: HandBackCommand,
  now: number,
): { ok: true; run: Run; request: HelpRequest; replay: boolean } | Rejection {
  // A resend of the hand-back that already won: answer it the same way again.
  if (request.state === "handed_back" && request.handbackKey === command.idempotencyKey) {
    return { ok: true, run, request, replay: true };
  }
  // Checked before state so an old card is told it is stale, not "already done".
  if (run.currentRequestId !== request.requestId || command.generation !== request.generation) {
    return reject("stale", "this card is for an earlier request; reload the inbox");
  }
  if (request.state === "expired") return reject("expired", "the browser session ended before the hand-back");
  if (request.state === "handed_back") return reject("already_handed_back", "this request was already handed back");
  if (run.owner !== "human" || run.generation !== request.generation) {
    return reject("stale", "the run moved on since this card was shown");
  }
  const generation = run.generation + 1;
  return {
    ok: true,
    run: { ...run, owner: "agent", generation, updatedAt: now },
    request: {
      ...request,
      state: "handed_back",
      handedBackAt: now,
      note: command.note,
      handbackKey: command.idempotencyKey,
    },
    replay: false,
  };
}

/** The session is gone. Nobody gets the browser back; the loop must stop. */
export function expire(
  run: Run,
  current: HelpRequest | null,
  reason: string,
  now: number,
): { run: Run; request: HelpRequest | null } {
  const stopped: Run = { ...run, owner: "stopped", generation: run.generation + 1, stoppedReason: reason, updatedAt: now };
  const request = current && current.state === "open" ? { ...current, state: "expired" as const } : current;
  return { run: stopped, request };
}

/** The agent's first look after the hand-back. Recorded once; later calls are ignored. */
export function recordObservation(request: HelpRequest, observation: Observation): HelpRequest | null {
  if (request.state !== "handed_back" || request.observation !== null) return null;
  return { ...request, observation };
}
