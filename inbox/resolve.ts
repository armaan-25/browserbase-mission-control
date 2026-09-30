/**
 * A person's reply to one pause, delivered as exactly one resume attempt.
 *
 *   1. Build the resume body. Secret values go in `variables` and are never stored.
 *   2. Claim the pause (open → resuming) in one transaction, recording the attempt
 *      before the call, so a crash mid-call leaves evidence that a resume may have
 *      gone out.
 *   3. Re-read the run: send only if it is still paused on this exact pause.
 *      Then call /resume once. No retries.
 *   4. Record what Browserbase said. An uncertain answer becomes `outcome_unknown`,
 *      which only the poller settles, by reading the run.
 *
 * A resend with the same idempotency key (double-click, lost response, second
 * tab) finds the claim from step 2 and gets the current state instead of a
 * second resume.
 */
import type { AgentsApi } from "./api.ts";
import type { CredentialStore } from "./credentials.ts";
import {
  applyResumeResult,
  beginResume,
  takeOver,
  type Intervention,
  type Rejection,
  type Resolution,
  type ResumeResult,
} from "./intervention.ts";
import { redact } from "./redact.ts";
import type { Store } from "./store.ts";

/** The variable name the agent sees for a secret reply. Its value is never stored. */
const SECRET_VARIABLE = "human_reply";

export type ReplyInput =
  | { readonly key: string; readonly type: "answer"; readonly text: string; readonly secret: boolean }
  | { readonly key: string; readonly type: "takeover"; readonly note: string | null }
  /** Sign in with the saved login for `site`: sent as variables, never stored. */
  | { readonly key: string; readonly type: "credentials"; readonly site: string };

export type ResolveOutcome =
  | { readonly ok: true; readonly intervention: Intervention; readonly replay: boolean }
  | Rejection
  | { readonly ok: false; readonly code: "not_found" | "bad_input"; readonly message: string };

export interface ResolveDeps {
  readonly store: Store;
  readonly api: AgentsApi;
  readonly credentials?: CredentialStore;
  readonly now?: () => number;
}

/** Build the resume body and the record of it. */
async function prepare(
  deps: ResolveDeps,
  intervention: Intervention,
  input: ReplyInput,
): Promise<{ resolution: Resolution; body: { task: string; variables?: Record<string, { value: string; description: string }> } } | null> {
  if (input.type === "credentials") {
    // The agent sees only the placeholders; Browserbase substitutes the values when it
    // types, and they do not enter the transcript (verified live, 2026-09-30).
    const login = deps.credentials?.list().find((l) => l.site === input.site);
    const password = login ? deps.credentials?.password(login.site) : null;
    if (!login || !password) return null;
    const task =
      "Credentials are provided as variables. On the sign-in page, type %login_username% into the username field and " +
      "%login_password% into the password field, submit, then continue with your task.";
    return {
      resolution: { type: "credentials", summary: `used the saved login for ${login.site} (${login.username})`, sentTask: task, page: null },
      body: {
        task,
        variables: {
          login_username: { value: login.username, description: `username for ${login.site}` },
          login_password: { value: password, description: `password for ${login.site}` },
        },
      },
    };
  }
  if (input.type === "answer") {
    const text = input.text.trim();
    if (!text) return null;
    if (input.secret) {
      const task = `Here is the value you asked for: %${SECRET_VARIABLE}%`;
      return {
        resolution: { type: "answer", summary: "a secret value was supplied (not stored)", sentTask: task, page: null },
        body: {
          task,
          variables: { [SECRET_VARIABLE]: { value: text, description: "The value a person supplied in reply to your pause" } },
        },
      };
    }
    return { resolution: { type: "answer", summary: redact(text), sentTask: text, page: null }, body: { task: text } };
  }

  // Takeover: say where the person left the browser. Read from the session's own
  // tab list (GET /v1/sessions/{id}/debug), which reports the current URL and title.
  const run = deps.store.getRun(intervention.runId);
  const live = run?.sessionId ? await deps.api.liveView(run.sessionId) : null;
  const page = live?.pages[0] ? { url: live.pages[0].url, title: live.pages[0].title } : null;
  const note = input.note?.trim() ? redact(input.note.trim()) : null;
  const task = [
    "A person took over the browser for this request and has handed it back.",
    note ? `They said: ${note}` : null,
    page ? `The current tab is "${page.title}" at ${page.url}.` : null,
    "The page may have changed since you paused: look at it again before continuing.",
  ]
    .filter(Boolean)
    .join(" ");
  return { resolution: { type: "takeover", summary: note ?? "", sentTask: task, page }, body: { task } };
}

