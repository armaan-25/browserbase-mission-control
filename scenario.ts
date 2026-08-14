/**
 * The scenario both front-ends run.
 *
 * `demo.ts` prints it and `record.ts` films it, and before this module existed
 * each carried its own copy of the site, the CDP writes and the choreography.
 * They drifted: one was driving a hand-written fixture while the other drove
 * the real site, so the two artifacts demonstrated different things while
 * claiming to demonstrate the same one.
 *
 * Everything a viewer could disagree about lives here now. A front-end chooses
 * how to report progress and nothing else.
 */
import type { Browser, CDPSession, Page } from "playwright";
import { createBrowserLease } from "./lease.ts";

/**
 * A real site over the network, not a fixture.
 *
 * saucedemo.com is Sauce Labs' public automation-practice app: a genuine
 * deployed site with a real login form and published credentials, built to be
 * driven by exactly this kind of tooling. It keeps the demonstration honest
 * without touching anyone's payment flow. Nothing is submitted.
 */
export const TARGET = "https://www.saucedemo.com";

/**
 * Where the unmediated run lands. Navigating back to the inventory abandons
 * the checkout: a plausible thing for a second agent to do, and the reason the
 * collision costs more than three text fields. It discards a session that took
 * a login, three cart additions and a page of form entry to build.
 */
export const RIVAL = "https://www.saucedemo.com/inventory.html";

/** Inputs on the checkout form: the denominator in any verdict. */
export const FIELDS = 3;

/** Milliseconds between keystrokes. Slower than a machine needs, so a viewer
 *  can see work accumulating before it is destroyed. */
const KEYSTROKE_MS = 110;

/** How long the first client types before the second one interferes. */
const COLLIDE_AFTER_MS = 3_600;

/** How long a finished state is held on screen before teardown. */
const HOLD_MS = 3_000;

/** What a front-end is told as the run proceeds. */
export interface Progress {
  /** A step happened. `lease` marks lines emitted by the lease itself. */
  log(text: string, lease?: boolean): void;
  /** The run ended. `reached` is the outcome; `filled` the surviving fields. */
  verdict(filled: number, reached: string): void;
}

/** Type through a raw CDP session. Every keystroke is a state write. */
async function typeInto(client: CDPSession, id: string, text: string): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `document.getElementById(${JSON.stringify(id)})?.focus()`,
  });
  for (const ch of text) {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp" });
    await new Promise((resolve) => setTimeout(resolve, KEYSTROKE_MS));
  }
}

async function fillCheckout(client: CDPSession): Promise<void> {
  await typeInto(client, "first-name", "Armaan");
  await typeInto(client, "last-name", "Agrawal");
  await typeInto(client, "postal-code", "94105");
}

/**
 * Submit the form and land on the order summary.
 *
 * Clicking Continue is one more write to the same page, so it is exactly the
 * kind of action the unmediated run never reaches. The payoff is not "the
 * fields survived" but "the agent finished the job".
 */
async function submitCheckout(client: CDPSession, page: Page): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: "document.getElementById('continue')?.click()",
  });
  await page.waitForURL("**/checkout-step-two.html", { timeout: 15_000 });
  await page.waitForSelector(".summary_total_label", { timeout: 10_000 });
  // Scroll the total into frame: the summary is taller than the viewport and
  // the number is the point, so a screenshot of the item list buries it.
  await client.send("Runtime.evaluate", {
    expression: "document.querySelector('.summary_total_label')?.scrollIntoView({block:'center'})",
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

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

/** Checkout fields still holding what was typed into them. */
export async function countFilled(page: Page): Promise<number> {
  try {
    const raw = await page.evaluate(
      "['first-name','last-name','postal-code'].filter(function(i){var e=document.getElementById(i);return e&&e.value}).length",
    );
    return Number(raw) || 0;
  } catch {
    // Navigation destroyed the execution context, which is the finding.
    return 0;
  }
}

/**
 * Build the session the collision will destroy: sign in, add three items, open
 * checkout. Uses Playwright's own API rather than raw CDP because this is
 * setup, not the thing being demonstrated.
 */
export async function openCheckout(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 460, height: 620 });
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
  return page;
}

/**
 * Two clients, no arbitration. One fills the checkout while the other
 * navigates the same page; CDP delivers both writes faithfully and nobody
 * mediates. The first client is never told.
 */
export async function runUnmediated(page: Page, progress: Progress): Promise<void> {
  const a = await page.context().newCDPSession(page);
  const b = await page.context().newCDPSession(page);

  progress.log("stagehand → filling checkout");
  const filling = fillCheckout(a);
  await new Promise((resolve) => setTimeout(resolve, COLLIDE_AFTER_MS));

  progress.log("playwright → Page.navigate (nothing arbitrates)");
  await b.send("Page.navigate", { url: RIVAL });
  await filling.catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 900));
  progress.verdict(await countFilled(page), "back at products");
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
}

/**
 * The same two clients behind a write lease. The navigation queues rather than
 * interrupting, so the first client finishes and the second still gets its
 * turn: deferred, never dropped.
 */
export async function runLeased(page: Page, progress: Progress): Promise<void> {
  const a = await page.context().newCDPSession(page);
  const b = await page.context().newCDPSession(page);
  const lease = createBrowserLease();
  const unsubscribe = lease.onEvent((e) => progress.log(`${e.type} — ${e.holder}`, true));

  progress.log("stagehand → filling checkout");
  const filling = lease.withWrite(
    "checkout",
    "stagehand",
    async () => {
      await fillCheckout(a);
      const filled = await countFilled(page);
      progress.log("stagehand → Continue");
      await submitCheckout(a, page);
      progress.log(`order summary · ${await orderTotal(page)}`);
      // Hold inside the critical section: the moment this returns, the queued
      // navigate fires and the finished summary is gone.
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      return filled;
    },
    60_000,
  );

  await new Promise((resolve) => setTimeout(resolve, COLLIDE_AFTER_MS));
  progress.log("playwright → Page.navigate (queued)");
  const navigating = lease.withWrite("checkout", "playwright", async () => {
    await b.send("Page.navigate", { url: RIVAL });
  });

  progress.verdict(await filling, "checkout complete");
  await navigating;
  unsubscribe();
  lease.dispose();
}
