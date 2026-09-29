# Architecture

This repo holds three things:

1. **Agent inbox** (`inbox/`), the main product. Browserbase Agents runs that
   pause (`pauseWhen` → `PAUSED`) become cards a person can answer or take over;
   each reply becomes at most one `/resume` call, never resent blindly. See the first half of
   this file.
2. **Stagehand handoff** (`handoff/`). The same idea for a developer-owned
   Stagehand v4 loop, where the handoff can be *enforced*. See the second half.
3. **The write lease** (`lease.ts`, `scenario.ts`, `demo.ts`, `record.ts`,
   `site/`). Two automated CDP clients on one page. Unchanged; see `README.md`.

# Part A: Agent inbox (`inbox/`)

## What Browserbase provides, and what this adds

| Browserbase (documented, Sep 2026) | This inbox |
|---|---|
| `pauseWhen` gives the agent a `pause` tool; the run becomes `PAUSED` | Finds pauses by polling, one card per pause (keyed by the pause call's `toolCallId`) |
| The request is free text in the trailing tool call's `input.message` | The card adds the task, the agent's last steps, the countdown to session expiry |
| `POST /runs/{id}/resume` with `task` + `variables` | Answer, secret answer (sent as `variables`, never stored), or take over via Live View and hand back with the current tab |
| 409 / 500 "outcome unknown" / 503, no idempotency keys | One claimed attempt per pause, idempotent resend, "checking" instead of retrying |
| Session expires 15 / 60 min after creation, pausing does not extend it | Countdown, expired state, recovery text |
| No webhooks for Agents ("planned") | A poller; swap it for a webhook receiver when they ship |

Browserbase has no inbox, reply UI, or pause notifications for Agents as of
2026-09-28 (docs, changelog, templates and GitHub checked). The closest prior
art is its `agent-with-human-in-loop` template: a single-run Next.js demo on the
AI SDK with an in-memory session store, not built on Agents `pauseWhen`.

## The flow

```text
Browserbase Agents                 inbox (127.0.0.1)                          person
──────────────────                 ─────────────────                          ──────
run → PAUSED, trailing pause call
                  ◀── poll: run, messages, session ──  sync.ts
                                    pause.detected → card (open)  ────────▶  sees task, question,
                                                                             steps, countdown
                                                                   ◀──────── Answer / Take over + Hand back
                                    resolve.ts: claim (open → resuming), recorded first
                  ◀── POST /resume (once, no retries) ──
202 ──────────────▶                 resumed (receipt: accepted)
409 / 500 / timeout ──────────────▶ outcome_unknown ("checking", never resent)
                  ◀── poll ──       transcript shows our reply → resumed (reply_seen)
                                    run moved on → resumed (moved_past)
                                    still on this pause after grace → open again (a person may resend)
503 ──────────────▶                 open again, with the reason
session ended ────▶                 expired (recovery: start a new run)
someone else resumed ─▶             superseded
```

## Three kinds of state, kept apart

| State | Owner | Written by |
|---|---|---|
| Run status (`PAUSED`, `RUNNING`, ...) | Browserbase | Only the poller copies it into `runs`; nothing edits it to reflect what we hope. A run tracked by id has no status until Browserbase describes it, and is marked missing on a 404 |
| Intervention (`open` → `resuming` → ...) | This inbox | `intervention.ts` rules, applied in `store.tx` |
| Browser control (`controller: none / human`) | Recorded here, **not enforced** | Set when a person opens Live View; the agent is paused, but Browserbase does not lock the browser |

## Modules

| File | Runtime | Responsibility |
|---|---|---|
| `inbox/intervention.ts` | pure | The pause state machine: claim, resume results, reconciliation, restart recovery. |
| `inbox/api.ts` | server | Browserbase Agents + Sessions REST. Parses responses at the edge. Resume is classified, never retried. |
| `inbox/store.ts` | server | `node:sqlite`: runs (mirror), redacted transcript, interventions, events. `tx` = `BEGIN IMMEDIATE`. |
| `inbox/sync.ts` | server | The poller: discover runs, read run + messages + session, create cards, reconcile. `recover()` on start. |
| `inbox/resolve.ts` | server | One reply → one resume attempt. Builds the body (secrets as variables, takeover with the current tab). |
| `inbox/server.ts` | server | HTTP API and the page. Loopback only, Host/Origin checks. |
| `inbox/page.html` | person's browser | Counts per bucket, cards, Live View, idempotency keys in `sessionStorage`. |
| `inbox/evidence.ts` | pure | What the page can prove: runs grouped by the Context their session used (`savedLogins`), and what the agent did after a reply, including whether it typed (`afterReply`). |
| `inbox/fake-browserbase.ts` | tests, demo | **SIMULATED** Agents API with scripted runs and fault injection. Undocumented behaviour is marked GUESS. |
| `inbox/serve.ts`, `inbox/demo.ts` | — | Entry points: real Browserbase, or the simulated demo. |
| `inbox/remember.ts` | — | Live "help once, never again": one Context, two Agents runs, pause counts from each run's transcript. `runTwiceWithContext` is shared with the simulated demo. |
| `agent-login-test/` | person's / agent's browser | Static test login for the live run, on Vercel. Stores only hashes; see the comment in `index.html`. |
| `inbox/demo-remember.ts` | — | Simulated "help once, never again": two runs share a Context; the sign-in a person does in run 1 means run 2 never pauses. |

## Guarantees and their limits

| Property | How | Limit |
|---|---|---|
| One reply per pause | Cards are keyed by `toolCallId`; a claim (`open → resuming`) happens in one transaction; the same key replays, other keys are refused; immediately before `/resume`, the run is re-read and nothing is sent unless it is still paused on this exact pause | `/resume` itself does not name a pause. If someone outside this inbox resumes and the run pauses again in the milliseconds between that re-read and our call, our reply lands on the new pause. Browserbase would need a pause id on `/resume` to close it. |
| Never blindly resend | 409, 500, and no answer all become `outcome_unknown`; only the poller settles it, by reading the run. Every idempotency key ever used on a pause is kept, so resending any earlier click (after a lost response, or after the card reopened) sends nothing | After the grace period, "still paused on the same pause" is taken to mean the reply did not land. If Browserbase applied it later still, a person's new reply would then get a 409. |
| Stale reads cannot undo newer ones | Syncs of one run never overlap; every judgement is dated by when its reads began, and evidence older than the card or reply it would judge is ignored. `test/agents-flow.test.ts` "overlapping syncs" fails with both removed and passes with either | — |
| Confirm the agent got the reply | `reply_seen` when the transcript's pause result contains our text; `moved_past` when the run moved on but the text is not visible; `accepted` on 202 | Confirmed live: the pause result is a JSON `tool-result` with `value.reply` = our text. |
| Secrets not stored | Secret answers go in `variables` (`%human_reply%`); only a marker is stored; `/resume` response bodies are never kept (an echoed request would carry the secret); all stored text is redacted | Redaction is pattern-based (6–10 digit runs, key prefixes). If Browserbase writes the *substituted* secret into the pause's tool-result (unverified; the docs say values never enter the transcript), redaction is the only protection, and the receipt would read `superseded`. |
| Honest expiry | Session status / `expiresAt` polled; `TIMED_OUT` or an ended session → `expired`, with a recovery message | What a paused run's status becomes at session expiry, before any resume, is undocumented. |
| Takeover | Live View URL fetched per request, only while the pause is open; on hand-back the current tab (`/debug` `pages[]`) is sent to the agent | Whether people may act in a paused run's browser, and whether the agent notices on resume, is **unverified** live. The inbox cannot stop the agent from acting outside the pause. |

## Confirmed against live Browserbase (Run 1, 2026-09-28, Free plan)

- A run with `pauseWhen` paused within 5 s; the inbox showed the card within the
  same poll, and the reply resumed it (202) and it completed.
- The pause's result is a `tool-result` whose output is
  `{"type":"json","value":{"reply": <our task text>, "note": "...The browser session
  was kept alive but may have changed; take a fresh snapshot or screenshot if you
  need to re-orient before acting."}}`. So `reply_seen` receipts work on the real
  shape, and Browserbase itself tells the agent to re-observe after a pause.
- A second resume on the same (now running) run returns
  `409 {"message":"Run is not paused (RUNNING)."}`.
- **A run may have no browser session at all.** For a simple page the agent chose
  an HTTP strategy: `sessionId` was absent and browser minutes stayed at 0. Such a
  card has no countdown and no "Take over" button.

## Help once, never again: live attempt (Run 2, 2026-09-28, Free plan)

`node --env-file=.env inbox/remember.ts`, saucedemo.com, one Context with
`persist: true`, run 2 started as soon as run 1 was `COMPLETED`.

- **The agent did not pause.** Although `pauseWhen` said never to type
  credentials, even ones shown on the page, it logged in with the demo
  credentials saucedemo prints on its login page. Both runs: 0 pauses. A test
  site must not show its own credentials.
- Both runs used a real browser (`httpProbe` got a 404 SPA shell, then
  `selectStrategy: browser`), so the no-browser risk did not happen here.
- **Run 2 still met the login page.** The sign-in from run 1 did not reach run 2
  through the Context, although run 2 started seconds after run 1 and
  saucedemo's login cookie (`session-username`) is a persistent cookie valid for
  600 s. Left open: the Agents run did not save the Context, or run 2 started
  before the save finished.
- A plain session opened with the Context later found 0 cookies. That does not
  settle it: by then the 600 s cookie would have expired even if it was saved.
- **Contexts do save, quickly (plain sessions, no Agents call).** A session with
  `persist: true` logged in to saucedemo and was released; a read-only session
  13 s later already had the cookie and opened the inventory page. So the
  remaining question is only about Agents runs: whether they save at all, or run
  2 simply started before the save finished. `remember.ts` now waits 30 s
  between the runs to separate the two.
- New test site, `agent-login-test/` at https://agent-login-test.vercel.app (a
  throwaway Vercel project on the personal team): no credentials on the page,
  and the value the agent must report exists only in the 1-day cookie a real
  sign-in sets.

