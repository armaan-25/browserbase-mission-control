/**
 * One pause of a Browserbase Agents run, and what may happen to it.
 *
 * Browserbase owns the run: its status (`PAUSED`, `RUNNING`, ...) is read, never
 * written, here. This file owns the *intervention*: our record of one pause and
 * of the person's reply to it. The two are deliberately separate state machines,
 * because they disagree in exactly the interesting cases: we sent a resume and
 * got no answer (the run may or may not be running), or someone resumed the run
 * without us (the run moved on, our card is stale).
 *
 * An intervention is keyed by the pause tool call's `toolCallId`. A reply is
 * always for one specific pause, so a card left open from an earlier pause of the
 * same run cannot answer a later one.
 *
 *   open ──resolve──▶ resuming ──202──────────────▶ resumed
 *    ▲                   │ 409 / 500 / no answer
 *    │                   ▼
 *    └──still paused── outcome_unknown ──run moved past the pause──▶ resumed
 *       on this pause
 *
 *   open / outcome_unknown ──run moved on without us──▶ superseded
 *   open / outcome_unknown ──session ended──────────▶ expired
 *
 * Nothing here retries a resume. Returning to `open` means a person must choose to
 * send again, with a new idempotency key.
 *
 * Pure: no clock, no I/O.
 */
import { redact } from "./redact.ts";

export type RunStatus = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "STOPPED" | "TIMED_OUT";
export const RUN_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "STOPPED",
  "TIMED_OUT",
];
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["COMPLETED", "FAILED", "STOPPED", "TIMED_OUT"]);

export type InterventionState = "open" | "resuming" | "outcome_unknown" | "resumed" | "superseded" | "expired";

/** What the person sent, as recorded. Secret values are never part of this. */
export interface Resolution {
  /** `credentials`: a saved login was sent as variables (never stored). */
  readonly type: "answer" | "takeover" | "credentials";
  /** Safe to show and store: redacted text, or a marker that a secret was supplied. */
  readonly summary: string;
  /** The exact `task` text sent to /resume. Secrets are `%placeholders%` in it. */
  readonly sentTask: string;
  /** The tab the person left the browser on, for a takeover. */
  readonly page: { readonly url: string; readonly title: string } | null;
}

/** How we know the agent continued. */
export type Receipt =
  /** Browserbase returned 202 for our resume. */
  | "accepted"
  /** The run's messages show our reply as the result of this pause. */
  | "reply_seen"
  /** The run moved past this pause; we cannot tell from its messages whose reply it got. */
  | "moved_past";

export interface Intervention {
  /** `${runId}:${pauseCallId}` */
  readonly id: string;
  readonly runId: string;
  readonly pauseCallId: string;
  /** The agent's `input.message`, redacted. */
  readonly message: string;
  readonly state: InterventionState;
  /** When the pause message was written. */
  readonly pausedAt: number;
  readonly detectedAt: number;
  /** Browser control as far as we know it. Browserbase does not enforce this. */
  readonly controller: "none" | "human";
  readonly takenOverAt: number | null;
  readonly resolution: Resolution | null;
  readonly attemptKey: string | null;
  /** Every idempotency key ever used on this pause. A key is never honoured twice. */
  readonly usedKeys: readonly string[];
  readonly attemptAt: number | null;
  readonly attempts: number;
  readonly resolvedAt: number | null;
  readonly receipt: Receipt | null;
  /** The latest thing a person should know: an error, or how a state was reached. */
  readonly detail: string | null;
}

export type RejectCode = "in_progress" | "checking" | "already_resolved" | "superseded" | "expired" | "not_open";

export interface Rejection {
  readonly ok: false;
  readonly code: RejectCode;
  readonly message: string;
}

const rejection = (code: RejectCode, message: string): Rejection => ({ ok: false, code, message });

export function newIntervention(input: {
  runId: string;
  pauseCallId: string;
  message: string;
  pausedAt: number;
  detectedAt: number;
}): Intervention {
  return {
    id: `${input.runId}:${input.pauseCallId}`,
    runId: input.runId,
    pauseCallId: input.pauseCallId,
    message: input.message,
    state: "open",
    pausedAt: input.pausedAt,
    detectedAt: input.detectedAt,
    controller: "none",
    takenOverAt: null,
    resolution: null,
    attemptKey: null,
    usedKeys: [],
    attemptAt: null,
    attempts: 0,
    resolvedAt: null,
    receipt: null,
    detail: null,
  };
}

/** A person opened the live browser for this pause. Recorded, not enforced. */
export function takeOver(i: Intervention, now: number): Intervention | Rejection {
  if (i.state !== "open") return rejection("not_open", `this pause is ${i.state}`);
  if (i.controller === "human") return i;
  return { ...i, controller: "human", takenOverAt: now };
}

/**
 * Claim the pause for one reply, before the resume call is made. Written first,
 * so that a crash during the call leaves a record that a resume may have gone out.
 */
