/** Small helpers shared by the inbox tests. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh SQLite path in its own temp directory. */
export function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "inbox-")), "inbox.db");
}

/** The value, or a test failure naming what was missing. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** Poll until `check` passes; fails the test after `ms`. */
export async function eventually(check: () => Promise<boolean> | boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