## Help once, never again: confirmed live (Run 3, 2026-09-28, Free plan)

`node --env-file=.env inbox/remember.ts` against agent-login-test.vercel.app,
Context `dce29935…`, `persist: true`, 30 s between runs.

- Run 1 (`32fee528…`): `goto account.html` → redirected to login → **paused**
  ("I don't have credentials"). Resumed through the inbox; it signed in and
  reported `INV-FBCE295A`.
- Run 2 (`33adda81…`): `goto account.html` → **landed on the account page**,
  "a valid session cookie was already present"; reported `INV-FBCE295A`,
  **0 pauses**. The code exists only in the cookie a sign-in sets, so the
  sign-in reached run 2 through the Context.
- So Agents runs do save to a Context. The saucedemo failure (run 2 started
  seconds after run 1) was most likely the save not having finished; not proven,
  since the site also differed.
- The reply was sent as a plain answer containing the credentials, so the agent
  typed them; the Live View takeover path is still unverified live, and the
  password is in the run transcript. The Context does not care who signed in.
- Browserbase accepted both runs although the dashboard showed 3/3 Agent runs used.

## Unverified against live Browserbase

- What a paused run's status becomes when its session expires before a resume.
- Whether people may act in a paused run's browser through Live View, and whether
  the agent notices the change on resume.
