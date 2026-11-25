---
name: factory-review-plan
description: Independently review a ticket's plan before it is built, fixing what the code determines and returning only real decisions. Use when a factory stage asks for a plan review and the project's FACTORY.md does not name a plan-review skill of its own.
---

# Review plan

Read the project's `FACTORY.md` first. If its "Stage skills" table names a
different skill for Review plan, use that one. Otherwise this is the method.

You are a different agent from the plan's author, in a fresh thread. Plans
are often written from an audit or a trace, not from daily ownership of the
code. The recurring failure is: **the design is sound, but one factual claim
about the existing code is false, and a decision rests on it.** Finding
those is the job.

In the factory, reviewing the plan also makes you the ticket's **issue
owner** until it ships: the builder's questions come to you. The
`factory-issue-owner` skill covers that.

## You fix what you find

**Default on every defect: fix it in the plan, verify the claim, report it
as fixed.** "It is in scope for the author" is a reason to fix it yourself,
never a reason to hand it back. Record each change as a numbered decision in
the plan with its `file:line` evidence, so the author can audit it.

**Return exactly three things:**

1. **Product forks:** defensible answers differ, the choice changes what a
   user experiences, and the code does not pick the winner.
2. **Scope changes:** anything that grows, shrinks or splits the ticket.
3. **Contradictions with a recorded founder decision.** Show that it cannot
   be built as stated. Never overturn one.

Everything else you land yourself, architecture included. This does not
authorise starting the build, widening scope, or deploying anything.

## What to check, in order

1. **Every factual claim against the real code.** Every `file:line`, every
   "X already does Y", every "nothing calls this", every schema claim. Read
   the code. A false claim a decision rests on is a blocking correction.
2. **The unknowns the plan left open.** If it says "first confirm whether…",
   do that trace now. A bug plan with competing theories is yours to
   diagnose (`factory-debug`); do not bounce it. If the corrected diagnosis
   shows the work is already done or owned by another ticket, that is a
   scope decision: return a recommendation to close, and write no tasks.
3. **Unfilled contract cells.** You have the code open; fill them. Names,
   shapes, behaviour tables, the touch list. Return a cell only when a
   user's experience determines the answer.
4. **Callers and entrances.** Run the caller search yourself for every
   function whose behaviour changes and compare it with the plan's table.
5. **Hidden plumbing.** Migrations, new job or enum values, permissions and
   access rules, export and delete paths, analytics events, and contracts
   between client and server that the change implies.
6. **Surfaces.** The declared file list matches what the tasks will touch.
7. **Verification is executable.** Could an agent run it as written:
   concrete commands, fixtures, assertions? Does it cover the class
   (designed variations), not just the reproduction? "Test thoroughly" is a
   finding.
8. **Interactions.** The most expensive defects are two decisions that are
   each defensible and unsafe together. Only a pass over the whole plan
   finds them.
9. **Product surface.** If the user will see something new and there is no
   approved mockup, that is a returned decision. You cannot approve one for
   the founder.
10. **Shortcut risk.** If a step can only pass its check by hardcoding the
    reported case, say so now. It is cheaper here than mid-build.

## The tier

Confirm or raise the implementer tier, and say which.

- **Raising it is a landed correction.** Judgment inside the diff, user-facing
  copy or UI, a behaviour table you could not fully fill: raise it and name
  the cell.
- **Lowering it requires filling the cells** that justified the higher one.
- A plan claiming Tier 1 with an unfilled cell is the common failure. Fill
  the cell or raise the tier.

Confirm the **Builder** line (UI or Full-stack) fits the diff.

## Output

Edit the plan as you confirm each defect, with targeted edits. Never delete
an earlier review section. Append:

```markdown
## Plan review - [date] - [agent]

### Blocking corrections
[False claims a decision rested on: the evidence and the corrected fact. Or `None`.]

### Changed
[What you changed and why the code determines it.]

### Needs a decision from the founder
[Product forks, scope changes, contradictions with a recorded decision, each
with the situation, what a user sees under each option, and a
recommendation. Or `None`: that is the signal the plan is ready.]

### Implementer tier
[The tier and builder the plan now carries, whether you changed them, one sentence why.]

### Endorsements
[Decisions you verified and agree with. These stop later re-litigation.]
```

Then report:

- **Nothing returned:** `factory_stage_done` with `outcome: "complete"`. The
  summary gives the product explanation in two or three sentences, the count
  of corrections, and ends with `Implementer tier: Tier N` and the builder.
  First record both on the ticket, so the build starts on the right model:
  `bb factory tier <KEY> --tier N --builder ui|fullstack`.
- **A founder decision:** `factory_ask_founder`, in the shape above, then
  end your turn. When the answer arrives, fold it into the plan and report
  complete.
- **Only the author can fix it:** `outcome: "changes_requested"` with the
  findings. Rare: most findings are yours to land.

**One pass is the design.** The number of corrections you made is not a
reason to hold the plan. A review that rewrote half of it and returned
nothing is a completed review. Do not ask for another pass to check your own
corrections.
