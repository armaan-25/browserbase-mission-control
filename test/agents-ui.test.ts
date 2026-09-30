/**
 * The agent inbox page in a real browser, against the SIMULATED Agents API:
 * what a person sees and clicks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { agentsApi } from "../inbox/api.ts";
import { memoryCredentials } from "../inbox/credentials.ts";
import { startFakeBrowserbase } from "../inbox/fake-browserbase.ts";
import { startInboxServer } from "../inbox/server.ts";
import { openStore } from "../inbox/store.ts";
import { createSync } from "../inbox/sync.ts";
import { eventually, tempDb } from "./fixtures.ts";

test("mission control: answer with a double-click, refresh, and take over through Live View", { timeout: 90_000 }, async (t) => {
  const fake = await startFakeBrowserbase({ stepMs: 20 });
  const store = openStore(tempDb());
  const api = agentsApi({ apiKey: "test", baseUrl: fake.url });
  const sync = createSync({ store, api, discover: true, graceMs: 500 });
  const inbox = await startInboxServer({ store, api, sync, simulated: true });
  sync.start(200);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await sync.stop();
    await inbox.close();
    await fake.close();
    store.close();
  });

  const clarify = fake.startRun({
    task: "Book a flight to Boston",
    pauseWhen: "ambiguous",
    steps: [{ tool: "navigate", input: { url: "https://flights.test" } }, { pause: "BOS or BED?" }, { complete: "Booked." }],
  });
  const takeover = fake.startRun({
    task: "Download the October invoice",
    pauseWhen: "verification",
    steps: [
      {
        tool: "navigate",
        page: { url: "https://portal.test/verify", title: "Verify", challenge: { label: "Complete verification", then: { url: "https://portal.test/invoices", title: "Invoices" } } },
      },
      { pause: "Please finish verification in the browser." },
      { complete: "Downloaded." },
    ],
  });

  const page = await browser.newPage();
  await page.goto(inbox.url);
  await page.getByText("Simulated runs. Nothing on this page reaches Browserbase.").waitFor();

  // The wall: a paused run's tile turns "stuck" and shows the agent's own question.
  const clarifyTile = page.locator("#wall section.tile.stuck", { hasText: "BOS or BED?" });
  await clarifyTile.waitFor();
  await clarifyTile.getByRole("button", { name: "Answer" }).click();
  const side = page.locator("#f-side");
  await side.getByText("Original task").waitFor();

  // Refresh while waiting: the same agent is still open.
  await page.reload();
  await side.getByText("BOS or BED?").waitFor();

  // A password typed as a plain answer is stopped before anything is sent.
  await side.locator("textarea").fill("the password is hunter2");
  await side.getByRole("button", { name: "Send answer", exact: true }).click();
  await side.getByText("This looks like a password or code.").waitFor();
  assert.equal(fake.resumeCalls(clarify), 0, "nothing was sent while the guard is up");

  await side.locator("textarea").fill("BOS, Friday the 2nd");
  await side.getByRole("button", { name: "Send answer", exact: true }).dblclick();
  await side.getByText("Agent continued").waitFor();
  assert.equal(fake.resumeCalls(clarify), 1, "a double-click sent one resume");

  // Take over from the wall: the full-size browser is interactive; act inside it, hand back.
  await page.getByRole("button", { name: "← All agents" }).click();
  const takeoverTile = page.locator("#wall section.tile.stuck", { hasText: "Please finish verification" });
  await takeoverTile.getByRole("button", { name: "Take over" }).click();
  const live = page.frameLocator("#f-screen iframe");
  await live.getByText("SIMULATED BROWSER").waitFor();
  await live.getByRole("button", { name: "Complete verification" }).click();
  await live.getByRole("heading", { name: "Invoices" }).waitFor();
  await side.getByRole("button", { name: "Hand back to agent" }).click();
  await side.getByText("Agent continued").waitFor();
  await side.getByText("Left the browser on: Invoices").waitFor();
  assert.equal(fake.resumeCalls(takeover), 1);

  await eventually(() => store.getRun(takeover)?.status === "COMPLETED" && store.getRun(clarify)?.status === "COMPLETED", 10_000);
  await page.getByRole("button", { name: "← All agents" }).click();
  await eventually(async () => (await page.locator("#history .chip.done").count()) === 2, 5_000);
  // Both runs needed a person, so none finished without one.
  await page.locator(".metric", { hasText: "Finished without a person" }).getByText("0/2").waitFor();
});

test("mission control at scale: sign in every agent stuck on one site, answer every agent asking the same thing", { timeout: 90_000 }, async (t) => {
  const fake = await startFakeBrowserbase({ stepMs: 20 });
  const store = openStore(tempDb());
  const api = agentsApi({ apiKey: "test", baseUrl: fake.url });
  const sync = createSync({ store, api, discover: true, graceMs: 500 });
  const credentials = memoryCredentials([{ site: "billing.example.test", username: "demo", password: "never-stored-9!" }]);
  const inbox = await startInboxServer({ store, api, sync, simulated: true, credentials });
  sync.start(200);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await sync.stop();
    await inbox.close();
    await fake.close();
    store.close();
  });

  const signIns = [1, 2, 3].map((i) =>
    fake.startRun({
      task: `Download invoice ${i} from https://billing.example.test`,
      pauseWhen: "sign-in",
      steps: [{ tool: "navigate", input: { url: "https://billing.example.test/login" } }, { pause: "I need someone to sign in to the billing portal." }, { complete: "ok" }],
    }),
  );
  const questions = [1, 2].map((i) =>
    fake.startRun({ task: `Book flight ${i}`, pauseWhen: "ambiguous", steps: [{ pause: "BOS or BED?" }, { complete: "Booked." }] }),
  );

  const page = await browser.newPage();
  await page.goto(inbox.url);
  const signAll = page.getByRole("button", { name: "Sign in all 3 as demo" });
  await signAll.waitFor({ timeout: 15_000 });
  await signAll.dblclick();
  const answerAll = page.getByRole("button", { name: "Answer all 2" });
  await page.getByLabel("Answer for all 2").fill("BOS");
  await answerAll.click();

  await eventually(() => [...signIns, ...questions].every((id) => store.getRun(id)?.status === "COMPLETED"), 15_000);
  for (const id of signIns) {
    assert.equal(fake.resumeCalls(id), 1, "one delivery per agent, even with a double-click");
    assert.deepEqual([...fake.receivedVariables(id)].sort(), ["login_password", "login_username"]);
  }
  for (const id of questions) assert.equal(fake.resumeCalls(id), 1);
  assert.equal(JSON.stringify(store.interventionsByRun()).includes("never-stored-9!"), false, "the password is not in any stored pause");
});
