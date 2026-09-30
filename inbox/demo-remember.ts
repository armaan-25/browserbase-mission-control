/**
 * Help once, never again, with SIMULATED runs: free, nothing reaches Browserbase.
 *
 *   npm run inbox:remember
 *
 * 1. Creates a Context and starts run 1 with it (`persist: true`).
 * 2. Run 1 reaches a sign-in page and pauses. In the inbox: Take over, click
 *    "Sign in" in the simulated browser, Hand back.
 * 3. When run 1 completes, its session ends and the sign-in is saved to the Context.
 * 4. Run 2 starts with the same Context, lands already signed in, and never pauses.
 *
 * The two runs are driven by `runTwiceWithContext` from `remember.ts`, the same
 * code that runs against real Browserbase, so this is also its dry run.
 */
import { agentsApi } from "./api.ts";
import { memoryCredentials } from "./credentials.ts";
import { startFakeBrowserbase, type Step } from "./fake-browserbase.ts";
import { startInboxServer } from "./server.ts";
import { runTwiceWithContext } from "./remember.ts";
import { openStore } from "./store.ts";
import { createSync } from "./sync.ts";

const TASK = "Download the October invoice from the billing portal";
const PAUSE_WHEN = "you need someone to sign in";
const SCRIPT: Step[] = [
  {
    tool: "navigate",
    input: { url: "https://billing.example.test" },
    page: {
      url: "https://billing.example.test/login",
      title: "Billing portal — sign in",
      challenge: { label: "Sign in", signsIn: "billing.example.test", then: { url: "https://billing.example.test/invoices", title: "Invoices" } },
    },
  },
  { pause: "The billing portal needs a sign-in I can't do. Please sign in, then hand it back.", onlyIfChallenged: true },
  { say: "On the invoices page. Downloading October." },
  { complete: "Downloaded invoice-2026-10.pdf." },
];

const fake = await startFakeBrowserbase({ port: 4830, stepMs: 1_200 });
const store = openStore(process.env.INBOX_DB ?? new URL("../inbox-remember.db", import.meta.url).pathname);
const api = agentsApi({ apiKey: "simulated", baseUrl: fake.url });
const sync = createSync({ store, api, discover: true, graceMs: 5_000 });
sync.recover();
const inbox = await startInboxServer({ store, api, sync, simulated: true,
  // SIMULATED saved login, so the demo can show "Sign in with saved login" without your Keychain.
  credentials: memoryCredentials([{ site: "billing.example.test", username: "demo", password: "simulated-password" }]),
  port: Number(process.env.INBOX_PORT ?? 4821) });
sync.start(1_000);
console.log(`agent inbox (SIMULATED runs): ${inbox.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Promise.all([sync.stop(), inbox.close(), fake.close()]).finally(() => {
      store.close();
      process.exit(0);
    });
  });
}

await runTwiceWithContext(api, { task: TASK, pauseWhen: PAUSE_WHEN }, { beforeRun: () => fake.nextScript(SCRIPT), pollMs: 500, saveWaitMs: 3_000 });
