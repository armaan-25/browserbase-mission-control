/**
 * The agent inbox page in a real browser, against the SIMULATED Agents API:
 * what a person sees and clicks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { agentsApi } from "../inbox/api.ts";
import { startFakeBrowserbase } from "../inbox/fake-browserbase.ts";
import { startInboxServer } from "../inbox/server.ts";
import { openStore } from "../inbox/store.ts";
import { createSync } from "../inbox/sync.ts";
import { eventually, tempDb } from "./fixtures.ts";

test("inbox page: answer with a double-click, refresh, and take over through Live View", { timeout: 90_000 }, async (t) => {
  const fake = await startFakeBrowserbase({ stepMs: 20 });
  const store = openStore(tempDb());
  const api = agentsApi({ apiKey: "test", baseUrl: fake.url });
  const sync = createSync({ store, api, discover: true, graceMs: 500 });
  const inbox = await startInboxServer({ store, api, sync, simulated: true });
  sync.start(200);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    sync.stop();
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
  const clarifyCard = page.locator("section.card", { hasText: "BOS or BED?" });
  await clarifyCard.waitFor();
  await page.getByText("What the agent did before pausing").first().waitFor();

  // Refresh while waiting: the card is still there.
  await page.reload();
  await clarifyCard.waitFor();

  await clarifyCard.locator("textarea").first().fill("BOS, Friday the 2nd");
  await clarifyCard.getByRole("button", { name: "Send answer" }).dblclick();
  await page.locator("section.card", { hasText: "BOS or BED?" }).getByText("Agent continued").waitFor();
  assert.equal(fake.resumeCalls(clarify), 1, "a double-click sent one resume");

  // Take over: open the live browser, act inside it, hand back.
  const takeoverCard = page.locator("section.card", { hasText: "Please finish verification" });
  await takeoverCard.getByRole("button", { name: "Take over the browser" }).click();
  const live = takeoverCard.frameLocator("iframe");
  await live.getByText("SIMULATED BROWSER").waitFor();
  await live.getByRole("button", { name: "Complete verification" }).click();
  await live.getByRole("heading", { name: "Invoices" }).waitFor();
  await takeoverCard.locator("textarea").last().fill("finished the verification step");
  await takeoverCard.getByRole("button", { name: "Hand back to agent" }).click();

  const done = page.locator("section.card", { hasText: "Please finish verification" });
  await done.getByText("Agent continued").waitFor();
  await done.getByText("Left the browser on: Invoices").waitFor();
  assert.equal(fake.resumeCalls(takeover), 1);

  await eventually(() => store.getRun(takeover)?.status === "COMPLETED" && store.getRun(clarify)?.status === "COMPLETED", 10_000);
  await eventually(async () => (await page.locator(".summary li", { hasText: "completed" }).locator("b").textContent()) === "2", 5_000);
});
