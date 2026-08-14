/**
 * Bake one run of the collision + fix into a static bundle.
 *
 *   node mutex/record.ts        →  mutex/site/frames.json
 *
 * `live.ts` needs Node driving real Chromium, so it cannot be a link someone
 * clicks. This captures the same two runs once — real browsers, real CDP, real
 * screenshots — and writes them as timestamped frames. `mutex/site/index.html`
 * replays them with no server, which makes the demo a URL instead of a repo.
 *
 * The frames are photographs of a real run, not a re-enactment: every pixel
 * came out of a browser that was actually being written to by two clients.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { createBrowserLease } from "./lease.ts";

const OUT = new URL("./site/", import.meta.url).pathname;
const FPS = 10;

type Run = "raw" | "leased";
interface Event {
  readonly t: number;
  readonly run: Run;
  readonly kind: "shot" | "log" | "verdict";
  readonly data?: string;
  readonly text?: string;
  readonly lease?: boolean;
  readonly filled?: number;
  /** Total fields in play, so the page never hardcodes a count. */
  readonly of?: number;
  /** Where the run actually ended up — the outcome, not the field count. */
  readonly reached?: string;
}

/** Inputs the checkout form has: the denominator in the verdict. */
const FIELDS = 3;

const events: Event[] = [];
const t0 = Date.now();
const push = (e: Omit<Event, "t">) => events.push({ t: Date.now() - t0, ...e });

/**
 * A real site over the network, not a fixture.
 *
 * saucedemo.com is Sauce Labs' public automation-practice app: a genuine
 * deployed site with a real login form and published credentials, built to be
 * driven by exactly this kind of tooling. Using it keeps the demo honest —
 * these are real page loads and real DOM — without touching anyone's payment
 * flow or account. Nothing is submitted; the collision happens while typing.
 */
const TARGET = "https://www.saucedemo.com";

/**
 * Where the unmediated run lands. Navigating back to the inventory abandons
 * the checkout — a plausible thing for a second agent to do, and the reason
 * the collision costs more than two text fields: it discards a multi-step
 * session that took a login, three cart additions and a page of form entry
 * to build.
 */
const RIVAL = "https://www.saucedemo.com/inventory.html";

async function typeInto(client: CDPSession, id: string, text: string) {
  await client.send("Runtime.evaluate", {
    expression: `document.getElementById(${JSON.stringify(id)})?.focus()`,
  });
  for (const ch of text) {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp" });
    // Deliberately slower than a machine needs to be. The fill is the part a
    // viewer has to see happening, and at machine speed it is over before the
    // eye registers that anything was typed.
    await new Promise((r) => setTimeout(r, 110));
  }
}

/** The checkout form the agent is filling when the other client interferes. */
const fillCheckout = async (client: CDPSession) => {
  await typeInto(client, "first-name", "Armaan");
  await typeInto(client, "last-name", "Agrawal");
  await typeInto(client, "postal-code", "94105");
};

/**
 * Submit the form and land on the order summary.
 *
 * Run INSIDE the lease: the point is not that the fields survived, it is that
 * the agent got to finish. Clicking Continue is one more write to the same
 * page, so it is exactly the kind of action the unmediated run never reaches.
 */
async function submitCheckout(client: CDPSession, page: Page): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: "document.getElementById('continue')?.click()",
  });
  await page.waitForURL("**/checkout-step-two.html", { timeout: 15_000 });
  await page.waitForSelector(".summary_total_label", { timeout: 10_000 });
  // Scroll the total into frame: the summary is taller than the viewport, and
  // the number is the point — a screenshot of the item list buries it.
  await client.send("Runtime.evaluate", {
    expression: "document.querySelector('.summary_total_label')?.scrollIntoView({block:'center'})",
  });
  await new Promise((r) => setTimeout(r, 500));
}

/** What the completed run is worth, read off the real order summary. */
async function orderTotal(page: Page): Promise<string> {
  try {
    const raw = await page.evaluate(
      "(document.querySelector('.summary_total_label')||{}).textContent||''",
    );
    return String(raw).trim();
  } catch {
    return "";
  }
}

/**
 * Build the session the collision will destroy: sign in, add three items,
 * open checkout. Done with Playwright's own API rather than raw CDP because
 * this is setup, not the thing being demonstrated — and it happens before
 * capture starts, so the recording is only the contested part.
 */
