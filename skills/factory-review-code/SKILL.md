---
name: factory-review-code
description: Independently review a ticket's complete branch, fix what the evidence determines, and run a fresh verification pass. Use when a factory stage asks for a code review and the project's FACTORY.md does not name a review skill of its own.
---

# Review code

Read the project's `FACTORY.md` first. If its "Stage skills" table names a
different skill for Review code, use that one. Otherwise this is the method.

You are a different agent from the builder, in a fresh thread. Review the
complete branch once, after the builder's own verification. The review has
two parts: a structured read of the diff, and, when the change warrants it,
a verification pass you design and run yourself.

## Find what you are reviewing

```sh
node scripts/factory/plan-doc.mjs
```

**Exit 0** prints the plan: review against it and record the review in it.
**Exit 3** prints `SMALL_BUG: <KEY>`: a small bug is not reviewed by
default, so you are here because the founder asked; the ticket is the plan
and the review is recorded as a comment on it. **Exit 1**: stop and report
`blocked` with its message.

## You fix what you find

**Default on every defect: fix it, verify it, report it as fixed.** Ordinary
review culture says reviewers comment and authors fix. This pipeline does
not. "It is in scope for the builder" is a reason to fix it yourself.
Severity is not a reason to hand something back: a serious, localised bug is
the most important thing to fix while you have the context.

**Return exactly three things:**

1. **Product forks:** the choice changes what a user experiences and the
   code does not pick the winner.
2. **Scope changes.**
3. **Contradictions with a recorded founder decision.** Never overturn one.

Everything else: fix it, commit it, rerun the affected checks, and record it
with `file:line`. This does not authorise widening scope, deploying, opening
a pull request or merging.

Do not file a finding about a choice the builder made defensibly. A constant,
a threshold or a name is a finding only when you can show wrong behaviour.

## Step 1: scope it

Before reading any file:

```sh
git diff <base>...HEAD --name-only --diff-filter=ACMRT
git diff <base>...HEAD --stat
```

Confirm the branch is ready to review: the plan marks the outcome and the
builder's verification finished, everything is committed and pushed, and the
working tree is clean. If not, report `blocked` with what is missing. Do not
do a partial review.

Sort the changed files by risk:

- **Read in full:** authentication, permissions and access rules, anything
  that writes user data, prompts and the code that orchestrates model calls,
  security-relevant middleware, migrations with data implications.
- **Read the diff:** UI, screen logic, shared helpers.
- **Spot-check:** configuration, schema-only migrations, tests, strings, docs.

## Step 2: pick the depth from the diff

Depth is a function of the diff, never of how much model you have. State
your choice and the numbers behind it.

- **Light:** under about 300 changed lines and five files, no AI behaviour,
  no migration. One pass: read every hunk and its enclosing function.
- **Standard:** a normal outcome, roughly 300 to 1,500 lines. Three passes,
  each surfacing at most four candidates:
  1. **Line by line.** For every changed line, what input, state, timing or
     platform makes it wrong: inverted conditions, off-by-one, null
     dereference, a missing `await`, zero treated as absent, swallowed errors.
  2. **Across files.** For each changed function, find its callers and
     callees and check the change against every call site: new
     preconditions, changed return shapes, new exceptions, ordering.
  3. **Removed behaviour.** For every deleted or replaced line, name the
     invariant it enforced, then find where the new code re-establishes it.
     If nowhere, that is a candidate.
  Finish with one verification pass: try to refute each candidate against
  the real code, and keep only what survives.
- **Deep:** AI behaviour or prompt contracts, migrations that move data,
  changes across several surfaces, or more than about 1,500 lines. The
  three passes above plus:
  4. **Security and data integrity.** Access checked before data is read,
     input validated, no secrets, migration effects on existing rows.
  5. **State and async.** Races, stale closures, cleanup, retries and
     idempotency, partial failure.
  6. **Reuse and structure.** New code re-implementing an existing helper,
     logic in the wrong layer, a new abstraction where extending existing
     code would do.

Never scale past Deep. A bigger diff means more time on the same six lenses,
not more lenses and not more agents. Run the passes in sequence yourself
unless the project's instructions allow reviewer sub-agents.

