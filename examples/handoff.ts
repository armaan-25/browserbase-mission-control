/**
 * One complete handoff: agent steps → requestHuman → a person signs in → hand back
 * → the agent looks again and continues.
 *
 *   npm run handoff:serve                              # in one terminal
 *   node examples/handoff.ts --local                   # free: local Chrome window
 *   node --env-file=.env examples/handoff.ts           # a real Browserbase session (paid)
 *   node --env-file=.env examples/handoff.ts --run <id> --session <sessionId>
 *                                                      # re-attach after a restart
 *
 * The task uses saucedemo.com, Sauce Labs' public practice store: the agent opens
 * the login page, asks a person to sign in (credentials are printed on the page),
 * then adds an item to the cart once it can see it is signed in.
 *
 * No model calls: every agent step is a deterministic page or locator call, so
 * the handoff itself is what is being exercised.
 */
import { randomUUID } from "node:crypto";
import { browserbase, localBrowser, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { attachHandoff } from "../handoff/client.ts";

const STORE = "https://www.saucedemo.com";
const serviceUrl = process.env.HANDOFF_URL ?? "http://127.0.0.1:4820";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const local = process.argv.includes("--local");
const runId = arg("--run") ?? `demo-${randomUUID().slice(0, 8)}`;
const resumeSession = arg("--session");

let browser: StagehandBrowser;
if (local) {
  browser = await localBrowser.launch({ headless: false, viewport: { width: 1100, height: 760 } });
} else {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY is not set (or pass --local)");
  // keepAlive: closing this process must not end the session, or a restarted
  // loop would have nothing to re-attach to. api_timeout (sent to the API as
  // `timeout`, in seconds) bounds the cost.
  browser = resumeSession
    ? await browserbase.connect({ apiKey, sessionId: resumeSession })
    : await browserbase.launch({ apiKey, keepAlive: true, api_timeout: 900 });
}

const stagehand = await Stagehand.create({ browser });
const page = (await browser.context.pages())[0] ?? (await browser.context.newPage());
const h = await attachHandoff({ stagehand, page, serviceUrl, runId, sessionId: browser.sessionId ?? null });

console.log(`run ${runId}${browser.sessionId ? ` · session ${browser.sessionId}` : " · local chrome"}`);
console.log(`inbox: ${serviceUrl}\n`);

if (h.phase === "agent" && !(await page.url()).startsWith(STORE)) {
  console.log("agent → open the store");
  await h.page.goto(STORE);
}

console.log("agent → asking a person to sign in");
const reply = await h.requestHuman({
  kind: "takeover",
  reason: "Sign in to Swag Labs. The accepted usernames and the password are listed under the login form.",
  key: "sign-in",
});
console.log(`person handed back${reply.note ? `: "${reply.note}"` : ""}`);
console.log(`agent sees → ${reply.observation.title} · ${reply.observation.url}`);

if (!reply.observation.url.includes("/inventory.html")) {
  console.log("\nnot signed in, so the agent stops here rather than guessing");
} else {
  console.log("agent → add the backpack to the cart");
  await h.page.locator("#add-to-cart-sauce-labs-backpack").click();
  console.log(`cart now shows ${await h.page.locator(".shopping_cart_badge").textContent()} item(s)`);
}

h.detach();
await stagehand.close();
// Local: close Chrome. Browserbase: end the kept-alive session explicitly, since
// keepAlive means it would otherwise run until its timeout.
if (local) await browser.close();
else {
  const apiKey = process.env.BROWSERBASE_API_KEY as string;
  await fetch(`https://api.browserbase.com/v1/sessions/${browser.sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bb-api-key": apiKey },
    body: JSON.stringify({ status: "REQUEST_RELEASE" }),
  });
  await browser.close();
}
