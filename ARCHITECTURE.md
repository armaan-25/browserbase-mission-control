# Architecture

An inbox for Browserbase Agents runs. Runs that pause (`pauseWhen` → `PAUSED`)
become cards a person can answer or take over; each reply becomes at most one
`/resume` call, never resent blindly. When runs share a saved login (a
Browserbase Context), a person's sign-in carries over and later runs do not
pause ("help once"). Code: `inbox/`; test login site: `agent-login-test/`.


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
- **Browserbase SDK:** `api.ts` could call it once the SDK has `runs.resume` (2.21.0 does not). Its default retries (409, 5xx) must then be turned off per call with `{ maxRetries: 0 }`, which the SDK already supports.