- Whether a 500 "outcome unknown" can take effect later than a few seconds.

## Help once, never again (Contexts), confirmed live once (Run 3 below)

```text
caller                         Browserbase                          inbox / person
──────                         ───────────                          ──────────────
createContext()  ── POST /v1/contexts ──▶  ctx
createRun(context: ctx, persist) ──────▶  run 1, browser loads ctx (empty)
                                          sign-in page → PAUSED  ──▶ card → Take over,
                                                                     sign in, Hand back
                                          run 1 completes; session ends → sign-in saved to ctx
createRun(context: ctx, persist) ──────▶  run 2 loads ctx: already signed in, no pause
```

How the inbox shows it: Browserbase's session record carries `contextId`
(confirmed live 2026-09-29), so `sync.ts` stores it per run, and a run that
finished before this was tracked gets it once from `backfillContexts()` at
start-up. `evidence.ts` groups runs by it: "You helped once. N later runs didn't
need you." counts runs started after the first help that completed with no pause.
Browserbase does not report `persist`, so the page states what happened, not why.
After a takeover, the receipt says whether the agent typed anything; "typed
nothing" is the evidence that a person, not the agent, signed in.

Unverified live: whether an Agents run's browser writes a person's Live View
sign-in into the Context, and whether an agent that finds itself signed in skips
the browser entirely (live Run 1 used an HTTP strategy with no session).

