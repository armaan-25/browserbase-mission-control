/**
 * Does a Stagehand step that has already failed still act on the page later?
 *
 *   node examples/inflight-experiment.ts
 *
 * Handoff waits for in-flight agent steps before a person gets the browser.
 * That wait is only meaningful if a step that has *returned* has also *stopped*.
 * This checks that against the real Stagehand v4 extension, on local Chrome, with
 * no model calls (an `Action` object is replayed directly, skipping inference).
 *
 * The page adds a button 3s after load; clicking it increments a counter. Each
 * case asks Stagehand to click that button before it exists, then waits past the
 * 3s mark and reads the counter. A counter above zero means the page was written
 * to after the step had already reported failure.
 */
import { createServer } from "node:http";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";

const PAGE = `<!doctype html><title>late button</title><body>
<p id="count">0</p>
<script>
  setTimeout(function () {
    var b = document.createElement("button");
    b.id = "late"; b.textContent = "late";
    b.onclick = function () {
      var c = document.getElementById("count");
      c.textContent = String(Number(c.textContent) + 1);
    };
    document.body.appendChild(b);
  }, 3000);
</script></body>`;

// `/slow` answers after 3s: a navigation that is still in flight when a short
// step timeout fires.
const server = createServer((req, res) => {
  const send = () => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/slow" ? "<title>slow</title><p>slow page arrived</p>" : PAGE);
  };
  if (req.url === "/slow") setTimeout(send, 3_000);
  else send();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const url = `http://127.0.0.1:${address.port}/`;

const browser = await localBrowser.launch({ headless: true });
const stagehand = await Stagehand.create({ browser });
const page = (await browser.context.pages())[0] ?? (await browser.context.newPage());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const count = async () => Number(await page.evaluate("document.getElementById('count').textContent"));

async function run(label: string, attempt: () => Promise<unknown>): Promise<void> {
  await page.goto(url);
  const started = Date.now();
  let outcome: string;
  try {
    await attempt();
    outcome = "resolved";
  } catch (error) {
    outcome = `rejected: ${String((error as Error).message).split("\n")[0]}`;
  }
  const returnedAfter = Date.now() - started;
  await sleep(Math.max(0, 4_500 - returnedAfter));
  console.log(`${label}\n  step ${outcome} after ${returnedAfter}ms\n  clicks landed after that: ${await count()}\n`);
}

// act() needs a model even to replay an Action, and Model Gateway needs a
// Browserbase session, so locally the long-running write is a navigation.
await run("A. locator.click() on an element that does not exist yet", () => page.locator("#late").click());

// B. A navigation whose step times out while the server is still responding.
await page.goto(url);
const startedB = Date.now();
let outcomeB: string;
try {
  await page.goto(`${url}slow`, { timeout: 500 });
  outcomeB = "resolved";
} catch (error) {
  outcomeB = `rejected: ${String((error as Error).message).split("\n")[0]}`;
}
const returnedB = Date.now() - startedB;
const urlAtReturn = await page.url();
await sleep(4_500);
console.log(
  `B. goto(/slow) with timeout 500ms\n  step ${outcomeB} after ${returnedB}ms\n  url when the step returned: ${urlAtReturn}\n  url 4.5s later:             ${await page.url()}\n  → ${
    outcomeB === "resolved"
      ? returnedB > 1_000
        ? "the timeout did not bound the step: it waited for the navigation"
        : "the step finished inside its timeout"
      : urlAtReturn.endsWith("/slow") || !(await page.url()).endsWith("/slow")
        ? "the step failed and nothing changed afterwards"
        : "the navigation completed after the step reported failure"
  }\n`,
);

// C. While a step is running, is another call answered, or does it queue?
await page.goto(url);
const probeStarted = Date.now();
const slow = page.goto(`${url}slow`, { timeout: 6_000 }).then(
  () => Date.now(),
  () => Date.now(),
);
await sleep(100);
await page.url();
const probeDone = Date.now();
const slowDone = await slow;
console.log(
  `C. page.url() issued 100ms into a 3s navigation\n  url() answered at ${probeDone - probeStarted}ms; goto() finished at ${slowDone - probeStarted}ms\n  → ${probeDone < slowDone - 500 ? "calls run concurrently (not serialized)" : "calls are serialized behind the running step"}\n`,
);

await stagehand.close();
await browser.close();
server.close();
