/**
 * What the inbox shows as evidence: saved-login stories grouped by Context, and
 * what the agent did after a person's reply. Pure functions, no server.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { afterReply, savedLogins } from "../inbox/evidence.ts";
import type { Intervention } from "../inbox/intervention.ts";
import type { StoredPart, StoredRun } from "../inbox/store.ts";

const run = (runId: string, createdAt: number, contextId: string | null, status: StoredRun["status"] = "COMPLETED"): StoredRun => ({
  runId,
  task: `task ${runId}`,
  status,
  missing: false,
  sessionId: `s-${runId}`,
  sessionStatus: "COMPLETED",
  sessionExpiresAt: null,
  contextId,
  cause: null,
  messageCursor: null,
  pausedOn: null,
  createdAt,
  updatedAt: createdAt,
  syncedAt: createdAt,
});

const helped = (runId: string, resolvedAt: number, type: "takeover" | "answer"): Intervention =>
  ({
    id: `${runId}:p`,
    runId,
    pauseCallId: "p",
    message: "sign in please",
    pausedAt: resolvedAt - 10,
    state: "resumed",
    resolution: { type, summary: "", sentTask: "", page: null },
    resolvedAt,
  }) as unknown as Intervention;

test("saved logins: a person helps once, and later runs with that Context that finished without a pause are counted", () => {
  const runs = [run("r3", 300, "ctx"), run("r1", 100, "ctx"), run("r2", 200, "ctx"), run("other", 150, null)];
  const byRun: Record<string, Intervention[]> = { r1: [helped("r1", 120, "takeover")] };
  const [story, ...rest] = savedLogins(runs, (id) => byRun[id] ?? []);
  assert.equal(rest.length, 0, "runs without a Context are not stories");
  assert.equal(story?.contextId, "ctx");
  assert.deepEqual(story?.runs.map((r) => r.runId), ["r1", "r2", "r3"], "oldest first");
  assert.equal(story?.runs[0]?.helped, "takeover");
  assert.equal(story?.helps, 1);
  assert.equal(story?.laterWithoutHelp, 2);
});

test("saved logins: runs before the first help, still running, or that paused again are not counted as 'didn't need you'", () => {
  const runs = [run("early", 50, "ctx"), run("r1", 100, "ctx"), run("paused-again", 200, "ctx"), run("running", 300, "ctx", "RUNNING")];
  const byRun: Record<string, Intervention[]> = {
    r1: [helped("r1", 120, "answer")],
    "paused-again": [{ ...helped("paused-again", 220, "answer"), state: "open", resolution: null } as unknown as Intervention],
  };
  const [story] = savedLogins(runs, (id) => byRun[id] ?? []);
  assert.equal(story?.laterWithoutHelp, 0);
  assert.equal(story?.runs.find((r) => r.runId === "paused-again")?.pauses, 1);
});

const part = (kind: string, toolName: string | null, toolCallId: string | null, text: string, createdAt: number): StoredPart => ({
  messageId: `m${createdAt}`,
  createdAt,
  role: kind === "tool-result" ? "tool" : "assistant",
  kind,
  toolName,
  toolCallId,
  text,
});

test("after a reply: the agent's next tool calls, and whether any of them typed into the page", () => {
  const takeover = [
    part("tool-call", "goto", "a", "{}", 1),
    part("tool-call", "pause", "p", '{"message":"sign in"}', 2),
    part("tool-result", "pause", "p", '{"reply":"done"}', 3),
    part("tool-call", "snapshot", "b", "{}", 4),
    part("tool-result", "snapshot", "b", "{}", 5),
    part("tool-call", "done", "c", "{}", 6),
  ];
  assert.deepEqual(afterReply(takeover, "p"), { steps: ["snapshot", "done"], typed: false });

  const typedItself = [
    part("tool-call", "pause", "p", "{}", 1),
    part("tool-result", "pause", "p", "{}", 2),
    // The live shape seen on 2026-09-28: a batch of actions.
    part("tool-call", "batch", "b", '{"actions":[{"action":"type","ref":"e6","text":"armaan"},{"action":"click","ref":"e9"}]}', 3),
  ];
  assert.deepEqual(afterReply(typedItself, "p"), { steps: ["batch"], typed: true });
});

test("after a reply: stops at the next pause, and is null until the reply is in the transcript", () => {
  const parts = [
    part("tool-call", "pause", "p", "{}", 1),
    part("tool-result", "pause", "p", "{}", 2),
    part("tool-call", "click", "b", "{}", 3),
    part("tool-call", "pause", "q", "{}", 4),
    part("tool-call", "type", "c", "{}", 5),
  ];
  assert.deepEqual(afterReply(parts, "p"), { steps: ["click"], typed: false });
  assert.equal(afterReply(parts.slice(0, 1), "p"), null);
});
