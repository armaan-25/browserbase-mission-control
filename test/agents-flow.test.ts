/**
 * The inbox against the SIMULATED Agents API, over real HTTP, with a real SQLite
 * file. Every "never resent" claim is checked against the simulator's own count
 * of resume calls, not against our state.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agentsApi } from "../inbox/api.ts";
import { matchLogin, memoryCredentials } from "../inbox/credentials.ts";
import { afterReply, savedLogins } from "../inbox/evidence.ts";
import { startFakeBrowserbase, type Step } from "../inbox/fake-browserbase.ts";
import type { Intervention } from "../inbox/intervention.ts";
import { resolvePause, startTakeover } from "../inbox/resolve.ts";
import { bucketOf } from "../inbox/server.ts";
import { openStore } from "../inbox/store.ts";
import { createSync } from "../inbox/sync.ts";
import { eventually, must, tempDb } from "./fixtures.ts";

const CLARIFY: Step[] = [
  { tool: "navigate", input: { url: "https://flights.test" }, page: { url: "https://flights.test", title: "Flights" } },
  { pause: "BOS or BED?" },
  { complete: "Booked." },
];
const TAKEOVER: Step[] = [
  {
    tool: "navigate",
    page: { url: "https://portal.test/verify", title: "Verify", challenge: { label: "Verify", then: { url: "https://portal.test/invoices", title: "Invoices" } } },
  },
  { pause: "Please complete verification in the browser." },
  { complete: "Downloaded." },
];

async function setup(options: { graceMs?: number; resumeTimeoutMs?: number; db?: string } = {}) {
  const fake = await startFakeBrowserbase({ stepMs: 10 });
  const db = options.db ?? tempDb();
  const store = openStore(db);
  const api = agentsApi({ apiKey: "test", baseUrl: fake.url, resumeTimeoutMs: options.resumeTimeoutMs ?? 2_000 });
  const sync = createSync({ store, api, discover: true, graceMs: options.graceMs ?? 200 });
  const deps = { store, api };
  return {
    fake,
    store,
    api,
    sync,
    deps,
    db,
    /** Poll until the run has an open pause; returns it. */
    async openPause(runId: string, skip = 0): Promise<Intervention> {
      let found: Intervention | undefined;
      await eventually(async () => {
        await sync.tick();
        found = store.interventionsForRun(runId).filter((i) => i.state === "open")[skip];
        return found !== undefined;
      });
      return must(found, "an open pause");
    },
    async settle(runId: string, check: () => boolean): Promise<void> {
      await eventually(async () => {
        await sync.syncRun(runId);
        return check();
      });
    },
    async close() {
      await fake.close();
      store.close();
    },
  };
}

test("clarification: answer in the inbox, the run resumes and completes", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "Book a flight", pauseWhen: "ambiguous", steps: CLARIFY });
  const pause = await h.openPause(runId);
  assert.equal(pause.message, "BOS or BED?");

  const result = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.ok(result.ok);
  assert.equal(result.intervention.state, "resumed");
  assert.equal(result.intervention.receipt, "accepted");
  await h.settle(runId, () => h.store.getRun(runId)?.status === "COMPLETED");
  assert.equal(h.fake.resumeCalls(runId), 1);
  assert.equal(h.store.pauseResult(runId, pause.pauseCallId) !== null, true, "the transcript records the reply");
});

test("takeover: a person acts in the browser and hands back; the agent is told where the page is now", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "Get the invoice", pauseWhen: "verification", steps: TAKEOVER });
  const pause = await h.openPause(runId);

  const took = startTakeover(h.deps, pause.id);
  assert.ok(took.ok && took.intervention.controller === "human");
  const live = must(await h.api.liveView(must(h.store.getRun(runId)?.sessionId, "session")), "live view");
  assert.equal(live.pages[0]?.title, "Verify");
  await fetch(`${live.url}/act`, { method: "POST" }); // the person clicks inside Live View

  const result = await resolvePause(h.deps, pause.id, { key: "k-1", type: "takeover", note: "verified" });
  assert.ok(result.ok && result.intervention.state === "resumed");
  const resolution = must(result.intervention.resolution, "resolution");
  assert.deepEqual(resolution.page, { url: "https://portal.test/invoices", title: "Invoices" });
  assert.match(resolution.sentTask, /They said: verified/);
  assert.match(resolution.sentTask, /"Invoices" at https:\/\/portal\.test\/invoices/);
  await h.settle(runId, () => h.store.getRun(runId)?.status === "COMPLETED");
});