async function buildSession(page: Page): Promise<void> {
  await page.goto(TARGET, { waitUntil: "networkidle", timeout: 30_000 });
  await page.fill("#user-name", "standard_user");
  await page.fill("#password", "secret_sauce");
  await page.click("#login-button");
  await page.waitForURL("**/inventory.html", { timeout: 15_000 });

  const items = await page.$$("button.btn_inventory");
  for (const item of items.slice(0, 3)) await item.click();

  await page.click(".shopping_cart_link");
  await page.waitForURL("**/cart.html", { timeout: 10_000 });
  await page.click("#checkout");
  await page.waitForURL("**/checkout-step-one.html", { timeout: 10_000 });
}

/** Checkout fields still holding what was typed into them. */
async function countFilled(page: Page): Promise<number> {
  try {
    const raw = await page.evaluate(
      "['first-name','last-name','postal-code'].filter(function(i){var e=document.getElementById(i);return e&&e.value}).length",
    );
    return Number(raw) || 0;
  } catch {
    // Navigation destroyed the execution context — which is the finding.
    return 0;
  }
}

function capture(page: Page, run: Run): () => void {
  let on = true;
  void (async () => {
    while (on) {
      try {
        const shot = await page.screenshot({ type: "jpeg", quality: 50 });
        push({ run, kind: "shot", data: shot.toString("base64") });
      } catch {
        // Navigation tears the capture target down mid-shot; next frame recovers.
      }
      await new Promise((r) => setTimeout(r, 1000 / FPS));
    }
  })();
  return () => {
    on = false;
  };
}

/** Session first, capture second: the recording is only the contested part. */
async function openCheckout(browser: Browser, run: Run) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 460, height: 620 });
  await buildSession(page);
  push({ run, kind: "log", text: "signed in · 3 items in cart · checkout open" });
  return { page, stop: capture(page, run) };
}

async function runRaw(browser: Browser) {
  const { page, stop } = await openCheckout(browser, "raw");
  const a = await page.context().newCDPSession(page);
  const b = await page.context().newCDPSession(page);
  push({ run: "raw", kind: "log", text: "stagehand → filling checkout" });
  const filling = fillCheckout(a);
  await new Promise((r) => setTimeout(r, 3_600));
  push({ run: "raw", kind: "log", text: "playwright → Page.navigate (nothing arbitrates)" });
  await b.send("Page.navigate", { url: RIVAL });
  await filling.catch(() => {});
  await new Promise((r) => setTimeout(r, 900));
  push({
    run: "raw",
    kind: "verdict",
    filled: await countFilled(page),
    of: FIELDS,
    reached: "back at products",
  });
  await new Promise((r) => setTimeout(r, 3_000));
  stop();
}

async function runLeased(browser: Browser) {
  const { page, stop } = await openCheckout(browser, "leased");
  const a = await page.context().newCDPSession(page);
  const b = await page.context().newCDPSession(page);
  const lease = createBrowserLease();
  lease.onEvent((e) => push({ run: "leased", kind: "log", lease: true, text: `${e.type} — ${e.holder}` }));

  push({ run: "leased", kind: "log", text: "stagehand → filling checkout" });
  const filling = lease.withWrite(
    "checkout",
    "stagehand",
    async () => {
      await fillCheckout(a);
      const filled = await countFilled(page);
      // Still holding: submit and land on the order summary. This is the whole
      // payoff — not "the fields survived" but "the agent finished the job".
      push({ run: "leased", kind: "log", text: "stagehand → Continue" });
      await submitCheckout(a, page);
      push({ run: "leased", kind: "log", text: `order summary · ${await orderTotal(page)}` });
      // Hold the summary on screen; the queued navigate fires the moment this
      // returns.
      await new Promise((r) => setTimeout(r, 3_200));
      return filled;
    },
    60_000,
  );
  await new Promise((r) => setTimeout(r, 3_600));
  push({ run: "leased", kind: "log", text: "playwright → Page.navigate (queued)" });
  const navigating = lease.withWrite("checkout", "playwright", async () => {
    await b.send("Page.navigate", { url: RIVAL });
  });
  const filled = await filling;
  push({ run: "leased", kind: "verdict", filled, of: FIELDS, reached: "checkout complete" });
  await navigating;
  stop();
  lease.dispose();
}

const browser = await chromium.launch({ headless: true });
console.log("recording both runs…");
await Promise.all([runRaw(browser), runLeased(browser)]);
await browser.close();

mkdirSync(OUT, { recursive: true });
const json = JSON.stringify(events);
writeFileSync(`${OUT}frames.json`, json);

const shots = events.filter((e) => e.kind === "shot").length;
console.log(`${events.length} events (${shots} frames) → ${OUT}frames.json`);
console.log(`${(json.length / 1024 / 1024).toFixed(1)} MB`);
