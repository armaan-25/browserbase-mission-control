/**
 * Bake one run of the collision and the fix into a static bundle.
 *
 *   node mutex/record.ts        →  mutex/site/frames.json
 *
 * The live version needs Node driving real Chromium, so it cannot be a link
 * someone clicks. This captures the same two runs once and writes them as
 * timestamped frames; `site/index.html` replays them with no server, which
 * makes the demo a URL instead of a repo.
 *
 * The frames are photographs of a real run, not a re-enactment: every pixel
 * came out of a browser that was actually being written to by two clients.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { FIELDS, openCheckout, runLeased, runUnmediated, type Progress } from "./scenario.ts";

const OUT = new URL("./site/", import.meta.url).pathname;
const FPS = 10;

type Run = "raw" | "leased";
interface Event {
  readonly t: number;
  readonly run: Run;
  readonly kind: "shot" | "log" | "verdict";
  readonly data?: string;
  readonly text?: string;
  readonly lease?: boolean;
  readonly filled?: number;
  /** Total fields in play, so the page never hardcodes a count. */
  readonly of?: number;
  /** Where the run actually ended up: the outcome, not the field count. */
  readonly reached?: string;
}

const events: Event[] = [];
const t0 = Date.now();
const push = (e: Omit<Event, "t">) => events.push({ t: Date.now() - t0, ...e });

/** Progress reported as timestamped events the page can replay. */
function recorder(run: Run): Progress {
  return {
    log: (text, lease) => push({ run, kind: "log", text, lease }),
    verdict: (filled, reached) => push({ run, kind: "verdict", filled, of: FIELDS, reached }),
  };
}

/** Stream the page until stopped. This is what makes the site real footage. */
function capture(page: Page, run: Run): () => void {
  let on = true;
  void (async () => {
    while (on) {
      try {
        const shot = await page.screenshot({ type: "jpeg", quality: 50 });
        push({ run, kind: "shot", data: shot.toString("base64") });
      } catch {
        // Navigation tears the capture target down mid-shot; next frame recovers.
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 / FPS));
    }
  })();
  return () => {
    on = false;
  };
}

/** Session first, capture second: the recording is only the contested part. */
async function record(run: Run, play: (page: Page, progress: Progress) => Promise<void>) {
  const page = await openCheckout(browser);
  push({ run, kind: "log", text: "signed in · 3 items in cart · checkout open" });
  const stop = capture(page, run);
  await play(page, recorder(run));
  stop();
}

const browser = await chromium.launch({ headless: true });
console.log("recording both runs…");
// Concurrently, so the two panes play in step when replayed side by side.
await Promise.all([record("raw", runUnmediated), record("leased", runLeased)]);
await browser.close();

mkdirSync(OUT, { recursive: true });
const json = JSON.stringify(events);
writeFileSync(`${OUT}frames.json`, json);

const shots = events.filter((e) => e.kind === "shot").length;
console.log(`${events.length} events (${shots} frames) → ${OUT}frames.json`);
console.log(`${(json.length / 1024 / 1024).toFixed(1)} MB`);
