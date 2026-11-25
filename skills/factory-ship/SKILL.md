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
2. **The review.** `node scripts/factory/plan-doc.mjs` tells you what kind
   of branch this is. For a planned ticket (exit 0), the script decides
   whether the review covers what you are about to ship:

   ```sh
   PLAN="$(node scripts/factory/plan-doc.mjs)"
   node scripts/factory/review-receipt.mjs --plan "$PLAN" --mode ship --head "$(git rev-parse HEAD)"
   ```

   - **It passes:** go on. Read the review's "Issues found and fixed" so
     you know what the reviewer changed.
   - **"HEAD moved since the review":** the reviewed commit is an ancestor
     of yours. Inspect the difference (`git diff <reviewed>..HEAD`). A merge
     from the base branch and mechanical conflict fixes are yours to close:
     rerun the affected checks and record the closeout below. New behaviour
     is not: send it back with `bb solo-factor rereview <KEY>`.
   - **"The review returned a decision":** it must be resolved (by the
     founder or the issue owner) before you record a closeout.
   - **Blocked, missing, malformed, or not an ancestor:** stop and report
     `blocked`. Never reconstruct a review from memory.
   - **A small bug (exit 3)** ships without a review. Confirm its ticket
     records the exact reproduction and at least one designed variation.

   A closeout is appended to the plan after the review, at the final head:

   ```markdown
   ## Ship closeout - [date] - [agent]

   ### Changes since review
   [What changed after the reviewed head, and why it needs no new review.]

   ### Verification
   [What you reran, and the results.]

   <!-- factory-review:v1 {"stage":"closeout","head":"[full SHA]","disposition":"closed","code_review_head":"[reviewed SHA]","agent":"[agent]","recorded_at":"[UTC time, ISO, ending in Z]"} -->
   ```

   Then `review-receipt.mjs --mode ship` again, and it must pass. A commit
   that touches only plan documents does not count as a change, so
   committing the closeout itself never needs another one.
3. **One outcome, one pull request.** Every planned step is done. Never open
   a pull request for a foundation or plumbing step whose value depends on
   later work.

## Step 1: take the ship turn, then sync with the base branch

Branches land one at a time. Two branches that sync and run CI side by side
go stale the moment the first merges; holding one turn from "merge base" to
"merged" means CI tests the tree that actually lands.

```sh
node scripts/factory/ship-turn.mjs take     # waits for the holder; exit 75 if no turn in time
git fetch origin
git merge origin/<base>
```

Never merge around the turn's holder. If the merge brought anything in,
that is a change since review: record the closeout above at the new head.

Resolve conflicts by understanding both sides. If a conflict needs a
decision about behaviour, stop and send it to the issue owner.

## Step 2: verify green

Run the profile's lint, type and test commands for the change. Fix what
fails at its cause. Never weaken or skip a check to get through. A fix here
is a change since review: record the closeout.

## Step 3: close out knowledge

- **Follow-ups.** Read the plan's "Follow-ups and out of scope". Anything
  that belongs to an existing ticket, append there. A genuinely new outcome
  is **proposed, never filed by you**: message the Architect
  (`factory_message` to `architect`) with what users experience today,
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

```sh
node scripts/factory/ship-turn.mjs land --pr <number>
```

It waits for the required check on the **exact head** you pushed, renews
the turn while it waits, merges with the project's method on green, and
releases the turn. It refuses (exit 4, turn kept) when the pull request is
not this exact commit or the base moved: fix what it says and rerun. On a
red or timed-out check (exit 1) it releases the turn so the next branch can
land: read the failure, fix the cause, and take the turn again. A check you
believe is flaky is rerun once, and reported if it fails twice.

If the profile says the founder merges, add `--no-merge`: it only waits for
green, and you report the pull request as open and unmerged. Never merge
any other way.

After merging, with a tracker, close every ticket this branch resolved,
riders included (`factory-tracker` skill). Then run
`node scripts/factory/sequence.mjs refresh` so the lanes move on.

## Reporting

`factory_stage_done` with `outcome: "complete"` and one or two lines: merged
or open, the pull request, and anything the founder should know. If you
could not merge, `blocked`, with the exact check or conflict and what you
tried.
