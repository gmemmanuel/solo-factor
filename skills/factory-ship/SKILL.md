---
name: factory-ship
description: Close out a reviewed ticket: sync with the base branch, verify it is green, open the pull request and merge it when CI passes. Use when a factory stage asks you to ship a ticket and the project's FACTORY.md does not name a ship skill of its own.
---

# Ship

Read the project's `FACTORY.md` first. If its "Stage skills" table names a
different skill for Ship, use that one. Otherwise this is the method, with
the profile's "Branches, CI and merging" section deciding every specific.

**Ship ends with the pull request merged**, when the profile says the ship
stage merges. If the profile says the founder merges, it ends with the pull
request open and green, and you say plainly that it is unmerged.

**Ship never deploys.** Merging to the base branch reaches no user; getting
it to users is the Deployer's job, on the founder's request. Bundling a
deploy into a merge turns a cheap, reversible git step into one that touches
shared infrastructure.

## Before anything

1. **The founder's check.** If this ticket changes what users see, the
   factory starts this stage only after the founder approved it. Outside the
   factory, confirm that approval exists before going on.
2. **The review.** Find the latest `## Code review` section in the plan (or
   on the ticket, for a small bug that was reviewed) and compare its
   `Reviewed head` with `git rev-parse HEAD`:
   - Same commit, disposition `complete`: go on. Read its "Issues found and
     fixed" so you know what the reviewer changed.
   - The reviewed head is an ancestor of HEAD: inspect what changed since
     (`git diff <reviewed>..HEAD`). Merges from the base branch and
     mechanical conflict fixes are yours to close: rerun the affected
     checks and note it under the review. New behaviour is not: send it back
     with `bb factory rereview <KEY>`.
   - Disposition `decision_required` or `blocked`, or no review on a planned
     ticket: stop and report `blocked`. Never reconstruct a review from memory.
   - A small bug ships without a review. Confirm its ticket records the
     exact reproduction and at least one designed variation.
3. **One outcome, one pull request.** Every planned step is done. Never open
   a pull request for a foundation or plumbing step whose value depends on
   later work.

## Step 1: sync with the base branch

```sh
git fetch origin
git merge origin/<base>
```

Resolve conflicts by understanding both sides. If a conflict needs a
decision about behaviour, stop and send it to the issue owner.

## Step 2: verify green

Run the profile's lint, type and test commands for the change. Fix what
fails at its cause. Never weaken or skip a check to get through. If
something only one branch may use at a time gates merging, take the turn the
way the profile says.

## Step 3: close out knowledge

- **Follow-ups.** Read the plan's "Follow-ups and out of scope". Anything
  that belongs to an existing ticket, append there. A genuinely new outcome
  is **proposed, never filed by you**: message the Architect
  (`factory_message` to `orchestrator`) with what users experience today,
  what they would after, and why it is worth building.
- **Decisions and learnings.** Confirm that decisions binding future work
  reached the decision log, and that `LEARNINGS.md` has what was worth
  keeping. If nothing qualified, say so in the pull request.
- **The plan** reflects what was actually built.

## Step 4: open the pull request

The pull request body is for someone reading history a year from now. Review
already happened, so it briefs nobody. Carry what the diff cannot:

- why the change was needed and what decision it encodes;
- the ticket key and link;
- **Contract gaps:** every cell the plan left open and what the builder
  chose (from the plan's "Builder plan amendments"), or "no contract gaps".
  This is how the founder learns whether plans are specified well enough for
  the builder tier they chose.
- for a small bug: that it merged without independent review, on the fast path.

Leave out reviewer instructions, verification steps and product pitch.

## Step 5: wait for CI, then merge

Wait for the profile's required check on the **exact head** you pushed. On
green, merge with the profile's method. On red, read the failure, fix the
cause, push, and wait again. A flaky check is rerun once, and reported if it
fails twice.

After merging, do what the profile says to the tracker (close the ticket,
move a label) for every ticket this branch resolved, riders included.

## Reporting

`factory_stage_done` with `outcome: "complete"` and one or two lines: merged
or open, the pull request, and anything the founder should know. If you
could not merge, `blocked`, with the exact check or conflict and what you
tried.
