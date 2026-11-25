---
name: factory-sequence
description: Decide which tickets can be built side by side and which must wait, and put that schedule into the factory's swimlanes. Use when you are the Architect and a ticket has been planned, shipped or reprioritised, when the light refresh says a ticket has no lane, or when asked what can run in parallel.
---

# Swimlanes

Almost every project has work that cannot run in parallel: two tickets that
edit the same function, one that needs another's schema, a deploy slot only
one branch can use. A lane is a queue of tickets that would collide. Lanes
run side by side; inside a lane, one ticket at a time.

The work is split on purpose. **Scripts collect the evidence and enforce the
rules. You make the judgments a script cannot.** The script refuses a
schedule that is stale, leaves a ticket out, or contradicts the evidence, so
nothing reaches the factory on your say-so alone.

All commands are `node scripts/factory/sequence.mjs <command>`.

## Most days: the light refresh

```sh
node scripts/factory/sequence.mjs refresh
```

Run it after a plan is written and after a ticket ships. It collects a fresh
board, carries the last schedule forward and updates the factory's lanes,
with no judgment: tickets that left are dropped, a ticket now in flight
leads its lane. **Exit 3** means a ticket has no lane yet or the carried
schedule no longer fits. Only then do the full pass below.

## The full pass

**1. Collect.**

```sh
node scripts/factory/sequence.mjs collect
```

It prints every open ticket with its next step (`plan`, `review`, `build`,
`small-bug`, `later`, `in-flight`), the tracker's blockers, and every pair
of tickets that share a file. A ticket's files are what its plan's
`## Surfaces` declares plus what its branch has already changed. It also
prints `board_sha256` and where to write the schedule.

**2. Judge each shared file.** A shared file is a candidate collision, not a
verdict. For each pair, read both plans' touch lists:

- **They really collide** (the same function, the same region, or one
  builds on the other): same lane, in order.
- **They are independent** (different functions in a wide file, each adding
  its own keys to a registry or a strings file): record a `coordinate`
  entry naming the files, why the behaviours are independent, and the
  evidence you read. A clean merge alone proves nothing.
- **You did not judge it:** the script makes the later ticket wait for the
  earlier one to merge. Safe, and slow. Leaving wide files unjudged is how
  every pair ends up waiting.

**3. Write the schedule** to the path `collect` printed:

```json
{
  "board_sha256": "<from collect>",
  "lanes": [
    { "name": "Checkout", "tickets": ["APP-101", "APP-103"] },
    { "name": "Search", "tickets": ["APP-102"] }
  ],
  "coordinate": [
    { "a": "APP-101", "b": "APP-102", "files": ["src/strings.ts"],
      "reason": "Each adds its own keys; neither edits the other's.",
      "evidence": "Both plans, Touch list and Shapes" }
  ],
  "surface_reviews": {},
  "moved": []
}
```

Rules for building it:

- **Every lane is independent of every other lane, and its first ticket can
  start now.** Two tickets share a lane only when they would really collide
  or one depends on the other.
- **A ticket never changes lanes.** Start from the previous schedule. Add a
  new ticket to the lane it collides with, or to a new lane. Do not rebuild
  lanes around new work. If the founder asks for a move, list the ticket
  under `moved`.
- **Stay within the lane limit** (`lanes.max` in `factory.config.json`).
  The limit is the founder's attention and the machine's memory. When
  independent work would exceed it, queue it behind the lane it is closest
  to.
- **Group lanes by what they contend for.** If only one branch at a time can
  use a dev deploy slot or a device, tickets that need the same one belong
  in the same lane where no dependency says otherwise; otherwise every lane
  spends the day queueing for one turn.
- **Order each lane by impact on users:** what hurts the most users, or
  hurts one badly, first; polish last. Only a dependency forces an
  exception. Work in flight leads its lane; the founder's own reordering in
  bb stands.
- **A ticket with no declared surface** (its plan has no `## Surfaces`) can
  be scheduled, but it is not verified safe beside other work. Fix the plan,
  or record a `surface_reviews` entry with the files and your evidence. It
  can never leave out files the ticket's branch has already changed.
- **A ticket with no plan has no lane.** Plan it first.

**4. Validate, then publish.**

```sh
node scripts/factory/sequence.mjs validate   # prints the table, or every reason it was refused
node scripts/factory/sequence.mjs publish    # validates again, then syncs the factory
```

Publishing queues new tickets, moves a ticket whose lane changed, and drops
an unstarted ticket that left the schedule. It never reorders a lane and
never stops work that has started. Each ticket starts where its step says
(`review`: plan review; `build`: build; `small-bug`: fix), carries its
plan's tier and builder, and waits for the tickets the script worked out.

Report in a few lines: what can run now, what waits and for what, and any
ticket whose surface is not declared.

## With a tracker

`sequence.mjs reconcile --apply` makes the tracker's plan labels match the
plans that exist. Blocking relations in the tracker are honoured as
dependencies; never waive one as "just merge coordination".
