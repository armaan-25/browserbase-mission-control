/**
 * Test doubles for handoff tests.
 *
 * `fakeAgent()` stands in for a Stagehand instance and its page. It records every
 * write that actually reaches it, so a test can assert "zero writes landed" rather
 * than only "an error was thrown". Its method names match Stagehand v4's so the
 * guard's read/write classification is exercised against the real names.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService, type RunningService } from "../handoff/service.ts";
import { openStore, type Store } from "../handoff/store.ts";
import type { BrowserbaseApi, Liveness } from "../handoff/browserbase.ts";

export function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "handoff-")), "handoff.db");
}

export interface Started {
  store: Store;
  service: RunningService;
  stop(): Promise<void>;
}

export async function start(
  dbPath = tempDb(),
  options: { browserbase?: BrowserbaseApi; expiryCheckMs?: number; port?: number } = {},
): Promise<Started> {
  const store = openStore(dbPath);
  const service = await startService({ store, ...options });
  return {
    store,
    service,
    async stop() {
      await service.close();
      store.close();
    },
  };
}

/** A Browserbase stand-in whose session liveness the test controls. */
export function fakeBrowserbase(initial: Liveness = "alive") {
  let liveness = initial;
  const api: BrowserbaseApi = {
    sessionAlive: async () => liveness,
    liveViewUrl: async () => "https://live.example.test/view",
  };
  return {
    api,
    set(next: Liveness) {
      liveness = next;
    },
  };
}

export function fakeAgent() {
  const writes: string[] = [];
  let url = "https://store.example.test/login";
  let title = "Login";

  interface FakeLocator {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
    type(text: string): Promise<void>;
    hover(): Promise<void>;
    textContent(): Promise<string>;
    isVisible(): Promise<boolean>;
    count(): Promise<number>;
    first(): FakeLocator;
    nth(i: number): FakeLocator;
  }
  const locator = (selector: string): FakeLocator => ({
    click: async () => void writes.push(`click ${selector}`),
    fill: async (value: string) => void writes.push(`fill ${selector}=${value}`),
    type: async (text: string) => void writes.push(`type ${selector}=${text}`),
    hover: async () => void writes.push(`hover ${selector}`),
    textContent: async () => "1",
    isVisible: async () => true,
    count: async () => 1,
    first: () => locator(`${selector} >> first`),
    nth: (i: number) => locator(`${selector} >> nth=${i}`),
  });

  const page = {
    url: async () => url,
    title: async () => title,
    snapshot: async () => ({ formattedTree: `[1] RootWebArea "${title}"`, xpathMap: {}, urlMap: {} }),
    screenshot: async () => new Uint8Array(),
    waitForTimeout: async () => undefined,
    goto: async (next: string) => {
      writes.push(`goto ${next}`);
      url = next;
      return null;
    },
    reload: async () => void writes.push("reload"),
    goBack: async () => void writes.push("goBack"),
    click: async (x: number, y: number) => void writes.push(`click ${x},${y}`),
    type: async (text: string) => void writes.push(`type ${text}`),
    keyPress: async (key: string) => void writes.push(`keyPress ${key}`),
    scroll: async () => void writes.push("scroll"),
    evaluate: async () => void writes.push("evaluate"),
    setViewportSize: async () => void writes.push("setViewportSize"),
    close: async () => void writes.push("close"),
    locator,
  };

  const stagehand = {
    act: async (instruction: string) => void writes.push(`act ${instruction}`),
    observe: async () => {
      writes.push("observe");
      return [];
    },
    extract: async () => {
      writes.push("extract");
      return {};
    },
    metrics: async () => ({}),
  };

  return {
    page,
    stagehand,
    writes,
    /** What a person does in Live View: changes the page without going through the agent. */
    humanNavigates(next: string, nextTitle: string) {
      url = next;
      title = nextTitle;
    },
  };
}

export async function json(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