test("a run that needs no help completes without a card", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "Read the status page", steps: [{ say: "reading" }, { complete: "done" }] });
  h.store.trackRun(runId, Date.now());
  await h.settle(runId, () => h.store.getRun(runId)?.status === "COMPLETED");
  assert.deepEqual(h.store.interventionsForRun(runId), []);
});

test("duplicate replies: same key replays, other keys are refused, concurrent clicks send one resume", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);

  const results = await Promise.all(
    ["tab-a", "tab-b", "tab-c"].map((key) => resolvePause(h.deps, pause.id, { key, type: "answer", text: `answer from ${key}`, secret: false })),
  );
  assert.equal(results.filter((r) => r.ok && !r.replay).length, 1, "exactly one attempt claimed the pause");
  assert.equal(h.fake.resumeCalls(runId), 1, "one resume reached Browserbase");

  const winner = must(results.find((r) => r.ok && !r.replay), "winner");
  const winnerKey = must(h.store.getIntervention(pause.id)?.attemptKey, "attempt key");
  const replay = await resolvePause(h.deps, pause.id, { key: winnerKey, type: "answer", text: "again", secret: false });
  assert.ok(replay.ok && replay.replay);
  assert.equal(h.fake.resumeCalls(runId), 1);
  assert.ok(winner.ok);
});

test("lost response after the resume took effect: checked, confirmed from the transcript, never resent", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.injectResumeFault("unknown_applied");

  const result = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS please", secret: false });
  assert.ok(result.ok && result.intervention.state === "outcome_unknown");
  await h.settle(runId, () => h.store.getIntervention(pause.id)?.state === "resumed");
  assert.equal(h.store.getIntervention(pause.id)?.receipt, "reply_seen");
  assert.equal(h.fake.resumeCalls(runId), 1);
});

test("no response at all (timeout) after the resume took effect: same outcome, no resend", async (t) => {
  const h = await setup({ resumeTimeoutMs: 300 });
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.injectResumeFault("hang_applied");

  const result = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.ok(result.ok && result.intervention.state === "outcome_unknown");
  assert.match(result.intervention.detail ?? "", /no response/);
  await h.settle(runId, () => h.store.getIntervention(pause.id)?.state === "resumed");
  assert.equal(h.fake.resumeCalls(runId), 1);
});

test("500 that did nothing: stays unknown through the grace period, reopens, and only a person sends again", async (t) => {
  const h = await setup({ graceMs: 300 });
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.injectResumeFault("unknown_not_applied");

  const first = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.ok(first.ok && first.intervention.state === "outcome_unknown");
  await h.sync.syncRun(runId);
  assert.equal(h.store.getIntervention(pause.id)?.state, "outcome_unknown", "inside the grace period");
  await h.settle(runId, () => h.store.getIntervention(pause.id)?.state === "open");
  assert.match(h.store.getIntervention(pause.id)?.detail ?? "", /nothing was resent/);
  assert.equal(h.fake.resumeCalls(runId), 1, "the inbox did not retry on its own");

  const second = await resolvePause(h.deps, pause.id, { key: "k-2", type: "answer", text: "BOS", secret: false });
  assert.ok(second.ok && second.intervention.state === "resumed");
  assert.equal(h.fake.resumeCalls(runId), 2);
});

test("503: definitely not applied, the card reopens with the reason", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.injectResumeFault("unavailable");
  const result = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.ok(result.ok && result.intervention.state === "open");
  assert.match(result.intervention.detail ?? "", /503/);
});

test("expired session: the card expires and a late reply is refused", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.expireSession(runId);
  await h.settle(runId, () => h.store.getIntervention(pause.id)?.state === "expired");
  const late = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.equal(!late.ok && late.code, "expired");
  assert.equal(h.fake.resumeCalls(runId), 0);
});

test("resumed elsewhere: the card is superseded and cannot send", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.resumeElsewhere(runId, "someone else's answer");
  await h.settle(runId, () => h.store.getIntervention(pause.id)?.state === "superseded");
  const late = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.equal(!late.ok && late.code, "superseded");
  assert.equal(h.fake.resumeCalls(runId), 0);
});

