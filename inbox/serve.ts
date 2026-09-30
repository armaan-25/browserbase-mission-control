/**
 * Run the inbox against Browserbase (or the simulated API).
 *
 *   npm run inbox                       # real Browserbase: needs BROWSERBASE_API_KEY in .env
 *   INBOX_API_BASE=http://127.0.0.1:4830 npm run inbox
 *                                       # point at a simulated API instead (labelled SIMULATED)
 *
 * With a real key it discovers PAUSED runs across the project every few seconds
 * and keeps tracking them. It creates nothing and resumes nothing on its own.
 */
import { agentsApi, BROWSERBASE_API } from "./api.ts";
import { keychainCredentials } from "./credentials.ts";
import { startInboxServer } from "./server.ts";
import { openStore } from "./store.ts";
import { createSync } from "./sync.ts";

const apiKey = process.env.BROWSERBASE_API_KEY ?? (process.env.INBOX_API_BASE ? "simulated" : undefined);
if (!apiKey) {
  console.error("BROWSERBASE_API_KEY is not set. Add it to .env, or run `npm run inbox:demo` for the simulated demo.");
  process.exit(1);
}
const baseUrl = process.env.INBOX_API_BASE ?? BROWSERBASE_API;
const store = openStore(process.env.INBOX_DB ?? new URL("../inbox.db", import.meta.url).pathname);
const api = agentsApi({ apiKey, baseUrl });
const sync = createSync({ store, api, discover: true });
sync.recover();
// Runs that finished before Contexts were tracked: learn their Context once, from their session.
void sync.backfillContexts();

const inbox = await startInboxServer({
  credentials: keychainCredentials(),
  store,
  api,
  sync,
  simulated: baseUrl !== BROWSERBASE_API,
  port: Number(process.env.INBOX_PORT ?? 4821),
});
sync.start(Number(process.env.INBOX_POLL_MS ?? 3_000));

console.log(`agent inbox: ${inbox.url}`);
console.log(baseUrl === BROWSERBASE_API ? "watching Browserbase Agents runs" : `SIMULATED API at ${baseUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Promise.all([sync.stop(), inbox.close()]).finally(() => {
      store.close();
      process.exit(0);
    });
  });
}
