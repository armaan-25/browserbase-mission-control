# Browser write lease

Two CDP clients on one browser page. One destroys the other's work, silently.
This is that collision reproduced, and a small coordination layer that stops it.

Stagehand v4 moved state management into the browser and let other clients
attach alongside it. The launch post names the hazard directly:

> "What they can still do is step on each other inside the browser. Two clients
> that navigate or close the same page, set cookies, or intercept requests, are
> both writing to the same state, and nothing in CDP monitors that."
>
> [Browserbase, Stagehand v4](https://www.browserbase.com/blog/stagehand-v4), 10 Aug 2026

## The collision

Both runs start from the same real session on
[saucedemo.com](https://www.saucedemo.com): signed in, three items in the cart,
checkout open. Then one client fills the checkout form while a second client
navigates the same page.

Without coordination the first client loses a login, three cart additions and a
page of form entry, and **no error is raised on either side**. It keeps typing
into a page that no longer exists. Worse than a crash: the page it lands on
looks perfectly healthy, so an agent would report success.

With a write lease the second client's navigation queues, the first finishes
checkout, and the navigation runs afterwards. Deferred, never dropped.

## Files

| Path | What it is |
| --- | --- |
| `lease.ts` | The mechanism. ~140 lines, no browser dependencies. |
| `demo.ts` | Terminal proof: prints the before and after. |
| `record.ts` | Drives both runs against the live site, bakes frames for the page. |
| `site/` | Static page replaying a real recorded run. Two files, no server. |
| `browser-write-lease.mp4` | 14s recording of that page, for posting. |

## Run it

```bash
node mutex/demo.ts                       # local Chrome, free
node --env-file=.env mutex/demo.ts --remote   # a real Browserbase session

node mutex/record.ts                     # re-record site/frames.json
cd mutex/site && python3 -m http.server 4790
```

## Design

**A lease, not a lock.** Every grant carries a TTL. An automation client dying
between acquire and release is the normal case, not the exception, and a plain
mutex would wedge the page forever. Expiry turns deadlock into a detectable
late write (see `isHeldBy`).

**Reads never queue.** Concurrent reads cannot corrupt state, and blocking them
would make this a bottleneck rather than a guardrail.

**Page-scoped, not browser-scoped.** `pageId` is just a string key; the lease
imports nothing from Playwright or CDP. Arbitration is not a browser concern.

**Opt-in.** Clients route writes through `withWrite`. Transparent enforcement
would mean proxying the CDP websocket and classifying every command as read or
write, which is strictly more powerful and a different project.

Browserbase say they are "working on adding functionality to drive both from a
single script". This is the complementary case: two clients that already exist
independently and cannot be merged into one script.

## Honesty notes

The frames in `site/` are screenshots of an actual run against the live site,
replayed. Every pixel came out of a browser that was genuinely being written to
by two clients. saucedemo.com is Sauce Labs' public automation-practice app and
the run uses its own published demo credentials. Nothing is submitted; the
collision happens while typing, and the Finish button is never clicked.
