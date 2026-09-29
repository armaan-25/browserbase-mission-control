/**
 * The inbox page in a real browser (Playwright, already a dependency of this repo).
 * Checks what a person actually sees and clicks: the card, the hand-back, the
 * receipt, a double-click, and a refresh mid-request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { eventually, json, must, post, start } from "./fixtures.ts";

test("inbox: a person sees the request, hands back once, and sees the receipt", { timeout: 60_000 }, async (t) => {
  const s = await start();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await s.stop();
  });

  const attached = await json(await post(s.service.url, "/api/runs", { runId: "ui-run", holder: "ui-loop" }));
  const generation = (attached.body.run as { generation: number }).generation;
  await post(s.service.url, "/api/runs/ui-run/requests", {
    key: "sign-in",
    kind: "takeover",
    reason: "Sign in to the store",
    context: { url: "https://store.example.test/login", title: "Login" },
    generation,
    holder: "ui-loop",
  });

  const page = await browser.newPage();
  await page.goto(s.service.url);
  await page.getByText("Sign in to the store").waitFor();
  assert.ok(await page.getByText("use the Chrome window the agent opened").isVisible(), "local run: no Live View, says so");

  // Refresh mid-request: the card is still there.
  await page.reload();
  await page.getByText("Sign in to the store").waitFor();

  await page.locator("textarea").fill("signed in as standard_user");
  const button = page.getByRole("button", { name: "Hand back to agent" });
  // A double-click: the button disables on the first click, and even a second
  // request would carry the same idempotency key.
  await button.dblclick();
  await page.getByText("Handed back", { exact: false }).first().waitFor();

  const run = must(s.store.getRun("ui-run"), "run");
  assert.equal(run.owner, "agent");
  assert.equal(run.generation, generation + 2, "one transition to the person, exactly one back");
  assert.equal(s.store.events("ui-run").filter((e) => e.type === "request.handed_back").length, 1);

  // The receipt waits for the agent's own look at the page.
  await page.getByText("Agent has not looked at the page yet.").waitFor();
  await post(s.service.url, `/api/requests/${run.currentRequestId}/observation`, {
    observation: { url: "https://store.example.test/inventory", title: "Products", snapshot: "" },
  });
  await eventually(async () => (await page.getByText("Agent looked again").count()) > 0, 5_000);
  assert.ok(await page.getByText("signed in as standard_user").isVisible());
});