test("a second pause is a new card; the first card cannot answer it", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const steps: Step[] = [{ pause: "First question?" }, { pause: "Second question?" }, { complete: "done" }];
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps });
  const first = await h.openPause(runId);
  const answered = await resolvePause(h.deps, first.id, { key: "k-1", type: "answer", text: "one", secret: false });
  assert.ok(answered.ok);
  const second = await h.openPause(runId);
  assert.notEqual(second.id, first.id);
  assert.equal(second.message, "Second question?");

  const stale = await resolvePause(h.deps, first.id, { key: "k-old-tab", type: "answer", text: "two?", secret: false });
  assert.equal(!stale.ok && stale.code, "already_resolved");
  assert.equal(h.fake.resumeCalls(runId), 1);
});

test("restart: open pauses survive, and a resume in flight becomes 'checking', not open", async (t) => {
  const db = tempDb();
  const h = await setup({ db });
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);

  // Simulate a crash between claiming the pause and hearing back from Browserbase.
  h.store.tx(() => {
    const current = must(h.store.getIntervention(pause.id), "pause");
    h.store.saveIntervention({ ...current, state: "resuming", attemptKey: "k-1", attemptAt: Date.now(), attempts: 1 });
  });
  h.store.close();

  const reopened = openStore(db);
  try {
    const sync = createSync({ store: reopened, api: h.api, graceMs: 200 });
    sync.recover();
    assert.equal(reopened.getIntervention(pause.id)?.state, "outcome_unknown");
    assert.equal(reopened.getRun(runId)?.task, "t");
  } finally {
    reopened.close();
  }
  h.store.close = () => {};
});

test("secret answers are sent as variables and never stored", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  const result = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "481516", secret: true });
  assert.ok(result.ok && result.intervention.state === "resumed");
  assert.deepEqual(h.fake.receivedVariables(runId), ["human_reply"]);

  await h.settle(runId, () => h.store.getRun(runId)?.status === "COMPLETED");
  const everything = JSON.stringify([h.store.getIntervention(pause.id), h.store.events(runId), h.store.recentParts(runId, 100)]);
  assert.ok(!everything.includes("481516"), "the secret appears nowhere in the inbox's records");
});

test("wrong-pause race: the run moved to a new pause since the last poll, so the reply is not sent", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const steps: Step[] = [{ pause: "First question?" }, { pause: "Second question?" }, { complete: "done" }];
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps });
  const first = await h.openPause(runId);

  // Someone else answers the first pause and the run pauses again, before any poll.
  h.fake.resumeElsewhere(runId, "answered elsewhere");
  await eventually(async () => (await h.api.getRun(runId))?.status === "PAUSED" && (await h.api.listMessages(runId, null)).messages.length >= 3);

  const result = await resolvePause(h.deps, first.id, { key: "k-1", type: "answer", text: "meant for the first question", secret: false });
  assert.ok(result.ok);
  assert.equal(result.intervention.state, "open", "not sent; the next poll will supersede it");
  assert.match(result.intervention.detail ?? "", /nothing was sent/);
  assert.equal(h.fake.resumeCalls(runId), 0, "the reply never reached the second pause");
  await h.settle(runId, () => h.store.getIntervention(first.id)?.state === "superseded");
  const second = await h.openPause(runId);
  assert.equal(second.message, "Second question?");
});

// Regressions for issues found in review.

test("overlapping syncs of one run: an older read cannot overwrite a newer one and strand the run", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const steps: Step[] = [{ pause: "First question?" }, { pause: "Second question?" }, { complete: "done" }];
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps });
  const first = await h.openPause(runId);

  // Sync A reads the run while it is on the first pause, then stalls.
  let release = () => {};
  const stalled = new Promise<void>((resolve) => (release = resolve));
  const getSession = h.api.getSession;
  let calls = 0;
  (h.api as { getSession: typeof getSession }).getSession = async (id) => {
    calls += 1;
    if (calls === 1) await stalled;
    return getSession(id);
  };
  const syncA = h.sync.syncRun(runId);
  await eventually(() => calls === 1);

  // Meanwhile the run is answered elsewhere and pauses again; sync B is requested.
  h.fake.resumeElsewhere(runId, "answered elsewhere");
  await eventually(async () => (await h.api.listMessages(runId, null)).messages.length >= 3);
  const syncB = h.sync.syncRun(runId);
  // Let B finish first if it can (the dangerous order), or give it time if it is
  // correctly queued behind A. Then let A's older read complete.
  await Promise.race([syncB, new Promise((resolve) => setTimeout(resolve, 300))]);
  release();
  await Promise.all([syncA, syncB]);

  assert.equal(h.store.getIntervention(first.id)?.state, "superseded");
  const open = h.store.interventionsForRun(runId).filter((i) => i.state === "open");
  assert.equal(open.length, 1, "the second pause has an open card");
  assert.equal(open[0]?.message, "Second question?");
});

