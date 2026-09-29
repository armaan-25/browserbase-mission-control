/**
 * The inbox with SIMULATED runs: free, nothing reaches Browserbase.
 *
 *   npm run inbox:demo
 *
 * Starts the simulated Agents API (port 4830) and the inbox (port 4821), then
 * four runs:
 *   1. pauses to ask a question             → answer it in the inbox
 *   2. pauses for something in the browser  → take over, click, hand back
 *   3. finishes without any help
 *   4. pauses with a short session          → watch it expire, see the recovery text
 *
 * Also try: refresh the page mid-way (nothing is lost); stop and restart this
 * script (the inbox keeps its state in inbox-demo.db, though the simulated runs
 * themselves are gone, since the simulator keeps them in memory); double-click Send.
 */
import { agentsApi } from "./api.ts";
import { startFakeBrowserbase } from "./fake-browserbase.ts";
import { startInboxServer } from "./server.ts";
import { openStore } from "./store.ts";
import { createSync } from "./sync.ts";

const fake = await startFakeBrowserbase({ port: 4830, stepMs: 1_200 });
const store = openStore(process.env.INBOX_DB ?? new URL("../inbox-demo.db", import.meta.url).pathname);
const api = agentsApi({ apiKey: "simulated", baseUrl: fake.url });
const sync = createSync({ store, api, discover: true, graceMs: 5_000 });
sync.recover();
const inbox = await startInboxServer({ store, api, sync, simulated: true, port: Number(process.env.INBOX_PORT ?? 4821) });
sync.start(1_000);

fake.startRun({
  task: "Book the cheapest refundable flight to Boston for next Friday",
  pauseWhen: "the destination airport or date is ambiguous",
  steps: [
    { tool: "navigate", input: { url: "https://flights.example.test" }, page: { url: "https://flights.example.test", title: "Flight search" } },
    { say: "Boston has two nearby airports with commercial flights, and 'next Friday' could mean two dates." },
    { pause: "Which airport should I use, BOS (Logan) or BED (Hanscom)? And do you mean Friday the 2nd or Friday the 9th?" },
    { say: "Searching refundable fares for the airport and date you gave." },
    { complete: "Found a refundable fare and held it for 24 hours." },
  ],
});

fake.startRun({
  task: "Download the October invoice from the billing portal",
  pauseWhen: "the site shows a verification challenge you cannot complete",
  steps: [
    { tool: "navigate", input: { url: "https://billing.example.test/login" }, page: { url: "https://billing.example.test/login", title: "Billing portal — sign in" } },
    { tool: "click", input: { selector: "Sign in with SSO" } },
    {
      tool: "wait",
      input: { for: "challenge" },
      page: {
        url: "https://billing.example.test/verify",
        title: "Verify it's you",
        challenge: { label: "Complete verification", then: { url: "https://billing.example.test/invoices", title: "Invoices" } },
      },
    },
    { pause: "The portal is asking for a verification step I can't complete. Please finish it in the browser, then hand it back." },
    { say: "Back on the invoices page. Downloading October." },
    { complete: "Downloaded invoice-2026-10.pdf." },
  ],
});

fake.startRun({
  task: "Collect the five most recent incidents from the status page",
  steps: [
    { tool: "navigate", input: { url: "https://status.example.test" }, page: { url: "https://status.example.test", title: "Status" } },
    { say: "Reading the incident history." },
    { tool: "extract", input: { what: "incidents" } },
    { complete: "Collected 5 incidents." },
  ],
});

fake.startRun({
  task: "Renew the company domain before it lapses",
  pauseWhen: "payment approval is needed",
  sessionTtlMs: 45_000,
  steps: [
    { tool: "navigate", input: { url: "https://registrar.example.test" }, page: { url: "https://registrar.example.test/renew", title: "Renew domain" } },
    { pause: "Renewal costs $48 for one year. Should I pay with the card ending 4242?" },
    { complete: "Renewed." },
  ],
});

console.log(`agent inbox (SIMULATED runs): ${inbox.url}`);
console.log("run 4's browser session ends 45s after it starts; leave it unanswered to see expiry");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sync.stop();
    void Promise.all([inbox.close(), fake.close()]).finally(() => {
      store.close();
      process.exit(0);
    });
  });
}