/** True when the run is PAUSED and its latest pause call is `pauseCallId`. False if unsure. */
async function pausedOn(api: AgentsApi, runId: string, pauseCallId: string, cursor: string | null): Promise<boolean> {
  try {
    const run = await api.getRun(runId);
    if (run?.status !== "PAUSED") return false;
    // The card was made from messages up to `cursor`. Anything newer that answers
    // this pause, or asks a new one, means the run is no longer waiting on it.
    const { messages } = await api.listMessages(runId, cursor);
    const parts = messages.flatMap((m) => m.parts);
    const answered = parts.some((p) => p.type === "tool-result" && p.toolCallId === pauseCallId);
    const newerPause = parts.some((p) => p.type === "tool-call" && p.toolName === "pause" && p.toolCallId !== pauseCallId);
    return !answered && !newerPause;
  } catch {
    return false;
  }
}

export async function resolvePause(deps: ResolveDeps, id: string, input: ReplyInput): Promise<ResolveOutcome> {
  const { store, api } = deps;
  const now = deps.now ?? Date.now;
  const existing = store.getIntervention(id);
  if (!existing) return { ok: false, code: "not_found", message: `no pause ${id}` };

  // A resend of any earlier attempt: answer from the record, send nothing.
  if (existing.usedKeys.includes(input.key)) {
    return { ok: true, intervention: existing, replay: true };
  }

  const prepared = await prepare(deps, existing, input);
  if (!prepared) {
    return { ok: false, code: "bad_input", message: input.type === "credentials" ? `no saved login for ${input.site}` : "a reply needs some text" };
  }

  const claimed = store.tx(() => {
    const current = store.getIntervention(id);
    if (!current) return { ok: false as const, code: "not_found" as const, message: `no pause ${id}` };
    const result = beginResume(current, { key: input.key, resolution: prepared.resolution }, now());
    if (result.ok && !result.replay) {
      store.saveIntervention(result.intervention);
      store.log(current.runId, id, "reply.sending", now(), {
        type: prepared.resolution.type,
        summary: prepared.resolution.summary,
        attempt: result.intervention.attempts,
      });
    }
    return result;
  });
  if (!claimed.ok || claimed.replay) return claimed;

  // /resume does not say which pause it answers. So check, as close to the call as
  // possible, that the run is still waiting on *this* pause; if it moved on (or we
  // cannot tell), send nothing. This narrows the wrong-pause window from one poll
  // interval to the gap between this read and the call.
  const stillHere = await pausedOn(api, existing.runId, existing.pauseCallId, store.getRun(existing.runId)?.messageCursor ?? null);
  const result: ResumeResult = stillHere
    ? await api.resume(existing.runId, prepared.body)
    : { kind: "not_applied", detail: "the run is no longer waiting on this request (or could not be checked); nothing was sent" };

  const final = store.tx(() => {
    const current = store.getIntervention(id) ?? claimed.intervention;
    const next = applyResumeResult(current, input.key, result, now());
    if (next !== current) {
      store.saveIntervention(next);
      store.log(current.runId, id, `intervention.${next.state}`, now(), { resume: result.kind, detail: next.detail });
    }
    return next;
  });
  return { ok: true, intervention: final, replay: false };
}

export function startTakeover(deps: ResolveDeps, id: string): ResolveOutcome {
  const now = deps.now ?? Date.now;
  return deps.store.tx(() => {
    const current = deps.store.getIntervention(id);
    if (!current) return { ok: false as const, code: "not_found" as const, message: `no pause ${id}` };
    const next = takeOver(current, now());
    if (!("id" in next)) return next;
    if (next !== current) {
      deps.store.saveIntervention(next);
      deps.store.log(current.runId, id, "takeover.started", now());
    }
    return { ok: true as const, intervention: next, replay: next === current };
  });
}
