/** The developer-side wrapper against a running service. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachHandoff, OwnershipError, SessionEndedError, UncertainStepError } from "../handoff/client.ts";
import { eventually, fakeAgent, fakeBrowserbase, must, post, start, tempDb } from "./fixtures.ts";

type Open = { requestId: string; generation: number };

/** The open request for `runId`, once the agent has asked. */
async function waitForOpen(s: Awaited<ReturnType<typeof start>>, runId: string): Promise<Open> {
  let found: Open | null = null;
  await eventually(() => {
    const run = s.store.getRun(runId);
    const request = run?.currentRequestId ? s.store.getRequest(run.currentRequestId) : null;
    if (request?.state === "open") found = { requestId: request.requestId, generation: request.generation };
    return found !== null;
  });
  return found as unknown as Open;
}

test("complete handoff: agent asks, person acts and hands back, agent sees the new page", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });

  await h.page.goto("https://store.example.test/login");
  const reply = h.requestHuman({ kind: "takeover", reason: "Sign in", key: "sign-in" });
  const open = await waitForOpen(s, "r");

  agent.humanNavigates("https://store.example.test/inventory", "Products"); // the person, in Live View
  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k", note: "signed in" });

  const result = await reply;
  assert.equal(result.note, "signed in");
  assert.equal(result.observation.url, "https://store.example.test/inventory");
  assert.match(result.observation.snapshot, /Products/);
  await h.page.locator("#add").click();
  assert.deepEqual(agent.writes, ["goto https://store.example.test/login", "click #add"]);
  await eventually(() => must(s.store.getRequest(open.requestId), "request").observation?.url === "https://store.example.test/inventory");
  h.detach();
});

test("blocked agent: every write is refused while a person holds the browser; reads still work", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  const reply = h.requestHuman({ kind: "takeover", reason: "Sign in" });
  const open = await waitForOpen(s, "r");

  const attempts: Array<[string, () => Promise<unknown>]> = [
    ["page.goto", () => h.page.goto("https://elsewhere.test")],
    ["page.reload", () => h.page.reload()],
    ["page.goBack", () => h.page.goBack()],
    ["page.click", () => h.page.click(1, 1)],
    ["page.type", () => h.page.type("x")],
    ["page.keyPress", () => h.page.keyPress("Enter")],
    ["page.scroll", () => h.page.scroll()],
    ["page.evaluate", () => h.page.evaluate()],
    ["page.setViewportSize", () => h.page.setViewportSize()],
    ["page.close", () => h.page.close()],
    ["locator.click", () => h.page.locator("#a").click()],
    ["locator.fill", () => h.page.locator("#a").fill("v")],
    ["locator.first.type", () => h.page.locator("#a").first().type("v")],
    ["stagehand.act", () => h.stagehand.act("click submit")],
    ["stagehand.observe", () => h.stagehand.observe()],
    ["stagehand.extract", () => h.stagehand.extract()],
  ];
  for (const [label, attempt] of attempts) {
    await assert.rejects(attempt(), OwnershipError, `${label} should be refused`);
  }
  assert.deepEqual(agent.writes, [], "no write reached the browser");

  assert.equal(await h.page.url(), "https://store.example.test/login");
  assert.equal(await h.page.locator("#a").textContent(), "1");

  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k" });
  await reply;
  await h.page.goto("https://after.test");
  assert.deepEqual(agent.writes, ["goto https://after.test"]);
  h.detach();
});

test("in-flight: requestHuman waits for a running step to finish before the person gets the browser", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  let finishStep = () => {};
  const events: string[] = [];
  agent.stagehand.act = async () => {
    await new Promise<void>((resolve) => (finishStep = resolve));
    events.push("step finished");
  };
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });

  const step = h.stagehand.act("slow step");
  await eventually(() => h.phase === "agent" && typeof finishStep === "function");
  await new Promise((resolve) => setTimeout(resolve, 50)); // the step is now running
  const reply = h.requestHuman({ kind: "takeover", reason: "help" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(must(s.store.getRun("r"), "run").owner, "agent", "not handed over while the step runs");
  await assert.rejects(h.page.goto("https://new-write.test"), OwnershipError, "new writes are refused during hand-over");

  finishStep();
  await step;
  const open = await waitForOpen(s, "r");
  events.push("request opened");
  assert.deepEqual(events, ["step finished", "request opened"]);
  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k" });
  await reply;
  h.detach();
});

