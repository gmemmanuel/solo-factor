---
name: factory-build
description: Build one ticket from its reviewed plan, including all verification the builder owns. Use when a factory stage asks you to build or fix a ticket and the project's FACTORY.md does not name a build skill of its own.
---

# Build

Read the project's `FACTORY.md` first. If its "Stage skills" table names a
different skill for Build, use that one. Otherwise this is the method, with
the Build row's project additions on top.

Implement the complete outcome, precisely as planned. Phases in the plan are
commits on this branch, not places to stop.

## Find the plan

```sh
node scripts/factory/plan-doc.mjs
```

- **Exit 0** prints the plan. Use that exact file.
- **Exit 3** prints `SMALL_BUG: <KEY>`: the ticket is the plan. Go to "Small
  bugs" below.
- **Exit 1** is anything else. Stop and report `blocked` with its message.
  A missing plan is never evidence that something is a small bug.

With a tracker, move the ticket to its started state as you begin.

## Build the contract as written

The plan's **Implementation contract** is decided: its names, shapes,
behaviour tables, touch list and tests. Use those exact names and shapes,
not better ones. Renaming an identifier because you prefer another breaks
the plan's cross-references and the reviewer's ability to check your work.

When the plan is wrong or silent, you still own the decision, within your
tier:

- **Any builder** may: fix a contract cell that is provably wrong against
  the code; reword a prompt the plan already changes until it meets the
  plan's unchanged bar; rerun after a provider error; and raise a test's
  budget or timeout from measured evidence, up to double the plan's figure.
- **A Tier 2 or Tier 3 builder** also decides every technical question
  needed to deliver the approved outcome: mechanism, unfilled cells,
  contradictions between cells, test design.

Decide with the code in front of you, pin it with a test, and record it in
the plan under **Builder plan amendments**: the cell, the evidence, what you
changed, and which attempt this was. Keep going. The code reviewer audits
that section.

**Stop and ask only when:**

- the same check still fails after two recorded attempts and you have no
  evidenced next move;
- the fix needs the shortcut described under "Stop-gate" below;
- the diagnosis the plan rests on turns out to be false, so the planned
  outcome no longer holds;
- or the change would alter what a user sees, or contradict a recorded
  founder decision.

The first three go to the ticket's issue owner with `factory_ask_owner`
and a self-contained handoff: branch and head, the approved outcome, the
blocker with `file:line` and the failing command, what you propose, what is
already done. The fourth is a product question: `factory_ask_founder`, with
what the user sees under each option and your recommendation. A failed test,
a long runtime or wanting reassurance is not a reason to stop.

## You run the verification

QA is your deliverable, not the reviewer's and not the founder's.

- **Red, green, refactor** for each step: the smallest test that captures
  the behaviour, failing for the right reason; the smallest change that
  passes it; then clean up. If a change truly cannot start from a failing
  test, say why in the plan and use the smallest deterministic check.
- **Use the commands in `FACTORY.md`.** Run the tests for what you changed,
  not the whole suite, unless the profile says the whole suite runs locally.
- **Prove the class, not the string.** For behaviour that varies with input
  (anything AI-driven, anything reading user text), run the plan's live or
  end-to-end check on the exact reproduction **and** its designed
  variations. The build is not done until these pass. The reviewer will run
  an independent pass later; that adds to yours and never replaces it.
- **When a live check fails, decide first whether the product or the test is
  wrong.** A fixture that contradicts its own expected result, a timeout
  below what the step measurably needs, a harness bug: fix it, record it,
  rerun. A change to what a check proves is a plan correction, not a harness
  fix.
- **Look at UI you change.** If the project has a way to render screens
  without a device (see `FACTORY.md`), render every changed screen and
  state, before and after, and read the images. Say what the render cannot
  show (animation, system font scaling) instead of implying full coverage.
- **Before changing a screen, open the approved mockup** the plan names. If
  it is missing, or the build needs a design decision it does not answer,
  stop and raise it. Do not decide hierarchy or wording yourself.
- Do in dev what `FACTORY.md` says agents may do unasked.
- **Take a turn on anything only one branch may use at a time** (a dev
  deploy slot, a staging database, a device; `FACTORY.md` names them):
  `node scripts/factory/turn.mjs take <name…>` before you use it, `renew`
  while you do, and `release` as soon as your check is finished or you go
  back to editing. It waits for the holder; never deploy or test around
  one. A wait is not a blocker to report; exit 75 (no turn within the
  limit) is.

Record in the plan exactly what you ran and the results. The reviewer starts
from that record.

## Commit as you go

Work on the ticket's branch, never the base branch. Every finished step or
red/green slice is a commit, pushed, and then you continue. A commit is not
a handoff: do not stop, ask, open a pull request or start a review because
one landed. Handing off a finished ticket with zero commits is a process
failure.

Update the plan's task list and progress as each step completes.

## Before you report

- **Documentation from the actual implementation**, not from memory:
  user-facing docs, affected reference docs, and anything the plan listed.
- **Deferred debt:** anything real you found and did not fix goes in the
  plan's "Follow-ups" section with one line on why. Do not file tickets.
- **A decision that binds future work** (a contract, a rejected approach)
  goes in the project's decision log, not only in this plan.
- **A lesson worth keeping** goes in `LEARNINGS.md`: a surprise the next
  agent would otherwise rediscover. No entry is a valid outcome.

## Reporting

Report once, with `factory_stage_done`:

- `outcome: "complete"` when every planned step is implemented, your checks
  are green, the plan and docs match the code, and the branch is committed
  and pushed. The summary is for a reader with no access to this thread: the
  branch and head, the plan path, what you ran with results, and the
  amendments you made (or "none").
- If the ticket changes what a screen looks like or says, pass
  `founder_check` (see the `factory` skill): what users saw before, why it
  changed, what they see now, a test account, short steps, and the
  before/after image.
- `outcome: "blocked"` only for a missing credential, conflicting external
  state, or one of the stops above that you could not route.

Do not open the pull request and do not start a reviewer. The factory starts
the review in a fresh thread, and the ship stage opens the pull request.

## Stop-gate

Deterministic code is right for deterministic things: validation, routing
once intent is known, parsing machine formats, safety checks. But if a step
can only pass its check by

- matching the meaning of human language with a regex or string test,
- hardcoding the reported case (a specific phrase, user, id or date), or
- inventing a special operation for one reported input,

**stop. Do not patch to green.** That is evidence of a missing or wrong
contract. Write up the class of failure and the contract that is missing,
and send it to the issue owner. Getting the check green is not the goal;
getting the contract right is.

## Small bugs

A ticket on the `small-bug` pipeline, or one riding with your ticket, has no
plan. The ticket is the plan. It qualifies only while it stays small: a
root cause with `file:line`, at most two files, no migration, no new
capability.

1. Write the test that fails first. Fix it. Run the exact reproduction plus
   at least one designed variation, and record both on the ticket.
2. Run the project's lint, types and the tests related to your change.
3. One commit per small bug.
4. A rider ships with its host ticket. A small bug on its own: ship it with
   `factory-ship`, then report complete.

If it grows a third file, a migration or a contract change, it is not a
small bug. Say so in a `blocked` report, so it gets a plan.
