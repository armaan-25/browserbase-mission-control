# Learning notes

Concepts and library behaviour this code depends on, tied to where they appear.

## Idempotency keys (`resolve.ts`, `page.html` `keyFor`)

The page creates one key per attempt at a pause and keeps it in `sessionStorage`.
A resend after a lost response, a refresh, or a double-click carries the same key,
and the inbox answers it with the recorded outcome instead of a second `/resume`.
A different key on a pause that already has a reply is refused. Every key ever
used on a pause is kept, so no earlier click can send twice.
## `BEGIN IMMEDIATE` in SQLite (`store.ts` `tx`)

A plain `BEGIN` takes the write lock only at the first write, so two transactions
could both read "open" before either writes. `IMMEDIATE` takes it at the start;
the second waits (`busy_timeout`) and then reads the first one's result. The
"duplicate replies" test in `test/agents-flow.test.ts` fires concurrent clicks
and exactly one `/resume` is sent.
## `node:sqlite`

Built into Node 22.5+ (`DatabaseSync`, prepared statements, synchronous).
Synchronous is fine here: one small local database, and it keeps each
transaction free of interleaving `await`s. Node prints an ExperimentalWarning on
first use.

## Agent inbox (`inbox/`)

### Three state machines that must not be merged

Browserbase's run status, our intervention state, and browser control answer
different questions, and they disagree in the cases that matter. After a resume
times out, the run may be `RUNNING` while our record is `outcome_unknown`: both are
true. Collapsing them into one field would force us to guess. `runs` is only ever
a copy of what Browserbase said; `interventions` is only ever changed by the rules
in `intervention.ts`.

### Write-ahead claim (`resolve.ts`)

The pause is marked `resuming`, with the attempt's key, *before* `/resume` is
called. If the process dies during the call, the record says "a resume may have
gone out", and `recover()` turns it into `outcome_unknown` on the next start.
Rejected alternative: record only after the call. A crash would then leave the
card `open`, inviting a second reply to a pause that was already answered.

### "Unknown" is a state, not an error

A 500 "Resume outcome is unknown", a timeout, and a 409 all mean the same thing
to the inbox: we cannot say whether the agent got the reply. Retrying could
deliver it twice; giving up could lose it. So the card waits in
`outcome_unknown` and the poller settles it from evidence: the transcript shows
our reply (`reply_seen`), the run moved on (`moved_past`), or the run still sits
on the same pause after a grace period (reopen, and let a person decide).

### Check-then-act, narrowed (`resolve.ts` `pausedOn`)

`/resume` has no "only if still on pause X" condition, so the inbox re-reads the
run immediately before calling it. This is not atomic (a compare-and-swap would
need Browserbase to accept a pause id), but it shrinks the window from a poll
interval to milliseconds. The limit is written down rather than hidden.

### Why not the Browserbase SDK here

`@browserbasehq/sdk` 2.21.0 has no `resume`, and its client retries 409 and 5xx
by default, including POSTs. For `/resume` that is the one behaviour the inbox
must never have. `api.ts` uses `fetch` with a timeout and no retries. Retries can be turned off per call (`{ maxRetries: 0 }`), so `resume` is the only real blocker; the changelog's `bb.agents.runs.resume` example is not in the published package.

### A simulator instead of mocks (`fake-browserbase.ts`)

Tests run the real HTTP client against a local server that speaks the documented
API, so the code under test is the code that will talk to Browserbase. Faults are
injected on the server side (`unknown_applied`, `hang_applied`, ...), which is the
only way to produce "the resume worked but the response was lost" on demand.
Anything the docs do not specify is marked GUESS in that file; the live tests are
what check those guesses.

### Help once, never again: Contexts (`api.ts` `createContext`, `demo-remember.ts`)

A Browserbase Context is a saved browser profile (cookies, storage). `POST
/v1/contexts` makes one; a run started with `browserSettings.context: { id,
persist: true }` loads it, and whatever happened in that browser, such as a person
signing in during a takeover, is saved back when the session ends. The next run
with the same id starts signed in, so the agent never reaches the pause.

The inbox does not start runs; whoever does (the developer's code, here the demo)
chooses the Context per run. One Context per site-and-account is the natural key:
two accounts on one site need two Contexts. The save happens at session **end**, so
a second run started while the first is still going does not see the sign-in yet.

The simulator models a Context as the set of sites a browser is signed in to
(`FakeSession.signedIn`), which is enough to produce the 1 → 0 pauses outcome.
`test/agents-flow.test.ts` checks it both ways: `persist: true` gives zero cards
on run 2, `persist: false` gives a card again.

### Browserbase Agents facts this relies on (docs, 2026-09-27)

- Runs without `pauseWhen` never pause; with it, the agent decides when to.
- The request is the trailing `pause` tool call; its `input.message` is free text.
- `/resume` takes `task` (the reply) and `variables` (`%name%` placeholders, values
  never in the transcript). The resumed run does not keep the original variables.
- A paused run's session times out 15 min (free) / 60 min (paid) after it was
  created; pausing does not extend it. A paused run cannot be stopped (409).
- No webhooks for Agents yet; integration is poll-based.
- `POST /v1/agents/runs` accepts `browserSettings.context { id, persist }`;
  `persist` defaults to false (docs, checked 2026-09-28).