test("uncertain step: a step that timed out on the client blocks the handoff until cleared", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  agent.stagehand.act = async () => {
    throw new Error("RPC response timed out: stagehand.act");
  };
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  await assert.rejects(h.stagehand.act("x"), /timed out/);
  await assert.rejects(h.requestHuman({ kind: "takeover", reason: "help" }), UncertainStepError);
  assert.equal(must(s.store.getRun("r"), "run").owner, "agent", "no request was opened");

  // An ordinary failure (element not found) is not uncertain.
  h.clearUncertainStep();
  agent.stagehand.act = async () => {
    throw new Error("Could not find an element for the given xPath(s)");
  };
  await assert.rejects(h.stagehand.act("y"));
  const reply = h.requestHuman({ kind: "takeover", reason: "help" });
  const open = await waitForOpen(s, "r");
  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k" });
  await reply;
  h.detach();
});

test("loop restart: the new loop re-joins the same request, and the old loop is fenced out", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  const first = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  void first.requestHuman({ kind: "takeover", reason: "Sign in", key: "sign-in" }).catch(() => {});
  const open = await waitForOpen(s, "r");

  // The loop process "restarts": a second attach for the same run.
  const second = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  assert.equal(second.phase, "human", "re-attaching does not take the browser back");
  await assert.rejects(second.page.goto("https://x.test"), OwnershipError);
  const reply = second.requestHuman({ kind: "takeover", reason: "Sign in", key: "sign-in" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(must(s.store.getRun("r"), "run").currentRequestId, open.requestId, "no second request was created");

  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k" });
  await reply;
  assert.equal(second.phase, "agent");

  // The zombie: the first process still holds its old handle.
  first.detach();
  const zombie = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" }); // a third attach bumps the generation
  await assert.rejects(second.page.goto("https://stale-writer.test"), OwnershipError, "the older loop is fenced out");
  await zombie.page.goto("https://current-writer.test");
  assert.deepEqual(agent.writes, ["goto https://current-writer.test"]);
  second.detach();
  zombie.detach();
});

test("loop restart after hand-back but before the agent looked: the outcome is delivered, not asked again", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  const first = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  void first.requestHuman({ kind: "takeover", reason: "Sign in", key: "sign-in" }).catch(() => {});
  const open = await waitForOpen(s, "r");
  first.detach(); // dies before the hand-back arrives
  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k", note: "done" });

  const second = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  const reply = await second.requestHuman({ kind: "takeover", reason: "Sign in", key: "sign-in" });
  assert.equal(reply.requestId, open.requestId);
  assert.equal(reply.note, "done");
  await second.page.goto("https://next.test");
  assert.deepEqual(agent.writes, ["goto https://next.test"]);
  second.detach();
});