## Step 3: independent verification

Decide whether a fresh check means anything for this diff, and say which way
you decided.

- **Run it** when the change touches AI behaviour, background jobs, or
  anything where the screen can look right while stored state is wrong.
- **Skip it**, and say so, for docs, mechanical changes and pure refactors.
- **For a UI change**, regenerate the before/after renders yourself at the
  final head if the project can render screens (see `FACTORY.md`). Do not
  take the builder's images on trust; a state the builder never captured is
  a coverage finding.

A fresh check is not a rerun:

1. Derive expected behaviour from the **plan and the ticket**, not the diff.
   The builder can only validate against their own reading.
2. Design **your own two or three variations** of the same class. Read what
   the builder ran, then go beyond it. One sample each unless results vary
   run to run.
3. Run them with the project's commands and inspect the stored result, not
   just the output.
4. A failure is a finding like any other: fix it when the correction is
   local, return it when it needs a decision.

If the plan shows no record that the builder ran their own verification,
that is a serious finding on its own. If a check you need cannot run, try
the documented path first and record the exact error; then report `blocked`.
Never report a review as passed with verification left for someone else.

Audit the plan's **Builder plan amendments**. An amendment that changed what
a check proves, the scope, or what a user sees is a finding. So is a raised
budget without measured evidence.

If the plan has a **Product surface** section, render the real states with
realistic, full data and compare them with the approved mockup: hierarchy,
wording and density, not just colours. A mismatch is a finding.

## Step 4: record it

The review is not finished until this record exists and the script accepts
it. A verdict in chat is not a review. Append to the plan document (for a
small bug, post it as a comment on the ticket):

```markdown
## Code review - [date and time] - [agent]

Reviewed head: `[full commit SHA after your fixes]`
Disposition: `[complete | decision_required | blocked]`
Depth: [Light | Standard | Deep] - [changed lines, files, surfaces]

### Verification
[Ran or skipped, and why. If ran: scenarios, variations, results, evidence.]

### Issues found and fixed
- **[CRITICAL | HIGH | MEDIUM | LOW]** `path:line` - [issue]
  - Fixed in: [commit] - [what changed]
  - Re-verified by: [command and result]

[`None` when there were none.]

### Needs a decision
[Product forks, scope changes, contradictions with a recorded decision, each
with a recommendation. `None` is the signal the branch is ready.]

<!-- factory-review:v1 {"stage":"code_review","head":"[full SHA]","disposition":"[complete|decision_required|blocked]","agent":"[agent]","recorded_at":"[UTC time, ISO, ending in Z]"} -->
```

The last line is the receipt: one line, the same full SHA as "Reviewed
head", which is the head after your last code fix. If plans live in the
repository, commit and push the plan on its own afterwards: a commit that
touches only plan documents does not count as a change since review. Then
prove it:

```sh
node scripts/factory/review-receipt.mjs --plan "$(node scripts/factory/plan-doc.mjs)" --mode record --head <reviewed SHA>
```

For a small bug, `--ticket <KEY>` in place of `--plan`. If the script
refuses, fix the record; do not report the review as done.

Use `complete` only when the review work is finished and nothing is
returned; `decision_required` when one of the three returnable things
remains; `blocked` when required review work could not finish.

Severity: **CRITICAL** is a security hole, data loss or a crash on a main
path. **HIGH** is a functional bug or broken experience. **MEDIUM** will
cause pain later. **LOW** is polish.

Only report what you are confident is a real issue, with a specific
explanation and a fix. No "might be a problem".

## Reporting

- **Nothing returned:** `factory_stage_done` with `outcome: "complete"`. If
  no review stage follows yours, pass `change_note`: what users saw or the
  system did before, what it is now, and why, in plain words for the founder.
  If the ticket changes a screen, pass `founder_check` with the before/after
  image you generated at the final head.
- **A product decision:** `factory_ask_founder`, then end your turn.
- **Only the builder can do it:** `outcome: "changes_requested"` with the
  findings. They go to the builder's thread.
