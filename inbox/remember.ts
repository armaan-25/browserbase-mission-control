/**
 * Help once, never again, against real Browserbase: two runs share one Context.
 *
 *   npm run inbox                              # in one terminal: answers run 1's pause
 *   node --env-file=.env inbox/remember.ts     # in another: 2 Agents runs, 1 Context
 *
 * Run 1 reaches a login and pauses; a person takes over in the inbox, signs in,
 * and hands back. When run 1 ends, Browserbase saves its browser into the Context
 * (`persist: true`). Run 2 starts with the same Context. The pause counts come
 * from each run's own transcript, not from the inbox.
 *
 * `runTwiceWithContext` is also what `demo-remember.ts` runs on the simulator.
 */
import { fileURLToPath } from "node:url";
import { agentsApi, BROWSERBASE_API, type AgentsApi } from "./api.ts";
import { TERMINAL, type RunStatus } from "./intervention.ts";

export interface RunSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly pauses: number;
  /** Null when the agent used no browser (seen live: an HTTP strategy), in which case the Context cannot help. */
  readonly sessionId: string | null;
}

export async function runTwiceWithContext(
  api: AgentsApi,
  input: { task: string; pauseWhen: string },
  hooks: { beforeRun?: () => void; log?: (line: string) => void; pollMs?: number; saveWaitMs?: number } = {},
): Promise<[RunSummary, RunSummary]> {
  const log = hooks.log ?? console.log;
  const context = await api.createContext();
  log(`context ${context.id} (persist: true)`);

  async function runToEnd(label: string): Promise<RunSummary> {
    hooks.beforeRun?.();
    const started = await api.createRun({ ...input, context: { id: context.id, persist: true } });
    log(`${label}: ${started.runId} started`);
    let run = started;
    while (!TERMINAL.has(run.status)) {
      await new Promise((resolve) => setTimeout(resolve, hooks.pollMs ?? 3_000));
      run = (await api.getRun(started.runId)) ?? run;
    }
    const { messages } = await api.listMessages(run.runId, null);
    const pauses = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool-call" && p.toolName === "pause").length;
    log(`${label}: ${run.status}, ${pauses} pause(s), browser session ${run.sessionId ?? "none"}${run.cause ? `, cause ${run.cause}` : ""}`);
    return { runId: run.runId, status: run.status, pauses, sessionId: run.sessionId };
  }

  const first = await runToEnd("run 1");
  // The Context is saved after run 1's session ends, not instantly. Measured with plain
  // sessions (2026-09-28): the save was visible 13 s after release. Run 2 must not start sooner.
  const saveWaitMs = hooks.saveWaitMs ?? 30_000;
  log(`waiting ${Math.round(saveWaitMs / 1000)}s for the Context to be saved`);
  await new Promise((resolve) => setTimeout(resolve, saveWaitMs));
  const second = await runToEnd("run 2");
  log(`pauses: run 1 → ${first.pauses}, run 2 → ${second.pauses}`);
  return [first, second];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    console.error("BROWSERBASE_API_KEY is not set. Run with: node --env-file=.env inbox/remember.ts");
    process.exit(1);
  }
  // agent-login-test/ (deployed at agent-login-test.vercel.app): a login that shows no
  // credentials, and an invoice code that exists only in the 1-day cookie a sign-in sets.
  // saucedemo.com failed as a test site: it prints its own login, and the agent used it.
  await runTwiceWithContext(agentsApi({ apiKey, baseUrl: process.env.INBOX_API_BASE ?? BROWSERBASE_API }), {
    task: "Open https://agent-login-test.vercel.app/account.html in the browser and report the latest invoice number shown there.",
    pauseWhen: "you reach a login page, since you do not have the credentials; a person will sign in for you",
  });
}