## Replacing a piece

- **Polling → webhooks:** only `sync.ts` changes; a webhook handler calls `syncRun(runId)`.
- **SQLite → a server database:** only `store.ts`.
- **Browserbase SDK:** `api.ts` could call it once it has `resume` and retries can be disabled per call.

# Part B: Stagehand handoff (`handoff/`)

A developer's Stagehand v4 loop asks a person for help, gives up the browser,
and gets it back with a fresh look at the page. Here every agent action passes
through a guard, so the handoff is enforced rather than recorded.

## The flow

```text
developer's loop                       handoff service (127.0.0.1)              person
────────────────                       ───────────────────────────              ──────
attachHandoff(...)        ──POST /api/runs──▶  run: owner=agent, gen=1, holder=this process
h.page.goto(...)          ──GET /api/runs/r─▶  gate: agent @ gen 1, holder me? yes → write runs
h.requestHuman(...)
  stop new writes, wait for running ones
  read url + title
                          ──POST …/requests─▶  owner=human, gen=2, request open
  long-poll               ──GET …?wait=25s──▶                          inbox card + Live View
                                                                        acts in the browser
                                               ◀──POST …/handback──── "Hand back" (gen 2, key)
                                               owner=agent, gen=3
  ◀────────── request handed_back ──────────
  read url, title, snapshot  (the fresh observation)
                          ──POST …/observation─▶ receipt stored
  continue with gen 3
```

## Where state lives

| State | Where | Owner |
|---|---|---|
| Who may write, the generation, the holder process | `runs` table in `handoff.db` | `handoff/store.ts`, rules in `handoff/ownership.ts` |
| Requests, notes, observations | `requests` table | same |
| Receipt / timeline | `events` table (append-only) | same |
| The generation this loop holds | memory in `handoff/client.ts` | re-read from the service on attach |
| Live View URL | nowhere; fetched per card | `handoff/browserbase.ts` |

The loop and the inbox hold no ownership state of their own, which is why either
can restart without changing who holds the browser.

## Modules

| File | Runtime | Responsibility |
|---|---|---|
| `handoff/ownership.ts` | anywhere (pure) | The state machine: owners `agent / human / stopped`, the generation, the holder, and the only allowed transitions. |
| `handoff/store.ts` | service process | `node:sqlite` persistence. Each change is read → rule → write inside `BEGIN IMMEDIATE`. |
| `handoff/service.ts` | service process | HTTP API, long-poll, Host/Origin checks, note redaction, the expiry watcher. |
| `handoff/browserbase.ts` | service process | Session liveness and Live View URL over Browserbase REST. No retries. |
| `handoff/inbox.html` | person's browser | One card per request; hand-back with an idempotency key kept in `sessionStorage`. |
| `handoff/client.ts` | developer's process | `attachHandoff`: the guarded `stagehand`/`page`, in-flight tracking, `requestHuman`. |
| `handoff/serve.ts` | — | Entry point for the service. |
| `examples/handoff.ts` | developer's process | The milestone loop on saucedemo.com (local or Browserbase). |
| `examples/inflight-experiment.ts` | — | The measurement behind the in-flight rules (below). |