test("service restart while the agent waits: the wait survives and the hand-back is delivered", async () => {
  const db = tempDb();
  const first = await start(db);
  const port = first.service.port;
  const agent = fakeAgent();
  const h = await attachHandoff({ ...agent, serviceUrl: first.service.url, runId: "r" });
  const reply = h.requestHuman({ kind: "takeover", reason: "help" });
  const open = await waitForOpen(first, "r");
  await first.stop();

  const second = await start(db, { port });
  try {
    // fetch may reuse a pooled socket to the stopped server and get ECONNRESET.
    // Resending with the same key is safe, which is what the inbox page does too.
    const handBack = () => post(second.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k" });
    await handBack().catch(handBack);
    const result = await reply;
    assert.equal(result.requestId, open.requestId);
  } finally {
    h.detach();
    await second.stop();
  }
});

test("service unreachable: writes are refused rather than guessed", async () => {
  const s = await start();
  const agent = fakeAgent();
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  await s.stop();
  await assert.rejects(h.page.goto("https://x.test"), OwnershipError);
  assert.deepEqual(agent.writes, []);
  h.detach();
});

test("expiry: the session ending while a person holds it stops the agent instead of resuming it", async (t) => {
  const bb = fakeBrowserbase("alive");
  const s = await start(tempDb(), { browserbase: bb.api, expiryCheckMs: 20 });
  t.after(() => s.stop());
  const agent = fakeAgent();
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r", sessionId: "sess" });
  const reply = h.requestHuman({ kind: "takeover", reason: "help" });
  await waitForOpen(s, "r");
  bb.set("ended");
  await assert.rejects(reply, SessionEndedError);
  assert.equal(h.phase, "stopped");
  await assert.rejects(h.page.goto("https://x.test"), OwnershipError);
  await assert.rejects(attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" }), SessionEndedError);
  assert.deepEqual(agent.writes, []);
  h.detach();
});

// Regressions for issues found in review.

test("restart during a handoff: after the hand-back only the newest loop can write", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agentA = fakeAgent();
  const agentB = fakeAgent();
  const a = await attachHandoff({ ...agentA, serviceUrl: s.service.url, runId: "r" });
  const replyA = a.requestHuman({ kind: "takeover", reason: "Sign in", key: "k" });
  const open = await waitForOpen(s, "r");

  // Loop B attaches (a restart) while the person holds the browser, and re-joins.
  const b = await attachHandoff({ ...agentB, serviceUrl: s.service.url, runId: "r" });
  const replyB = b.requestHuman({ kind: "takeover", reason: "Sign in", key: "k" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "x" });
  await assert.rejects(replyA, OwnershipError, "the older loop is told it was superseded");
  await replyB;
  await assert.rejects(a.page.goto("https://zombie.test"), OwnershipError);
  await b.page.goto("https://new.test");
  assert.deepEqual(agentA.writes, []);
  assert.deepEqual(agentB.writes, ["goto https://new.test"]);
  a.detach();
  b.detach();
});

test("methods that return handles the guard cannot follow are refused", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  const page = { ...agent.page, tools: async () => [{ invoke: async () => agent.writes.push("tool") }] };
  const stagehand = { ...agent.stagehand, experimentalBatch: async () => agent.writes.push("batch") };
  const h = await attachHandoff({ stagehand, page, serviceUrl: s.service.url, runId: "r" });
  await assert.rejects(h.page.tools(), OwnershipError);
  await assert.rejects(h.stagehand.experimentalBatch(), OwnershipError);
  assert.deepEqual(agent.writes, []);
  h.detach();
});

test("the observation is taken before the agent may write again", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  let releaseSnapshot = () => {};
  const snapshotStarted = new Promise<void>((started) => {
    const original = agent.page.snapshot;
    agent.page.snapshot = async () => {
      started();
      await new Promise<void>((resolve) => (releaseSnapshot = resolve));
      return original();
    };
  });
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  const reply = h.requestHuman({ kind: "takeover", reason: "help" });
  const open = await waitForOpen(s, "r");
  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k" });

  await snapshotStarted;
  await assert.rejects(h.page.goto("https://too-early.test"), OwnershipError, "no write while the agent is still looking");
  releaseSnapshot();
  await reply;
  await h.page.goto("https://after.test");
  assert.deepEqual(agent.writes, ["goto https://after.test"]);
  h.detach();
});

test("receipt not recorded: requestHuman fails, and asking again with the same key collects it", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const agent = fakeAgent();
  const h = await attachHandoff({ ...agent, serviceUrl: s.service.url, runId: "r" });
  const reply = h.requestHuman({ kind: "takeover", reason: "help", key: "k" });
  const open = await waitForOpen(s, "r");

  const record = s.store.recordObservation;
  s.store.recordObservation = () => {
    throw new Error("disk full");
  };
  await post(s.service.url, `/api/requests/${open.requestId}/handback`, { generation: open.generation, idempotencyKey: "k" });
  await assert.rejects(reply, OwnershipError);
  await assert.rejects(h.page.goto("https://x.test"), OwnershipError, "no writes until the outcome is collected");

  s.store.recordObservation = record;
  const again = await h.requestHuman({ kind: "takeover", reason: "help", key: "k" });
  assert.equal(again.requestId, open.requestId, "the same request, not a new one");
  assert.ok(must(s.store.getRequest(open.requestId), "request").observation);
  await h.page.goto("https://next.test");
  assert.deepEqual(agent.writes, ["goto https://next.test"]);
  h.detach();
});
