/**
 * Evidence the inbox can show, derived only from what Browserbase reported and
 * what the inbox recorded. Pure: no I/O.
 *
 *   savedLogins  runs grouped by the Context their browser session used (the
 *                session record's `contextId`): who helped, and how many later
 *                runs with the same Context finished without asking anyone.
 *   afterReply   what the agent did after a person's reply, from its transcript,
 *                and whether it typed into the page itself. After a takeover
 *                "no typing" is the evidence that the person, not the agent,
 *                signed in.
 *
 * Browserbase does not report whether a run was set to save its Context
 * (`persist`), so a story says what happened, not why.
 */
import type { Intervention, RunStatus } from "./intervention.ts";
import type { StoredPart, StoredRun } from "./store.ts";

export interface StoryRun {
  readonly runId: string;
  readonly task: string;
  readonly status: RunStatus | null;
  readonly createdAt: number;
  readonly pauses: number;
  /** How a person resolved this run's first answered pause, if one was. */
  readonly helped: "takeover" | "answer" | "credentials" | null;
  readonly helpedAt: number | null;
}

export interface SavedLogin {
  readonly contextId: string;
  /** Oldest first. */
  readonly runs: readonly StoryRun[];
  /** Runs a person helped through this inbox. */
  readonly helps: number;
  /** Runs started after the first help that completed without pausing. */
  readonly laterWithoutHelp: number;
}

export function savedLogins(runs: readonly StoredRun[], interventionsFor: (runId: string) => readonly Intervention[]): SavedLogin[] {
  const byContext = new Map<string, StoryRun[]>();
  for (const run of runs) {
    if (!run.contextId) continue;
    const pauses = interventionsFor(run.runId);
    const help = pauses.find((i) => i.state === "resumed" && i.resolution !== null);
    const story: StoryRun = {
      runId: run.runId,
      task: run.task,
      status: run.status,
      createdAt: run.createdAt,
      pauses: pauses.length,
      helped: help?.resolution?.type ?? null,
      helpedAt: help?.resolvedAt ?? null,
    };
    byContext.set(run.contextId, [...(byContext.get(run.contextId) ?? []), story]);
  }

  return [...byContext.entries()]
    .map(([contextId, list]) => {
      const ordered = [...list].sort((a, b) => a.createdAt - b.createdAt);
      const firstHelp = ordered.find((r) => r.helpedAt !== null)?.helpedAt ?? null;
      const later = firstHelp === null ? [] : ordered.filter((r) => r.createdAt > firstHelp && r.status === "COMPLETED" && r.pauses === 0);
      return {
        contextId,
        runs: ordered,
        helps: ordered.filter((r) => r.helped !== null).length,
        laterWithoutHelp: later.length,
      };
    })
    .sort((a, b) => (b.runs.at(-1)?.createdAt ?? 0) - (a.runs.at(-1)?.createdAt ?? 0));
}

/** Run ids that started after a person helped with the same saved login and completed without pausing. */
export function skippedLogin(stories: readonly SavedLogin[]): Set<string> {
  const ids = new Set<string>();
  for (const story of stories) {
    const firstHelp = story.runs.find((r) => r.helpedAt !== null)?.helpedAt ?? null;
    if (firstHelp === null) continue;
    for (const r of story.runs) if (r.createdAt > firstHelp && r.status === "COMPLETED" && r.pauses === 0) ids.add(r.runId);
  }
  return ids;
}

export interface AfterReply {
  /** Tool names, in order, until the next pause. */
  readonly steps: readonly string[];
  /** A step typed or filled text into the page. */
  readonly typed: boolean;
}

const TYPING_TOOLS = new Set(["type", "fill", "typeText", "fillForm"]);
/** Actions inside a batch call (live shape, 2026-09-28): `{"actions":[{"action":"type",...}]}`. */
const TYPING_ACTION = /"action"\s*:\s*"(type|fill)"/;

export function afterReply(parts: readonly StoredPart[], pauseCallId: string): AfterReply | null {
  const replied = parts.findIndex((p) => p.kind === "tool-result" && p.toolCallId === pauseCallId);
  if (replied === -1) return null;
  const steps: string[] = [];
  let typed = false;
  for (const part of parts.slice(replied + 1)) {
    if (part.kind !== "tool-call" || !part.toolName) continue;
    if (part.toolName === "pause") break;
    steps.push(part.toolName);
    if (TYPING_TOOLS.has(part.toolName) || TYPING_ACTION.test(part.text)) typed = true;
  }
  return { steps, typed };
}

export interface Metrics {
  /** Pauses open now, and how long the oldest has been waiting. */
  readonly waiting: { readonly count: number; readonly oldestMs: number | null };
  /** From a pause appearing to a person's reply being delivered, over every pause resolved here. */
  readonly timeToHelp: { readonly medianMs: number | null; readonly count: number };
  /** Pauses whose browser ended before anyone helped. */
  readonly missed: number;
  /** Completed runs that never paused, out of all completed runs. */
  readonly finishedWithoutPerson: { readonly count: number; readonly of: number };
  /** Runs started after a person helped with the same saved login, that completed without pausing. */
  readonly afterSavedSignIn: number;
}

export function metrics(runs: readonly StoredRun[], interventionsFor: (runId: string) => readonly Intervention[], now: number): Metrics {
  const all = runs.flatMap((r) => interventionsFor(r.runId));
  const open = all.filter((i) => i.state === "open");
  const helpTimes = all
    .filter((i) => i.state === "resumed" && i.resolution !== null && i.resolvedAt !== null)
    .map((i) => (i.resolvedAt ?? 0) - i.pausedAt)
    .sort((a, b) => a - b);
  const mid = helpTimes.length / 2;
  const median =
    helpTimes.length === 0 ? null : helpTimes.length % 2 ? (helpTimes[Math.floor(mid)] ?? null) : ((helpTimes[mid - 1] ?? 0) + (helpTimes[mid] ?? 0)) / 2;
  const completed = runs.filter((r) => r.status === "COMPLETED");
  return {
    waiting: { count: open.length, oldestMs: open.length ? now - Math.min(...open.map((i) => i.pausedAt)) : null },
    timeToHelp: { medianMs: median, count: helpTimes.length },
    missed: all.filter((i) => i.state === "expired").length,
    finishedWithoutPerson: { count: completed.filter((r) => interventionsFor(r.runId).length === 0).length, of: completed.length },
    afterSavedSignIn: savedLogins(runs, interventionsFor).reduce((n, s) => n + s.laterWithoutHelp, 0),
  };
}
