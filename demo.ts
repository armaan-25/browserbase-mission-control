/**
 * The collision, then the fix — run it and watch both.
 *
 *   node mutex/demo.ts            # local Chrome, free
 *   node --env-file=.env mutex/demo.ts --remote   # a real Browserbase session
 *
 * Two independent CDP clients share one page. Client A fills a checkout form
 * field by field; client B navigates the same page while A is mid-typing.
 *
 * Pass 1 runs them unmediated, reproducing what the Stagehand v4 post warns
 * about. Pass 2 routes both through a write lease. Same two clients, same
 * timing, same page — the only difference is arbitration.
 */
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { createBrowserLease } from "./lease.ts";

const FORM = `
  <style>
    body { font: 15px ui-monospace, Menlo, monospace; background:#0b0d10; color:#e8eef5; padding:40px; }
    h1 { font-size:15px; letter-spacing:.14em; color:#8892a0; margin:0 0 22px; font-weight:600; }
    label { display:block; font-size:11px; letter-spacing:.1em; color:#59626e; margin:14px 0 5px; }
    input { width:340px; padding:10px 12px; font:14px ui-monospace, Menlo, monospace;
            background:#12161b; color:#fff; border:1px solid #222a33; border-radius:4px; }
  </style>
  <h1>CHECKOUT</h1>
  <label>EMAIL</label><input id="email">
  <label>CARD</label><input id="card">
  <label>ADDRESS</label><input id="addr">
`;

/** Type through a raw CDP session — this is a state WRITE. */
async function typeInto(client: CDPSession, id: string, text: string): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `document.getElementById(${JSON.stringify(id)})?.focus()`,
  });
  for (const ch of text) {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp" });
    await new Promise((resolve) => setTimeout(resolve, 45));
  }
}

async function readForm(page: Page): Promise<string> {
  const raw = await page.evaluate(
    "JSON.stringify({email:document.getElementById('email')?.value??'',card:document.getElementById('card')?.value??'',addr:document.getElementById('addr')?.value??''})",
  );
  const form = JSON.parse(String(raw)) as Record<string, string>;
  const filled = Object.values(form).filter(Boolean).length;
  return `${filled}/3 fields · ${JSON.stringify(form)}`;
}

async function fillCheckout(client: CDPSession): Promise<void> {
  await typeInto(client, "email", "armaan@example.com");
  await typeInto(client, "card", "4242424242424242");
  await typeInto(client, "addr", "1 Market St");
}

async function setup(page: Page) {
  await page.setContent(FORM);
  return {
    a: await page.context().newCDPSession(page),
    b: await page.context().newCDPSession(page),
  };
}

async function withoutLease(page: Page): Promise<string> {
  const { a, b } = await setup(page);
  const filling = fillCheckout(a);
  await new Promise((resolve) => setTimeout(resolve, 600));
  // B has no idea A is mid-form. CDP delivers this faithfully.
  await b.send("Page.navigate", { url: "about:blank" });
  await filling.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  return readForm(page);
}

async function withLease(page: Page): Promise<string> {
  const { a, b } = await setup(page);
  const lease = createBrowserLease();
  lease.onEvent((e) =>
    console.log(`   [lease] ${e.type.padEnd(8)} ${e.holder}${e.waiting ? ` (${e.waiting} waiting)` : ""}`),
  );

  // The check happens INSIDE A's critical section. Once A releases, B's queued
  // navigate fires immediately — correctly — so the only place A's completed
  // form is observable is while A still holds the page. That timing is the
  // whole guarantee: exclusive until done, not merely eventually consistent.
  const filling = lease.withWrite(
    "page-1",
    "stagehand",
    async () => {
      await fillCheckout(a);
      return readForm(page);
    },
    15_000,
  );

  await new Promise((resolve) => setTimeout(resolve, 600));
  // Same navigate, same moment as the uncoordinated run — but it now queues.
  const navigating = lease.withWrite("page-1", "playwright", async () => {
    await b.send("Page.navigate", { url: "about:blank" });
  });

  const afterFill = await filling;
  await navigating; // B still gets its turn — queued, never cancelled.
  lease.dispose();
  return afterFill;
}

const remote = process.argv.includes("--remote");
let browser: Browser;
if (remote) {
  const key = process.env.BROWSERBASE_API_KEY;
  if (!key) throw new Error("BROWSERBASE_API_KEY required for --remote");
  const response = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bb-api-key": key },
    body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID }),
  });
  if (!response.ok) throw new Error(`session create failed: ${response.status} ${await response.text()}`);
  const session = (await response.json()) as { id: string; connectUrl: string };
  console.log(`browserbase session ${session.id}\n`);
  browser = await chromium.connectOverCDP(session.connectUrl);
} else {
  browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
}

const page = remote ? browser.contexts()[0]!.pages()[0]! : await browser.newPage();

console.log("TWO CLIENTS, ONE PAGE\n");
console.log("1. no coordination");
console.log(`   result: ${await withoutLease(page)}\n`);
console.log("2. with a write lease");
const leased = await withLease(page);
console.log(`   result: ${leased}\n`);

await browser.close();
