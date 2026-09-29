# Agent inbox for Browserbase Agents

Browserbase Agents can now pause for a person (`pauseWhen`, shipped 2026-09-24),
but a paused run is only an API state: nothing tells anyone, shows them what the
agent needs, or delivers their reply safely. `inbox/` is that missing half: an
inbox of paused runs where a person answers or takes over the live browser. Each
reply becomes at most one `/resume` call, and when Browserbase's answer is lost
the inbox checks the run instead of sending again. (Exactly-once delivery would
need Browserbase to accept a pause id on `/resume`; see `ARCHITECTURE.md`.)

## Help once

When runs share a saved login (a Browserbase Context with `persist: true`), a
person who takes over and signs in once is not asked again: the sign-in is saved
to the Context when the run ends, and later runs start signed in. The inbox reads
each run's Context from Browserbase's session record and shows the result ("You
helped once. 1 later run didn't need you."), plus whether the agent typed anything
after a hand-back. Confirmed live on 2026-09-28: pauses went 1 → 0.

## Run it

```bash
npm install
npm run inbox:demo                       # SIMULATED runs, free: http://127.0.0.1:4821
npm run inbox:remember                   # SIMULATED "help once": take over, sign in, watch run 2
npm run inbox                            # real Browserbase runs (BROWSERBASE_API_KEY in .env)
node --env-file=.env inbox/remember.ts   # real: 2 Agents runs sharing one Context
npm test
```

`agent-login-test/` is the login site the live runs use
(https://agent-login-test.vercel.app): it shows no credentials, and what the
agent must report exists only in the cookie a real sign-in sets.

Design, guarantees and limits: `ARCHITECTURE.md`. Concepts: `LEARNING.md`.
