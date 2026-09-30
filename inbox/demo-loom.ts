/**
 * A paced walkthrough for recording (Loom etc.): SIMULATED runs, free, nothing reaches
 * Browserbase. Each act starts when you press Enter in this terminal, so you can talk
 * over it at your own pace.
 *
 *   npm run inbox:loom        then open http://127.0.0.1:4825
 *
 *   Act 1  agents at work
 *   Act 2  one gets stuck on the Acme Billing sign-in → you take over and sign in
 *   Act 3  the next run with the same saved browser profile skips the sign-in
 *   Act 4  12 agents stuck on the same portal → "Sign in all 12" with the saved login
 *   Act 5  an agent asks for a texted code → the password guard → "Send as a secret"
 */
import { createInterface } from "node:readline/promises";
import { agentsApi } from "./api.ts";
import type { CredentialStore } from "./credentials.ts";
import { startFakeBrowserbase, type Step } from "./fake-browserbase.ts";
import { startInboxServer } from "./server.ts";
import { openStore } from "./store.ts";
import { createSync } from "./sync.ts";

const SITE = "acme-billing.example.test";
const LOGIN = { username: "armaan", password: "demo-password-42" }; // SIMULATED credentials, for the demo only

// For recordings: DEMO_QUIET=1 shows a small "Demo" tag instead of the red banners;
// DEMO_LABEL=none shows no simulation labels at all (say so wherever you share it).
const quiet = process.env.DEMO_QUIET === "1";
const unlabelled = process.env.DEMO_LABEL === "none";
const fake = await startFakeBrowserbase({ port: 4830, stepMs: 900, pageLabel: unlabelled ? "none" : quiet ? "quiet" : "banner" });
const dbPath = process.env.INBOX_DB ?? new URL("../inbox-loom.db", import.meta.url).pathname;
const { rmSync } = await import("node:fs");
for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true }); // every take starts clean
const store = openStore(dbPath);
const api = agentsApi({ apiKey: "simulated", baseUrl: fake.url });
const sync = createSync({ store, api, discover: true, graceMs: 5_000 });

// The saved login appears only from act 4, so act 2 shows the manual takeover first.
let savedLoginOn = false;
const credentials: CredentialStore = {
  list: () => (savedLoginOn ? [{ site: SITE, username: LOGIN.username }] : []),
  password: (site) => (savedLoginOn && site === SITE ? LOGIN.password : null),
};
const inbox = await startInboxServer({ store, api, sync, simulated: true, simulatedLabel: unlabelled ? "none" : quiet ? "tag" : "banner", credentials, port: Number(process.env.INBOX_PORT ?? 4825) });
sync.start(1_000);

const loginPage = {
  url: `https://${SITE}/login`,
  title: "Acme Billing — sign in",
  challenge: { label: "Sign in", signsIn: SITE, login: LOGIN, then: { url: `https://${SITE}/invoices`, title: "Acme Billing — invoices" } },
};
const invoiceRun = (client: string): Step[] => [
  { tool: "navigate", input: { url: `https://${SITE}/invoices` }, page: loginPage },
  { pause: "Acme Billing is asking me to sign in, and I don't have the credentials. Can someone sign in for me?", onlyIfChallenged: true },
  { tool: "extract", input: { what: `October invoice for ${client}` } },
  { tool: "download", input: { file: "invoice-2026-10.pdf" } },
  { complete: `Downloaded the October invoice for ${client}.` },
];

const rl = createInterface({ input: process.stdin, output: process.stdout });
const act = async (title: string, lines: string[]) => {
  console.log(`\n────────  ${title}  ────────`);
  for (const l of lines) console.log(`  ${l}`);
  await rl.question("  ↵  press Enter to start this act ");
};
const waitFor = async (check: () => boolean) => {
  while (!check()) await new Promise((r) => setTimeout(r, 500));
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Promise.all([sync.stop(), inbox.close(), fake.close()]).finally(() => {
      store.close();
      process.exit(0);
    });
  });
}

console.log(`\nMission Control (SIMULATED): ${inbox.url}\nOpen it, start recording, then come back here.`);

await act("Act 1 · agents at work", ["Five agents start working. Their live browsers appear on the wall."]);
for (const [i, name] of ["Northwind", "Globex", "Initech", "Umbrella", "Hooli"].entries()) {
  fake.startRun({
    task: `Collect this month's pricing from ${name}'s website`,
    steps: Array.from({ length: 500 }, (_, k): Step => (k === 0 ? { tool: "navigate", page: { url: `https://pricing.${name.toLowerCase()}.example.test`, title: `${name} — pricing` } } : { tool: "extract", input: { row: k } })),
  });
  await new Promise((r) => setTimeout(r, 400 + i * 150));
}

await act("Act 2 · stuck on a sign-in → take over", [
  "An agent heads to Acme Billing and gets stuck on the sign-in.",
  "On its orange tile: Take over → type the login INTO THE PAGE → Hand back to agent.",
  `Login to type:  username ${LOGIN.username}   password ${LOGIN.password}`,
]);
const profile = fake.createContext();
const first = fake.startRun({ task: "Download the October invoice for Northwind from Acme Billing", pauseWhen: "a sign-in is needed", steps: invoiceRun("Northwind"), context: { id: profile, persist: true } });
await waitFor(() => store.getRun(first)?.status === "COMPLETED");
console.log("  ✓ that run finished; its signed-in browser profile was saved");

await act("Act 3 · the next run doesn't need you", ["A second invoice run starts with the same saved browser profile.", "Watch it go straight past the sign-in: no orange, tagged Skipped login."]);
fake.startRun({ task: "Download the October invoice for Globex from Acme Billing", pauseWhen: "a sign-in is needed", steps: invoiceRun("Globex"), context: { id: profile, persist: true } });

await act("Act 4 · at scale", [
  "A saved login for Acme Billing is switched on (in real use it lives in your Mac's Keychain).",
  "12 new agents hit the same sign-in. Click “Sign in all 12” in the orange bar.",
]);
savedLoginOn = true;
for (let i = 1; i <= 12; i++) fake.startRun({ task: `Download the October invoice for client #${100 + i} from Acme Billing`, pauseWhen: "a sign-in is needed", steps: invoiceRun(`client #${100 + i}`) });

await act("Act 5 · codes and secrets", [
  "An agent asks for the code texted to your phone.",
  "Open it, type 481516 and press Send answer → the guard stops it → Send as a secret.",
]);
fake.startRun({
  task: "Approve the new vendor payment in the bank portal",
  pauseWhen: "a one-time code is needed",
  steps: [
    { tool: "navigate", page: { url: "https://bank.example.test/approvals", title: "Bank — approvals" } },
    { pause: "The bank sent a 6-digit verification code to your phone. What is it?" },
    { tool: "type", input: { into: "code", text: "%human_reply%" } },
    { complete: "Payment approved." },
  ],
});

await act("The end", ["Press Enter to stop the demo (Ctrl-C also works)."]);
process.kill(process.pid, "SIGINT");
