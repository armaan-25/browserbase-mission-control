/** The ownership rules, with no I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { must } from "./fixtures.ts";
import {
  expire,
  handBack,
  mayAgentWrite,
  openRequest,
  reattach,
  recordObservation,
  reusableRequest,
  type Run,
} from "../handoff/ownership.ts";

const run: Run = {
  runId: "r1",
  sessionId: null,
  owner: "agent",
  generation: 1,
  holder: "loop-a",
  currentRequestId: null,
  stoppedReason: null,
  updatedAt: 0,
};
const input = {
  requestId: "q1",
  key: "sign-in",
  kind: "takeover" as const,
  reason: "Sign in",
  context: { url: "https://x.test", title: "X" },
  generation: 1,
  holder: "loop-a",
};

function opened() {
  const result = openRequest(run, input, 10);
  assert.ok(result.ok);
  return result;
}

test("opening a request gives the browser to a person and bumps the generation", () => {
  const { run: after, request } = opened();
  assert.equal(after.owner, "human");
  assert.equal(after.generation, 2);
  assert.equal(request.generation, 2);
  assert.equal(mayAgentWrite(after, 1, "loop-a"), false);
  assert.equal(mayAgentWrite(after, 2, "loop-a"), false);
});

test("an agent holding an old generation cannot open a request", () => {
  const result = openRequest({ ...run, generation: 3 }, input, 10);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "stale_generation");
});

test("hand-back returns the browser to the agent at a new generation", () => {
  const { run: held, request } = opened();
  const result = handBack(held, request, { generation: 2, idempotencyKey: "k1", note: null }, 20);
  assert.ok(result.ok);
  assert.equal(result.run.owner, "agent");
  assert.equal(result.run.generation, 3);
  assert.equal(mayAgentWrite(result.run, 3, "loop-a"), true);
  assert.equal(mayAgentWrite(result.run, 1, "loop-a"), false, "the pre-handoff generation stays fenced out");
  assert.equal(mayAgentWrite(result.run, 3, "loop-b"), false, "only the holder writes");
});

test("double hand-back: same key replays, different key is refused", () => {
  const { run: held, request } = opened();
  const first = handBack(held, request, { generation: 2, idempotencyKey: "k1", note: null }, 20);
  assert.ok(first.ok);
  const replay = handBack(first.run, first.request, { generation: 2, idempotencyKey: "k1", note: null }, 21);
  assert.ok(replay.ok && replay.replay);
  assert.equal(replay.ok && replay.run.generation, 3, "a replay does not move the generation again");
  const second = handBack(first.run, first.request, { generation: 2, idempotencyKey: "k2", note: null }, 22);
  assert.equal(!second.ok && second.code, "already_handed_back");
});

test("stale hand-back: a card for an earlier request is refused", () => {
  const { run: held, request: a } = opened();
  const back = handBack(held, a, { generation: 2, idempotencyKey: "k1", note: null }, 20);
  assert.ok(back.ok);
  const b = openRequest(back.run, { ...input, requestId: "q2", generation: 3 }, 30);
  assert.ok(b.ok);
  const late = handBack(b.run, back.request, { generation: 2, idempotencyKey: "other", note: null }, 40);
  assert.equal(!late.ok && late.code, "stale");
  const wrongGeneration = handBack(b.run, b.request, { generation: 2, idempotencyKey: "k3", note: null }, 40);
  assert.equal(!wrongGeneration.ok && wrongGeneration.code, "stale");
});

test("expiry stops the run; it never hands the browser to the agent", () => {
  const { run: held, request } = opened();
  const stopped = expire(held, request, "session ended", 50);
  assert.equal(stopped.run.owner, "stopped");
  assert.equal(stopped.request?.state, "expired");
  const late = handBack(stopped.run, must(stopped.request, "expired request"), { generation: 2, idempotencyKey: "k1", note: null }, 60);
  assert.equal(late.ok, false);
  assert.equal(openRequest(stopped.run, { ...input, generation: stopped.run.generation }, 70).ok, false);
});

test("re-attaching fences an earlier agent process but never takes the browser from a person", () => {
  const bumped = reattach(run, "loop-b", 5);
  assert.equal(bumped.generation, 2);
  assert.equal(mayAgentWrite(bumped, 2, "loop-b"), true);
  assert.equal(mayAgentWrite(bumped, 2, "loop-a"), false, "the earlier process is fenced out");

  const { run: held } = opened();
  const rejoined = reattach(held, "loop-b", 5);
  assert.equal(rejoined.owner, "human", "the person keeps the browser");
  assert.equal(rejoined.generation, held.generation);
  assert.equal(rejoined.holder, "loop-b", "but the new process is now the one that gets it back");
  assert.equal(openRequest(rejoined, { ...input, requestId: "q9", generation: rejoined.generation }, 6).ok, false);
});

test("a superseded loop cannot open a request", () => {
  const result = openRequest(reattach(run, "loop-b", 5), { ...input, generation: 2 }, 6);
  assert.equal(!result.ok && result.code, "superseded");
});

test("a restarted loop re-joins an open or unobserved request with the same key only", () => {
  const { run: held, request } = opened();
  assert.equal(reusableRequest(request, "sign-in"), request);
  assert.equal(reusableRequest(request, "other"), null);
  const back = handBack(held, request, { generation: 2, idempotencyKey: "k1", note: null }, 20);
  assert.ok(back.ok);
  assert.equal(reusableRequest(back.request, "sign-in"), back.request, "handed back but not yet observed");
  const observed = recordObservation(back.request, { url: "u", title: "t", snapshot: "s", observedAt: 30 });
  assert.equal(reusableRequest(observed, "sign-in"), null);
  assert.equal(recordObservation(must(observed, "observed request"), { url: "u2", title: "t", snapshot: "s", observedAt: 31 }), null, "recorded once");
});