test("resending a key after its card reopened sends nothing", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.injectResumeFault("unavailable");
  const first = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.ok(first.ok && first.intervention.state === "open");
  const resent = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: "BOS", secret: false });
  assert.ok(resent.ok && resent.replay);
  assert.equal(h.fake.resumeCalls(runId), 1);
});

test("a long reply that landed is confirmed, not called a different reply", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "t", pauseWhen: "p", steps: CLARIFY });
  const pause = await h.openPause(runId);
  h.fake.injectResumeFault("unknown_applied");
  const long = "word ".repeat(500) + "end";
  const result = await resolvePause(h.deps, pause.id, { key: "k-1", type: "answer", text: long, secret: false });
  assert.ok(result.ok && result.intervention.state === "outcome_unknown");
  await h.settle(runId, () => h.store.getIntervention(pause.id)?.state !== "outcome_unknown");
  assert.equal(h.store.getIntervention(pause.id)?.state, "resumed");
  assert.equal(h.store.getIntervention(pause.id)?.receipt, "reply_seen");
});

test("a run id Browserbase does not know is marked missing, not shown as running", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  h.store.trackRun("no-such-run", Date.now());
  assert.equal(h.store.getRun("no-such-run")?.status, null, "no status is invented");
  await h.sync.syncRun("no-such-run");
  const run = must(h.store.getRun("no-such-run"), "run");
  assert.equal(run.missing, true);
  assert.equal(run.status, null);
});

test("the pause is found even when it is not the last message", (t) => {
  const store = openStore(tempDb());
  t.after(() => store.close());
  store.appendMessages(
    "r",
    [
      { id: "m1", createdAt: 1, role: "assistant", parts: [{ type: "tool-call", text: null, toolName: "pause", toolCallId: "toolu_a", payload: '{"message":"a?"}' }] },
      { id: "m2", createdAt: 2, role: "assistant", parts: [{ type: "text", text: "waiting for a reply", toolName: null, toolCallId: null, payload: null }] },
    ],
    (s) => s,
  );
  assert.equal(store.unansweredPause("r")?.callId, "toolu_a");
  store.appendMessages("r", [{ id: "m3", createdAt: 3, role: "tool", parts: [{ type: "tool-result", text: null, toolName: "pause", toolCallId: "toolu_a", payload: '"ok"' }] }], (s) => s);
  assert.equal(store.unansweredPause("r"), null, "answered pauses are not waited on");
});

// Help once, never again: a sign-in done during a takeover is saved to a
// Browserbase Context, so the next run with that context starts signed in.
const SIGN_IN: Step[] = [
  {
    tool: "navigate",
    page: {
      url: "https://portal.test/login",
      title: "Sign in",
      challenge: { label: "Sign in", signsIn: "portal.test", then: { url: "https://portal.test/invoices", title: "Invoices" } },
    },
  },
  { pause: "Please sign in, then hand it back.", onlyIfChallenged: true },
  { complete: "Downloaded." },
];

