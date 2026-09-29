/** The pause state machine, with no I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyResumeResult,
  beginResume,
  newIntervention,
  reconcile,
  recoverAfterRestart,
  takeOver,
  type Intervention,
  type Resolution,
} from "../inbox/intervention.ts";

const pause = newIntervention({ runId: "run", pauseCallId: "toolu_1", message: "Which airport?", pausedAt: 100, detectedAt: 110 });
const reply: Resolution = { type: "answer", summary: "BOS", sentTask: "BOS on the 2nd", page: null };
const still = { status: "PAUSED" as const, pausedOn: "toolu_1", pauseResult: null, sessionEnded: false };

function claimed(key = "key-1"): Intervention {
  const result = beginResume(pause, { key, resolution: reply }, 200);
  assert.ok(result.ok && !result.replay);
  return result.intervention;
}

test("a pause is keyed by its tool call, so each pause gets its own card", () => {
  assert.equal(pause.id, "run:toolu_1");
  assert.equal(pause.state, "open");
});

test("claiming a pause records the attempt before anything is sent", () => {
  const i = claimed();
  assert.equal(i.state, "resuming");
  assert.equal(i.attemptKey, "key-1");
  assert.equal(i.attempts, 1);
});

test("the same key is a replay; a different key is refused while the first is in flight or done", () => {
  const i = claimed();
  const again = beginResume(i, { key: "key-1", resolution: reply }, 201);
  assert.ok(again.ok && again.replay);
  const other = beginResume(i, { key: "key-2", resolution: reply }, 201);
  assert.equal(!other.ok && other.code, "in_progress");
  const done = applyResumeResult(i, "key-1", { kind: "accepted" }, 300);
  const late = beginResume(done, { key: "key-3", resolution: reply }, 301);
  assert.equal(!late.ok && late.code, "already_resolved");
});

test("resume results: 202 resolves, 409/500/no answer are unknown, 503 reopens, 404 supersedes", () => {
  const i = claimed();
  assert.equal(applyResumeResult(i, "key-1", { kind: "accepted" }, 300).state, "resumed");
  assert.equal(applyResumeResult(i, "key-1", { kind: "conflict", detail: "409" }, 300).state, "outcome_unknown");
  assert.equal(applyResumeResult(i, "key-1", { kind: "unknown", detail: "500" }, 300).state, "outcome_unknown");
  const reopened = applyResumeResult(i, "key-1", { kind: "not_applied", detail: "503" }, 300);
  assert.equal(reopened.state, "open");
  const resent = beginResume(reopened, { key: "key-1", resolution: reply }, 301);
  assert.ok(resent.ok && resent.replay, "the old key is still a replay: a new reply needs a new key");
  const fresh = beginResume(reopened, { key: "key-2", resolution: reply }, 301);
  assert.ok(fresh.ok && !fresh.replay);
  assert.equal(applyResumeResult(i, "key-1", { kind: "run_missing" }, 300).state, "superseded");
  assert.equal(applyResumeResult(i, "stale-key", { kind: "accepted" }, 300), i, "a late result for another attempt is ignored");
});

test("unknown outcome: the transcript showing our reply confirms it; a different reply supersedes", () => {
  const unknown = applyResumeResult(claimed(), "key-1", { kind: "unknown", detail: "500" }, 300);
  const seen = reconcile(unknown, { status: "RUNNING", pausedOn: null, pauseResult: "BOS on the 2nd", sessionEnded: false }, 400, 1_000);
  assert.equal(seen.state, "resumed");
  assert.equal(seen.receipt, "reply_seen");
  const other = reconcile(unknown, { status: "RUNNING", pausedOn: null, pauseResult: "use BED", sessionEnded: false }, 400, 1_000);
  assert.equal(other.state, "superseded");
});

test("unknown outcome: still on the same pause stays unknown during the grace period, then reopens without resending", () => {
  const unknown = applyResumeResult(claimed(), "key-1", { kind: "unknown", detail: "500" }, 300);
  assert.equal(reconcile(unknown, still, 500, 1_000).state, "outcome_unknown");
  const reopened = reconcile(unknown, still, 1_300, 1_000);
  assert.equal(reopened.state, "open");
  assert.match(reopened.detail ?? "", /nothing was resent/);
  const again = beginResume(reopened, { key: "key-1", resolution: reply }, 1_301);
  assert.ok(again.ok && again.replay, "resending the first key after the reopen sends nothing");
});

test("unknown outcome: the run moved past the pause without a visible result counts as moved past", () => {
  const unknown = applyResumeResult(claimed(), "key-1", { kind: "conflict", detail: "409" }, 300);
  const moved = reconcile(unknown, { status: "COMPLETED", pausedOn: null, pauseResult: null, sessionEnded: true }, 400, 1_000);
  assert.equal(moved.state, "resumed");
  assert.equal(moved.receipt, "moved_past");
});

test("an open pause the run moved past without us is superseded; one whose session ended is expired", () => {
  const next = reconcile(pause, { status: "PAUSED", pausedOn: "toolu_2", pauseResult: null, sessionEnded: false }, 400, 1_000);
  assert.equal(next.state, "superseded");
  assert.equal(reconcile(pause, { ...still, sessionEnded: true }, 400, 1_000).state, "expired");
  assert.equal(reconcile(pause, { status: "TIMED_OUT", pausedOn: null, pauseResult: null, sessionEnded: true }, 400, 1_000).state, "expired");
  assert.equal(reconcile(pause, still, 400, 1_000), pause, "nothing changes while it waits");
});

test("a restart during a resume leaves it unknown, not open and not resolved", () => {
  const recovered = recoverAfterRestart(claimed());
  assert.equal(recovered.state, "outcome_unknown");
  assert.equal(recoverAfterRestart(pause), pause);
});

test("take over is recorded only while the pause is open", () => {
  const held = takeOver(pause, 150);
  assert.ok("id" in held && held.controller === "human");
  const refused = takeOver(claimed(), 250);
  assert.ok(!("id" in refused) && refused.code === "not_open");
});

test("the receipt check survives redaction of long numbers in the reply", () => {
  const withNumber: Resolution = { ...reply, sentTask: "Use booking reference 12345678" };
  const i = beginResume(pause, { key: "k", resolution: withNumber }, 200);
  assert.ok(i.ok);
  const unknown = applyResumeResult(i.intervention, "k", { kind: "unknown", detail: "500" }, 300);
  const stored = "Use booking reference [redacted digits]";
  assert.equal(reconcile(unknown, { status: "RUNNING", pausedOn: null, pauseResult: stored, sessionEnded: false }, 400, 1_000).receipt, "reply_seen");
});

test("evidence older than what it judges is ignored", () => {
  // A read that started before the card existed cannot supersede it.
  const moved = { status: "PAUSED" as const, pausedOn: "toolu_2", pauseResult: null, sessionEnded: false };
  assert.equal(reconcile(pause, moved, 105, 1_000), pause);
  // A read that started before the reply was sent cannot judge that reply.
  const unknown = applyResumeResult(claimed(), "key-1", { kind: "unknown", detail: "500" }, 300);
  assert.equal(reconcile(unknown, still, 150, 0), unknown, "even with no grace period");
});

test("every key used on a pause is remembered, not only the latest", () => {
  const first = applyResumeResult(claimed("k-a"), "k-a", { kind: "not_applied", detail: "503" }, 300);
  const second = beginResume(first, { key: "k-b", resolution: reply }, 310);
  assert.ok(second.ok && !second.replay);
  const reopened = applyResumeResult(second.intervention, "k-b", { kind: "not_applied", detail: "503" }, 320);
  const late = beginResume(reopened, { key: "k-a", resolution: reply }, 330);
  assert.ok(late.ok && late.replay, "a late resend of the first click still sends nothing");
});
