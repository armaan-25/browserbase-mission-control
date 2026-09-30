/**
 * Saved logins for agents that get stuck on a sign-in page.
 *
 * Passwords live only in the macOS Keychain (service = site, account = username),
 * which the OS encrypts. This module keeps a small index of which sites have a saved
 * login (`inbox-logins.json`: site and username, never a password) and reads a
 * password only at the moment a reply is sent.
 *
 * The password then goes to Browserbase as a `variables` value on /resume. The agent
 * sees only the placeholders `%login_username%` / `%login_password%`; confirmed live
 * on 2026-09-30 that the value does not appear anywhere in the run's transcript.
 *
 *   npm run login:add -- <site> <username>   save or link a login (prompts for the password)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface SavedLogin {
  readonly site: string;
  readonly username: string;
}

export interface CredentialStore {
  list(): SavedLogin[];
  /** The password for a saved site, or null. Server-side only; never logged or stored. */
  password(site: string): string | null;
}

export const DEFAULT_INDEX = fileURLToPath(new URL("../inbox-logins.json", import.meta.url));

function readIndex(file: string): SavedLogin[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SavedLogin => typeof e === "object" && e !== null && typeof e.site === "string" && typeof e.username === "string",
    );
  } catch {
    return [];
  }
}

function keychainPassword(site: string, username: string): string | null {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", site, "-a", username, "-w"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .replace(/\n$/, "");
  } catch {
    return null;
  }
}

/** Saved logins backed by the macOS Keychain, indexed by `file`. */
export function keychainCredentials(file = DEFAULT_INDEX): CredentialStore {
  return {
    list: () => readIndex(file),
    password(site) {
      const entry = readIndex(file).find((e) => e.site === site);
      return entry ? keychainPassword(entry.site, entry.username) : null;
    },
  };
}

/** For tests and the simulator: logins held in memory. */
export function memoryCredentials(entries: ReadonlyArray<SavedLogin & { readonly password: string }>): CredentialStore {
  return {
    list: () => entries.map(({ site, username }) => ({ site, username })),
    password: (site) => entries.find((e) => e.site === site)?.password ?? null,
  };
}

/** Hostnames mentioned in some text (URLs or bare domains). */
function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)/gi)) if (m[1]) hosts.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi)) if (m[1]) hosts.add(m[1].toLowerCase());
  return [...hosts];
}

/** The saved login for the site a stuck agent is on, judged from its question, task and recent steps. */
export function matchLogin(saved: readonly SavedLogin[], texts: readonly string[]): SavedLogin | null {
  const hosts = texts.flatMap(hostsIn);
  return saved.find((s) => hosts.some((h) => h === s.site || h.endsWith(`.${s.site}`))) ?? null;
}

// `npm run login:add -- <site> <username>`: link an existing Keychain item, or save a new one.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [site, username] = process.argv.slice(2);
  if (!site || !username) {
    console.error("usage: npm run login:add -- <site> <username>");
    process.exit(1);
  }
  if (!keychainPassword(site, username)) {
    // Prompt without echo, then hand the value straight to the Keychain.
    process.stdout.write(`Password for ${username} at ${site} (not shown): `);
    process.stdin.setRawMode?.(true);
    let password = "";
    let done = false;
    for await (const chunk of process.stdin) {
      // Character by character: a pasted password arrives as one chunk ending in Enter.
      for (const c of String(chunk)) {
        if (c === "\u0003") process.exit(130);
        if (c === "\r" || c === "\n") { done = true; break; }
        password = c === "\u007f" ? password.slice(0, -1) : password + c;
      }
      if (done) break;
    }
    process.stdin.setRawMode?.(false);
    process.stdout.write("\n");
    execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-s", site, "-a", username, "-l", `Agent inbox login: ${site}`, "-w", password]);
  }
  const index = readIndex(DEFAULT_INDEX).filter((e) => e.site !== site);
  writeFileSync(DEFAULT_INDEX, `${JSON.stringify([...index, { site, username }], null, 2)}\n`);
  console.log(`saved login for ${site} (${username}); the password is in the macOS Keychain only`);
}
