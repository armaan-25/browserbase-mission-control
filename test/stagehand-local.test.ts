/**
 * The guard against the real Stagehand v4 classes, on local headless Chrome.
 *
 * The other tests use a stand-in. This one checks that wrapping Stagehand's own
 * `Page`, `Locator` and `Stagehand` objects in the guard still works (getters,
 * private members, `this` binding), and that a refused write really does not
 * reach the browser. No model and no Browserbase: free.
 *
 * The person is played by the raw, unguarded page, the way Live View input
 * reaches the browser without passing through the agent.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { attachHandoff, OwnershipError } from "../handoff/client.ts";
import { eventually, must, post, start } from "./fixtures.ts";

const PAGES: Record<string, string> = {
  "/login": `<title>Login</title><form><input id="user"><button id="go" type="button"
      onclick="location.href='/inventory'">Sign in</button></form>`,
  "/inventory": `<title>Products</title><p id="count">0</p><button id="add"
      onclick="var c=document.getElementById('count');c.textContent=String(Number(c.textContent)+1)">Add</button>`,
  "/elsewhere": `<title>Elsewhere</title>`,
};

test("real Stagehand: guarded writes are refused during a handoff and work after it", { timeout: 60_000 }, async (t) => {
  const site = createServer((req, res) => {
    res.writeHead(PAGES[req.url ?? ""] ? 200 : 404, { "content-type": "text/html" });
    res.end(PAGES[req.url ?? ""] ?? "not found");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${address.port}`;

  const s = await start();
  const browser = await localBrowser.launch({ headless: true });
  const stagehand = await Stagehand.create({ browser });
  t.after(async () => {
    await stagehand.close().catch(() => {});
    await browser.close().catch(() => {});
    await s.stop();
    site.close();
  });
  const page = (await browser.context.pages())[0] ?? (await browser.context.newPage());
  const h = await attachHandoff({ stagehand, page, serviceUrl: s.service.url, runId: "local" });

  await h.page.goto(`${origin}/login`);
  assert.equal(await h.page.title(), "Login");

  const reply = h.requestHuman({ kind: "takeover", reason: "Sign in" });
  await eventually(() => s.store.getRun("local")?.owner === "human");

  // The agent tries to act while the person holds the browser.
  await assert.rejects(h.page.goto(`${origin}/elsewhere`), OwnershipError);
  await assert.rejects(h.page.locator("#go").click(), OwnershipError);
  await assert.rejects(h.stagehand.act("click sign in"), OwnershipError);
  assert.equal(await page.url(), `${origin}/login`, "the refused navigation never happened");

  // The person signs in through the unguarded path (as Live View would).
  await page.locator("#go").click();
  await eventually(async () => (await page.url()) === `${origin}/inventory`);

  const run = must(s.store.getRun("local"), "run");
  await post(s.service.url, `/api/requests/${run.currentRequestId}/handback`, {
    generation: run.generation,
    idempotencyKey: "k",
    note: "signed in",
  });
  const result = await reply;
  assert.equal(result.observation.url, `${origin}/inventory`);
  assert.equal(result.observation.title, "Products");
  assert.match(result.observation.snapshot, /Add/);

  await h.page.locator("#add").click();
  assert.equal(await h.page.locator("#count").textContent(), "1");
  h.detach();
});
