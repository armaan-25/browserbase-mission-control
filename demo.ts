/**
 * The collision, then the fix, in a terminal.
 *
 *   node mutex/demo.ts                            # local Chrome, free
 *   node --env-file=.env mutex/demo.ts --remote   # a real Browserbase session
 *
 * Both runs come from `scenario.ts`, so this and the recorded page cannot drift
 * apart: the only thing here is how progress is printed.
 */
import { chromium, type Browser } from "playwright";
import { openCheckout, runLeased, runUnmediated, type Progress } from "./scenario.ts";

/** Prints each step under a heading; the verdict is the last line. */
function printer(): Progress {
  return {
    log(text, lease) {
      console.log(lease ? `   [lease] ${text}` : `   ${text}`);
    },
    verdict(filled, reached) {
      console.log(`   → ${reached} (${filled}/3 fields)\n`);
    },
  };
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
  if (!response.ok) {
    throw new Error(`session create failed: ${response.status} ${await response.text()}`);
  }
  const session = (await response.json()) as { id: string; connectUrl: string };
  console.log(`browserbase session ${session.id}\n`);
  browser = await chromium.connectOverCDP(session.connectUrl);
} else {
  browser = await chromium.launch({ headless: true });
}

console.log("TWO CLIENTS, ONE PAGE\n");

console.log("1. no coordination");
await runUnmediated(await openCheckout(browser), printer());

console.log("2. with a write lease");
await runLeased(await openCheckout(browser), printer());

await browser.close();