/** Run 1 pauses for sign-in and a person does it; returns run 2's id, started with the same context. */
async function signInOnceThenRerun(h: Awaited<ReturnType<typeof setup>>, persist: boolean): Promise<string> {
  const context = await h.api.createContext("portal.test");
  h.fake.nextScript(SIGN_IN);
  const first = await h.api.createRun({ task: "Get the invoice", pauseWhen: "sign-in is needed", context: { id: context.id, persist } });
  const pause = await h.openPause(first.runId);
  assert.ok(startTakeover(h.deps, pause.id).ok);
  const live = must(await h.api.liveView(must(first.sessionId, "session")), "live view");
  await fetch(`${live.url}/act`, { method: "POST" }); // the person signs in inside Live View
  assert.ok((await resolvePause(h.deps, pause.id, { key: "k-1", type: "takeover", note: "signed in" })).ok);
  await h.settle(first.runId, () => h.store.getRun(first.runId)?.status === "COMPLETED");

  h.fake.nextScript(SIGN_IN);
  const second = await h.api.createRun({ task: "Get the invoice", pauseWhen: "sign-in is needed", context: { id: context.id, persist } });
  h.store.trackRun(second.runId, Date.now());
  return second.runId;
}

test("help once, never again: with a persisted context the next run starts signed in and never pauses", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const second = await signInOnceThenRerun(h, true);
  await h.settle(second, () => h.store.getRun(second)?.status === "COMPLETED");
  assert.deepEqual(h.store.interventionsForRun(second), [], "no card: nobody was asked again");

  // The inbox learns the shared Context from Browserbase's session record, not from the launcher.
  const [story, ...others] = savedLogins(h.store.listRuns(), (id) => h.store.interventionsForRun(id));
  assert.equal(others.length, 0);
  assert.ok(story?.contextId);
  assert.deepEqual(story.runs.map((r) => r.helped), ["takeover", null]);
  assert.equal(story.laterWithoutHelp, 1);
  const help = must(h.store.interventionsForRun(story.runs[0]?.runId ?? "")[0], "run 1's pause");
  assert.deepEqual(afterReply(h.store.recentParts(help.runId, 200), help.pauseCallId), { steps: [], typed: false }, "the person signed in, the agent typed nothing");
});

test("without persist, the same context forgets the sign-in and the next run pauses again", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const second = await signInOnceThenRerun(h, false);
  const pause = await h.openPause(second);
  assert.equal(pause.message, "Please sign in, then hand it back.");
});

test("runs recorded before Contexts were tracked learn their Context once, from their session", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const second = await signInOnceThenRerun(h, true);
  await h.settle(second, () => h.store.getRun(second)?.status === "COMPLETED");
  const contextId = must(h.store.getRun(second)?.contextId, "context from the session");
  // An inbox.db row written before `context_id` existed.
  const raw = new DatabaseSync(h.db);
  raw.exec("UPDATE runs SET context_id = NULL");
  raw.close();
  assert.equal(h.store.getRun(second)?.contextId, null);

  await h.sync.backfillContexts();
  assert.equal(h.store.getRun(second)?.contextId, contextId);
});

test("a paused run whose browser has ended is expired, not waiting, though Browserbase still says PAUSED", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const runId = h.fake.startRun({ task: "Get the invoice", pauseWhen: "verification", steps: TAKEOVER });
  await h.openPause(runId);
  h.fake.expireSession(runId);
  await h.settle(runId, () => h.store.interventionsForRun(runId)[0]?.state === "expired");
  const run = must(h.store.getRun(runId), "run");
  assert.equal(run.status, "PAUSED", "as seen live: the run still reports PAUSED");
  assert.equal(bucketOf(run, h.store.interventionsForRun(runId)), "expired");
});