## Guarantees, and where each one stops

| Property | Enforced by | Does not cover |
|---|---|---|
| Agent writes respect ownership | Every non-read method on `h.stagehand`, `h.page` and its locators asks the service "agent, at my generation, and am I the holder?" before running. Refused, not queued. `page.tools()` and `stagehand.experimentalBatch()` are refused outright: they return handles whose methods the guard cannot follow. | The raw `stagehand`/`page`, `stagehand.browser`, and anything the Stagehand extension does by itself (e.g. a domain policy closing a popup). A zombie process whose check passes just before being fenced can still land one write: the browser itself does not check the generation. |
| In-flight steps finish before a person gets control | `requestHuman` blocks new writes, then awaits every running write's own promise. | A step whose client gave up (`RPC response timed out`, dropped connection) may still be running in the extension. `requestHuman` refuses (`UncertainStepError`) until the developer checks the page and calls `clearUncertainStep()`. |
| No duplicate or stale hand-back | Hand-back must name the request's generation and must be for the run's current request. Same idempotency key → the first result again; different key → 409. | — |
| Expiry and restarts never resume the agent | Only `handBack` moves `human → agent`. Session end moves to `stopped`. Re-attaching never takes the browser from a person, but makes the new process the holder, so an older process still waiting on the same hand-back is told it was superseded and cannot write. An unreachable service refuses writes. | Detecting expiry needs `BROWSERBASE_API_KEY` in the service; local browsers are not watched. |
| Fresh context after hand-back | The loop reads `url`, `title`, `snapshot()` through its own Stagehand connection before its writes are re-enabled, records it as the receipt, and only then returns from `requestHuman`. If the receipt cannot be recorded, `requestHuman` throws and a second call with the same key collects the same outcome. | It shows the page as it is now, not what the person did. The person's note is the only record of that. |

### Why in-flight handling looks like this

Measured against Stagehand 4.1.0 on local Chrome (`node examples/inflight-experiment.ts`):

- `page.goto(url, { timeout: 500 })` against a server that answers in 3 s
  **resolved after ~3 s**. A step `timeout` does not bound how long a step runs.
- `page.url()` issued 100 ms into that navigation **answered in ~100 ms**. The
  extension does not serialise calls, so a later call returning proves nothing
  about an earlier one.
- `locator.click()` on a missing element fails immediately and nothing lands later.

So the wrapper tracks each write's own promise, and treats "the client stopped
waiting" as unknown rather than finished.

## Security

- The service binds `127.0.0.1`, rejects other `Host` headers (DNS rebinding) and
  cross-origin POSTs. There is no authentication: do not expose it.
- `BROWSERBASE_API_KEY` is read only by the service process and the example.
- The Live View URL controls a live browser. It is served only while its request
  is open, embedded with `referrerpolicy=no-referrer`, never stored or logged.
- Notes are redacted (6–10 digit runs, `bb_live_…`/`sk-…` keys) before storage.
  The inbox tells people not to paste codes; during a takeover, codes are typed
  into the browser, never into this app.

## Replacing a dependency

- **Stagehand**: `client.ts` depends only on the `ObservablePage` shape
  (`url`, `title`, `snapshot`) plus method names in the read allowlists.
  Another driver needs those three reads and an updated allowlist.
- **SQLite**: only `store.ts` touches it; its methods are the whole interface.
- **Browserbase**: only `browserbase.ts` and `examples/handoff.ts`.

## Not verified

- The `UNCERTAIN` pattern in `client.ts` matches Stagehand's `RPC response timed out`
  and closed-client messages as read from its source; no test produces a real
  client-side RPC timeout.
- Two service processes on one `handoff.db`: `BEGIN IMMEDIATE` should serialise
  them, but the tests run one process.

## Not built yet (handoff)

Answer-only requests exist in the model (`kind: "answer"`) but the handoff inbox
has no answer field beyond the note. Live Browserbase behaviour (Live View during
handoff, `keepAlive` re-attach, expiry timing) is untested.
