/**
 * Run the handoff service.
 *
 *   npm run handoff:serve                  # local browsers only
 *   (with BROWSERBASE_API_KEY in .env)     # also watches session expiry and serves Live View
 *
 * State lives in handoff.db next to this repo, so stopping and restarting the
 * service loses nothing.
 */
import { browserbaseApi } from "./browserbase.ts";
import { startService } from "./service.ts";
import { openStore } from "./store.ts";

const PORT = Number(process.env.HANDOFF_PORT ?? 4820);
const DB = process.env.HANDOFF_DB ?? new URL("../handoff.db", import.meta.url).pathname;

const key = process.env.BROWSERBASE_API_KEY;
const store = openStore(DB);
const service = await startService({
  store,
  port: PORT,
  browserbase: key ? browserbaseApi(key) : undefined,
});

console.log(`handoff inbox: ${service.url}`);
console.log(key ? "browserbase: expiry watching and Live View on" : "browserbase: no API key, local browsers only");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void service.close().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}