test("at scale: 40 runs with network latency are all found, carded and counted, and a tick checks them in parallel", { timeout: 60_000 }, async (t) => {
  const fake = await startFakeBrowserbase({ stepMs: 10, latencyMs: 40 });
  const store = openStore(tempDb());
  const api = agentsApi({ apiKey: "test", baseUrl: fake.url });
  const sync = createSync({ store, api, discover: true, concurrency: 8 });
  t.after(async () => {
    await fake.close();
    store.close();
  });
  const ids = Array.from({ length: 40 }, (_, i) =>
    fake.startRun({ task: `task ${i}`, pauseWhen: "p", steps: i % 2 ? CLARIFY : [{ tool: "extract" }, { tool: "extract" }, { complete: "done" }] }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the scripts reach their pauses or finish

  const started = Date.now();
  await sync.tick();
  const tickMs = Date.now() - started;
  // Each run needs 2–3 reads of 40 ms; one at a time that is ~4 s, eight at a time well under 2 s.
  assert.ok(tickMs < 2_000, `tick took ${tickMs} ms`);

  await eventually(async () => {
    await sync.tick();
    return ids.every((id) => store.getRun(id)?.status === "PAUSED" || store.getRun(id)?.status === "COMPLETED");
  }, 10_000);
  const pauses = store.interventionsByRun();
  assert.equal(ids.filter((_, i) => i % 2).every((id) => pauses.get(id)?.length === 1), true, "every paused run has one card");
  assert.equal(ids.filter((_, i) => i % 2 === 0).every((id) => !pauses.has(id)), true, "runs that never paused have none");
  const steps = store.stepCounts();
  assert.equal(steps.get(must(ids[0], "run")), 2, "tool calls counted, pause excluded");
  assert.equal(steps.get(must(ids[1], "run")), 1);
});

test("the proof read starts at the reply: parts before a pause's result are not included", (t) => {
  const store = openStore(tempDb());
  t.after(() => store.close());
  const part = (kind: string, toolName: string | null, toolCallId: string | null) => ({ type: kind, text: null, toolName, toolCallId, payload: "{}" });
  store.appendMessages(
    "r",
    [
      { id: "m1", createdAt: 1, role: "assistant", parts: [part("tool-call", "type", "early")] },
      { id: "m2", createdAt: 2, role: "assistant", parts: [part("tool-call", "pause", "p")] },
      { id: "m3", createdAt: 3, role: "tool", parts: [part("tool-result", "pause", "p")] },
      { id: "m4", createdAt: 4, role: "assistant", parts: [part("tool-call", "snapshot", "s")] },
    ],
    (s) => s,
  );
  assert.deepEqual(afterReply(store.partsFromPauseResult("r", "p", 60), "p"), { steps: ["snapshot"], typed: false }, "the typing before the pause does not count");
  assert.deepEqual(store.partsFromPauseResult("r", "unanswered", 60), []);
});

test("saved login: the password reaches Browserbase only as a variable and is never stored", async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const PASSWORD = "S3cret-Value-!9";
  const deps = { ...h.deps, credentials: memoryCredentials([{ site: "portal.test", username: "armaan", password: PASSWORD }]) };
  const runId = h.fake.startRun({ task: "Get the invoice from https://portal.test", pauseWhen: "sign-in", steps: TAKEOVER });
  const pause = await h.openPause(runId);

  const missing = await resolvePause(deps, pause.id, { key: "k-missing-1", type: "credentials", site: "other.test" });
  assert.equal(missing.ok, false, "no saved login for that site: nothing is sent");
  assert.equal(h.fake.resumeCalls(runId), 0);

  const result = await resolvePause(deps, pause.id, { key: "k-cred-1", type: "credentials", site: "portal.test" });
  assert.ok(result.ok && result.intervention.state === "resumed");
  assert.deepEqual([...h.fake.receivedVariables(runId)].sort(), ["login_password", "login_username"]);
  const resolution = must(result.intervention.resolution, "resolution");
  assert.match(resolution.sentTask, /%login_password%/);
  assert.equal(resolution.summary, "used the saved login for portal.test (armaan)");

  await h.settle(runId, () => h.store.getRun(runId)?.status === "COMPLETED");
  const raw = new DatabaseSync(h.db, { readOnly: true });
  const tables = ["runs", "messages", "interventions", "events"];
  const leaked = tables.filter((table) => {
    const columns = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    const where = columns.map((c) => `instr(CAST(${c} AS TEXT), ?) > 0`).join(" OR ");
    return (raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...columns.map(() => PASSWORD)) as { n: number }).n > 0;
  });
  raw.close();
  assert.deepEqual(leaked, [], "the password is in no table");
});

test("saved login matching: by the site in the question, task or steps, including subdomains", () => {
  const saved = [{ site: "portal.test", username: "a" }, { site: "acme.com", username: "b" }];
  assert.equal(matchLogin(saved, ["I'm stuck at https://login.acme.com/sso"])?.site, "acme.com");
  assert.equal(matchLogin(saved, ["", "Download the invoice from portal.test"])?.site, "portal.test");
  assert.equal(matchLogin(saved, ["Which airport, BOS or BED?"]), null);
  assert.equal(matchLogin(saved, ["see notacme.com"]), null, "a different site that merely ends in the same letters does not match");
});
