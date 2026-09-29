# Learning notes

Concepts and library behaviour this code depends on, tied to where they appear.

## Fencing tokens (`handoff/ownership.ts`)

A lease says who holds something now. A fencing token says whether a writer is
still the one that was given it. Each change of owner increments `generation`,
each attached loop process gets a `holder` id, and every write must present both.
A process that was paused, restarted, or left behind is refused.

Why both: the first version used the generation alone, and review found the gap.
If a loop restarts while a person holds the browser, the old and new process wait
on the same hand-back and both read the same new generation from it. The holder
id says which of them the run now belongs to (`test/client.test.ts`, "restart
during a handoff").

Rejected alternative: the TTL lease in `lease.ts`. Its expiry hands the page to
the next waiter, which is correct between two scripts and wrong for a person, who
would lose the browser mid-task. Here nothing but an explicit hand-back returns
control to the agent.

## Idempotency keys (`service.ts`, `inbox.html`)

The inbox creates one key per card and keeps it in `sessionStorage`. A resend
after a lost response carries the same key, and the service answers it with the
stored result (`replay: true`) instead of a second transition. A different key on
an already-handed-back request is a genuine second click and gets 409.

## Long polling (`service.ts` `waitForChange`, `client.ts` `awaitOutcome`)

The loop asks "has this request changed?" and the service holds the response open
for up to 25 s. The outcome is stored before anyone is woken, so a dropped poll is
harmless: the loop asks again and gets the same stored answer. Rejected
alternative: server-sent events, which need reconnection and replay logic for the
same guarantee.

## `BEGIN IMMEDIATE` in SQLite (`store.ts`)

A plain `BEGIN` takes the write lock only at the first write, so two transactions
could both read "open" before either writes. `IMMEDIATE` takes it at the start;
the second waits (`busy_timeout`) and then reads the first one's result. The
"concurrent hand-backs" test fires three at once and exactly one wins.

## `node:sqlite`

Built into Node 22.5+ (`DatabaseSync`, prepared statements, synchronous).
Synchronous is fine here: one small local database, and it keeps each
transaction free of interleaving `await`s. Node prints an ExperimentalWarning on
first use.

## `Proxy` as a guard (`client.ts` `guard`)

`h.page` is a `Proxy` over the real Stagehand `Page`. Its `get` trap returns
reads unchanged and wraps every other method in the ownership check. Unknown
methods are treated as writes, so a new Stagehand method is refused until someone
decides it is a read. Methods are applied with the real object as `this`, so
Stagehand's own getters and private members keep working
(`test/stagehand-local.test.ts` checks this against the real classes).

## Stagehand v4 facts this relies on

- `browserbase.launch({ apiKey, keepAlive, api_timeout })` creates a session.
  The SDK field is `api_timeout`; it is sent to the API as `timeout`.
- With `keepAlive: true`, `browser.close()` leaves the session running, and
  `browserbase.connect({ apiKey, sessionId })` attaches to it again.
- Omitting `model` routes inference through Model Gateway (billed by Browserbase).
  Gateway needs a Browserbase session: locally, `act()` fails even when replaying
  a fixed `Action`, so local tests use `page`/`locator` calls only.
- A step's `timeout` is not an upper bound, and calls are not serialised (see
  `ARCHITECTURE.md`, measured by `examples/inflight-experiment.ts`).

## Dependency added

`@browserbasehq/stagehand@4.1.0`: the agent runtime the handoff wraps. Without
it the guard has nothing real to wrap and the Browserbase launch/connect
lifecycle would be reimplemented by hand. It brings `@browserbasehq/sdk`, `zod`
and OpenTelemetry with it. To learn: `browserbase.launch/connect`,
`Stagehand.create`, `act/observe/extract`, and `Page`/`Locator`.

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
must never have. `api.ts` uses `fetch` with a timeout and no retries.

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