export function beginResume(
  i: Intervention,
  input: { key: string; resolution: Resolution },
  now: number,
): { ok: true; intervention: Intervention; replay: boolean } | Rejection {
  // The same click, resent (lost response, double-click, a retry after the card
  // reopened): report, never repeat. A new reply always needs a new key.
  if (i.usedKeys.includes(input.key)) return { ok: true, intervention: i, replay: true };
  switch (i.state) {
    case "open":
      return {
        ok: true,
        replay: false,
        intervention: {
          ...i,
          state: "resuming",
          resolution: input.resolution,
          attemptKey: input.key,
          usedKeys: [...i.usedKeys, input.key],
          attemptAt: now,
          attempts: i.attempts + 1,
          detail: null,
        },
      };
    case "resuming":
      return rejection("in_progress", "a reply to this pause is being sent");
    case "outcome_unknown":
      return rejection("checking", "a reply was sent and its outcome is being checked; it will not be resent");
    case "resumed":
      return rejection("already_resolved", "this pause was already answered");
    case "superseded":
      return rejection("superseded", "the run moved past this pause without a reply from this inbox");
    case "expired":
      return rejection("expired", "the browser session ended");
  }
}

/** What Browserbase said to our resume, reduced to what it means for the pause. */
export type ResumeResult =
  | { readonly kind: "accepted" }
  /** 409: not paused, someone else got there first, or it couldn't continue. Check. */
  | { readonly kind: "conflict"; readonly detail: string }
  /** 500 "outcome unknown", a timeout, or a dropped connection. Check; never resend. */
  | { readonly kind: "unknown"; readonly detail: string }
  /** 503, or a request rejected before it could act. Definitely not applied. */
  | { readonly kind: "not_applied"; readonly detail: string }
  | { readonly kind: "run_missing" };

export function applyResumeResult(i: Intervention, key: string, result: ResumeResult, now: number): Intervention {
  // A late answer to an attempt that is no longer current changes nothing.
  if (i.attemptKey !== key || i.state !== "resuming") return i;
  switch (result.kind) {
    case "accepted":
      return { ...i, state: "resumed", resolvedAt: now, receipt: "accepted", detail: null };
    case "conflict":
    case "unknown":
      return { ...i, state: "outcome_unknown", detail: result.detail };
    case "not_applied":
      return { ...i, state: "open", detail: `not sent: ${result.detail}` };
    case "run_missing":
      return { ...i, state: "superseded", detail: "Browserbase no longer has this run" };
  }
}

/** A service that stopped while a resume was in flight cannot know how it ended. */
export function recoverAfterRestart(i: Intervention): Intervention {
  if (i.state !== "resuming") return i;
  return { ...i, state: "outcome_unknown", detail: "the inbox restarted while this reply was being sent" };
}

/** What polling Browserbase shows about the run right now. */
export interface Observed {
  readonly status: RunStatus;
  /** toolCallId of the trailing `pause` call, when the run is paused on one. */
  readonly pausedOn: string | null;
  /** The text the run's messages record as this pause's result, if any. */
  readonly pauseResult: string | null;
  /** The run's browser session is gone (timed out, completed, errored). */
  readonly sessionEnded: boolean;
}

/**
 * Bring an intervention in line with the run. Called on every poll.
 *
 * `observedAt` is when the reads behind `seen` *started*. Evidence older than the
 * thing it would judge says nothing about it: a read that began before a card
 * existed cannot supersede it, and one that began before a reply was sent cannot
 * say whether that reply landed.
 *
 * `graceMs`: after an uncertain resume, how long a run may still show this pause
 * before we conclude the resume did not take effect and reopen the card.
 */
export function reconcile(i: Intervention, seen: Observed, observedAt: number, graceMs: number): Intervention {
  const onThisPause = seen.status === "PAUSED" && seen.pausedOn === i.pauseCallId;
  const now = observedAt;

  if (i.state === "open") {
    if (observedAt < i.detectedAt) return i;
    if (onThisPause && !seen.sessionEnded) return i;
    if (seen.status === "TIMED_OUT" || (onThisPause && seen.sessionEnded)) {
      return { ...i, state: "expired", detail: "the browser session ended before a reply was sent" };
    }
    return { ...i, state: "superseded", detail: `the run moved on (${seen.status}) without a reply from this inbox` };
  }

  if (i.state !== "outcome_unknown") return i;
  if (i.attemptAt !== null && observedAt < i.attemptAt) return i;

  const sent = i.resolution?.sentTask ?? null;
  if (seen.pauseResult !== null && sent !== null) {
    // The transcript is stored redacted, so compare against the redacted reply.
    return seen.pauseResult.includes(redact(sent))
      ? { ...i, state: "resumed", resolvedAt: now, receipt: "reply_seen", detail: null }
      : { ...i, state: "superseded", detail: "the run received a different reply to this pause" };
  }
  if (onThisPause) {
    if (seen.sessionEnded) return { ...i, state: "expired", detail: "the browser session ended; the reply did not take effect" };
    if (i.attemptAt !== null && now - i.attemptAt < graceMs) return i;
    return {
      ...i,
      state: "open",
      detail: "the earlier reply did not take effect, and nothing was resent; you can send again",
    };
  }
  if (seen.status === "TIMED_OUT") {
    return { ...i, state: "expired", detail: "the run timed out; the reply may have arrived after the session ended" };
  }
  return { ...i, state: "resumed", resolvedAt: now, receipt: "moved_past", detail: null };
}
