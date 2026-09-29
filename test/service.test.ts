/** The service over real HTTP, with a real SQLite file. */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { eventually, fakeBrowserbase, json, must, post, start, tempDb } from "./fixtures.ts";

async function openOne(base: string, runId = "run-1") {
  const attached = await json(await post(base, "/api/runs", { runId, sessionId: "sess-1", holder: "loop-1" }));
  const generation = (attached.body.run as { generation: number }).generation;
  const opened = await json(
    await post(base, `/api/runs/${runId}/requests`, {
      key: "sign-in",
      kind: "takeover",
      reason: "Sign in",
      context: { url: "https://x.test", title: "X" },
      generation,
      holder: "loop-1",
    }),
  );
  assert.equal(opened.status, 201);
  return opened.body.request as { requestId: string; generation: number };
}

test("double hand-back: the second click with a new key is refused, ownership moves once", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const req = await openOne(s.service.url);
  const first = await json(await post(s.service.url, `/api/requests/${req.requestId}/handback`, { generation: req.generation, idempotencyKey: "a" }));
  const second = await json(await post(s.service.url, `/api/requests/${req.requestId}/handback`, { generation: req.generation, idempotencyKey: "b" }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "already_handed_back");
  const run = must(s.store.getRun("run-1"), "run");
  assert.equal(run.owner, "agent");
  assert.equal(run.generation, req.generation + 1);
  assert.equal(s.store.events("run-1").filter((e) => e.type === "request.handed_back").length, 1);
});

test("concurrent hand-backs from two tabs: exactly one wins", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const req = await openOne(s.service.url);
  const results = await Promise.all(
    ["tab-a", "tab-b", "tab-c"].map(async (key) =>
      json(await post(s.service.url, `/api/requests/${req.requestId}/handback`, { generation: req.generation, idempotencyKey: key })),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(must(s.store.getRun("run-1"), "run").generation, req.generation + 1);
});

test("stale hand-back: a card for an earlier request cannot hand back the current one", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const a = await openOne(s.service.url);
  await post(s.service.url, `/api/requests/${a.requestId}/handback`, { generation: a.generation, idempotencyKey: "a" });
  const b = await json(
    await post(s.service.url, "/api/runs/run-1/requests", {
      key: "second-question",
      kind: "answer",
      reason: "Which plan?",
      context: {},
      generation: a.generation + 1,
      holder: "loop-1",
    }),
  );
  assert.equal(b.status, 201);
  const late = await json(await post(s.service.url, `/api/requests/${a.requestId}/handback`, { generation: a.generation, idempotencyKey: "old-tab" }));
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "stale");
  assert.equal(must(s.store.getRun("run-1"), "run").owner, "human", "request B is still with the person");
});

test("lost hand-back response: resending the same key returns the original result", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const req = await openOne(s.service.url);
  // Send the hand-back and drop the connection before reading the answer.
  await new Promise<void>((resolve) => {
    const body = JSON.stringify({ generation: req.generation, idempotencyKey: "same-click" });
    const r = httpRequest(`${s.service.url}/api/requests/${req.requestId}/handback`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    r.on("response", (res) => {
      res.destroy();
      resolve();
    });
    r.on("error", () => resolve());
    r.end(body);
  });
  await eventually(() => must(s.store.getRequest(req.requestId), "request").state === "handed_back");
  const resend = await json(await post(s.service.url, `/api/requests/${req.requestId}/handback`, { generation: req.generation, idempotencyKey: "same-click" }));
  assert.equal(resend.status, 200);
  assert.equal(resend.body.replay, true);
  assert.equal(must(s.store.getRun("run-1"), "run").generation, req.generation + 1, "no second transition");
});

test("restart: an open request and its owner survive the service stopping", async () => {
  const db = tempDb();
  const first = await start(db);
  const req = await openOne(first.service.url);
  await first.stop();

  const second = await start(db);
  try {
    const got = await json(await fetch(`${second.service.url}/api/requests/${req.requestId}`));
    assert.equal((got.body.request as { state: string }).state, "open");
    assert.equal((got.body.run as { owner: string }).owner, "human");
    const back = await json(await post(second.service.url, `/api/requests/${req.requestId}/handback`, { generation: req.generation, idempotencyKey: "k" }));
    assert.equal(back.status, 200);
  } finally {
    await second.stop();
  }
});

test("expiry: an ended session stops the run and the request can no longer be handed back", async (t) => {
  const bb = fakeBrowserbase("alive");
  const s = await start(tempDb(), { browserbase: bb.api, expiryCheckMs: 20 });
  t.after(() => s.stop());
  const req = await openOne(s.service.url);
  bb.set("unknown");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(must(s.store.getRun("run-1"), "run").owner, "human", "'unknown' liveness changes nothing");
  bb.set("ended");
  await eventually(() => must(s.store.getRun("run-1"), "run").owner === "stopped");
  assert.equal(must(s.store.getRequest(req.requestId), "request").state, "expired");
  const late = await json(await post(s.service.url, `/api/requests/${req.requestId}/handback`, { generation: req.generation, idempotencyKey: "k" }));
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "expired");
});

test("Live View URL is handed out only while the request is open", async (t) => {
  const bb = fakeBrowserbase("alive");
  const s = await start(tempDb(), { browserbase: bb.api });
  t.after(() => s.stop());
  const req = await openOne(s.service.url);
  const open = await json(await fetch(`${s.service.url}/api/requests/${req.requestId}/live`));
  assert.equal(open.body.url, "https://live.example.test/view");
  await post(s.service.url, `/api/requests/${req.requestId}/handback`, { generation: req.generation, idempotencyKey: "k" });
  const after = await json(await fetch(`${s.service.url}/api/requests/${req.requestId}/live`));
  assert.equal(after.body.url, null);
});

test("refuses foreign Host headers and cross-origin POSTs", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const hostStatus = await new Promise<number>((resolve, reject) => {
    const r = httpRequest(`${s.service.url}/api/inbox`, { headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });
  assert.equal(hostStatus, 421);
  const cross = await fetch(`${s.service.url}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ runId: "x", holder: "h" }),
  });
  assert.equal(cross.status, 403);
});

test("notes are redacted before they are stored", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const req = await openOne(s.service.url);
  await post(s.service.url, `/api/requests/${req.requestId}/handback`, {
    generation: req.generation,
    idempotencyKey: "k",
    note: "entered code 482913 and key bb_live_abcdefghijkl",
  });
  const note = must(s.store.getRequest(req.requestId), "request").note ?? "";
  assert.ok(!note.includes("482913"));
  assert.ok(!note.includes("bb_live_abcdefghijkl"));
});
