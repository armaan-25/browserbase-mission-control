# Mission Control for Browserbase Agents

Browserbase Agents can pause for a person (`pauseWhen`, shipped 2026-09-24), but a
paused run is only an API state: nothing tells anyone, shows them what the agent
needs, or delivers their reply safely. This is that missing half: a wall of live
agent browsers where a stuck agent stands out, and a person can answer, take over
the browser, or sign it in with a saved login. Each reply becomes at most one
`/resume` call, and when Browserbase's answer is lost the app checks the run
instead of sending again. (Exactly-once delivery would need Browserbase to accept
a pause id on `/resume`; see `ARCHITECTURE.md`.)

## What it does

- **Mission Control**: one tile per run with its Live View; a run waiting on a
  person turns orange with the agent's own question and a countdown to its
  browser's end. Real metrics: waiting, median time to help, missed, finished
  without a person, runs that reused a saved sign-in.
- **Answer, take over, or sign in**: reply in one field; take over the live
  browser and hand it back; or send a saved login.
- **Saved logins**: passwords stay in the macOS Keychain and reach the agent only
  as Browserbase `variables` (`%login_password%`). Verified on real runs: the
  value never appears in the run's transcript. `npm run login:add -- <site> <user>`.
- **Bulk**: "Sign in all N" / "Answer all N" when several agents are stuck on the
  same site or question, still one delivery per agent.
- **Password guard**: a plain-text answer that looks like a secret is held back.
- **Honest state**: a paused run whose browser has ended shows as expired, even
  though Browserbase still reports `PAUSED`.

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
npm run inbox:loom                       # SIMULATED 5-act walkthrough, paced by Enter (port 4825)
npm run inbox                            # real Browserbase runs (BROWSERBASE_API_KEY in .env)
node --env-file=.env inbox/remember.ts   # real: 2 Agents runs sharing one Context
npm test
```

`agent-login-test/` is the login site the live runs use
(https://agent-login-test.vercel.app): it shows no credentials, and what the
agent must report exists only in the cookie a real sign-in sets.

Design, guarantees and limits: `ARCHITECTURE.md`. Concepts: `LEARNING.md`.
