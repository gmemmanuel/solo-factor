---
name: factory-plan
description: Write the implementation plan for one ticket before anything is built. Use when a factory stage or the Architect is asked to plan a feature or a bug fix, and the project's FACTORY.md does not name a planning skill of its own.
---

# Plan

Read the project's `FACTORY.md` first. If its "Stage skills" table names a
different skill for Plan, use that one and stop reading here. Otherwise this
is the method, and the Plan row's "project additions" apply on top of it.

A plan is a contract for a builder who has less context and a cheaper model
than you. Everything the code determines, you decide and write down.
Everything the user's experience determines is a product decision: settle it
with the founder before the plan is done, not during the build.

## One outcome, one plan, one branch, one pull request

A ticket is one product outcome: something a user (or the founder watching a
check) could observe after it ships. Phases inside a plan are commits on the
same branch, never separate pull requests. If the whole outcome would make an
unreviewable pull request, split it **vertically** into smaller outcomes a
user could each see. Never split into "schema first, UI later" pieces whose
value appears only when the last one lands.

Write one plan at a time. Batching several is how the least-evidenced one
gets through.

## Before planning: is this worth building?

A ticket is a claim that users need something, not an instruction to build
it. Before reading code for the solution:

1. **State the user-visible problem today, with evidence:** a real user, a
   trace, a piece of feedback, or a reproduction. A reproduction against
   real code proves a defect even if no user has hit it yet.
2. **Check recorded decisions** (the decision log `FACTORY.md` names). If
   the ticket contradicts one, stop.
3. **Check for a broader owner:** another open ticket or a recorded
   direction that already covers this.
4. **Size it to the population.** A fix that matters only for one legacy
   account or a retired flow is not worth a build. A confirmed defect on a
   path users can reach is.

If a check fails, do not write the plan. Report the evidence and recommend
closing or rescoping. That is a successful outcome.

## For a bug: one root cause, or it is not a plan yet

A bug plan names exactly one root cause with a checkable `file:line`. A plan
whose summary offers competing theories, or whose first task is "find out
why", is a diagnosis that has not been done. Use `factory-debug` and close
it yourself. Two cheap checks kill most wrong theories:

- **Read the tests for any contract you blame.** They show what the contract
  already accepts.
- **Search history for a prior owner:** `git log <base> --grep="<subsystem>" -i --oneline`.

Record the base-branch commit the diagnosis was taken against. The base
moves under long sessions, and a reviewer needs to tell a stale diagnosis
from a wrong one.

## When the user will see something new

If the outcome adds a screen, a new word the user reads, a new interaction,
or the plan's own success criteria use words like "feels clear" or "looks
intentional", presentation is a product decision. The plan needs a
**Product surface** section: the affected screens and the user's job on
each, every new user-facing word (chosen, not deferred), and a mockup the
founder has approved. Approval of structure comes before build. "The founder
will catch it when they try it" is not a design.

## Specify to the implementer tier

Ask of every open detail: **does the code determine it, or does the user's
experience?** Field names, type shapes, enum values, function signatures,
file placement, branch tables, migration shape, test assertions: the code
determines them, so you decide them, in the Implementation Contract. "The
builder chooses names and validation details" is the sentence this rule
exists to eliminate.

The plan then states one **implementer tier**, the reasoning level the
builder needs. Never name a model; the founder maps tiers to models.

| Tier | Choose it when |
|---|---|
| **Tier 1** (default) | The contract has no unfilled cells. Changes are additive or local and no judgment lives inside the diff. |
| **Tier 2** | Placing the change needs reading code the plan could only partly map, or the diff holds user-facing copy or UI judgment, or one bounded ambiguity remains. |
| **Tier 3** (rare) | Semantic design lives inside the diff (a prompt taxonomy, a classifier boundary, judge criteria), or the diagnosis may still be wrong at build time. |

The tier is an output of how completely you filled the contract, not a
guess. If you reach for Tier 2 or 3, name the cells you could not fill.

State the **builder** on the next line: `UI` when the central work is
interface (screens, components, layout, interaction), `Full-stack` for
everything else. UI plans are Tier 1 or 2.

## The plan document

`node scripts/factory/plan-doc.mjs --plan-dir` prints the only place plans
live. Name the file `<KEY> - short title.md` and keep the standalone
`Branch:` line exact: it is how every later stage finds this plan (for work
with no ticket, it is the only way). Use [TEMPLATE.md](TEMPLATE.md) in this
skill's folder. Rules for filling it:

- **Product explanation** is for the founder, with no code terms: what a
  user experiences today, what they will after, and why it is worth
  building. Three to six sentences. If you cannot write it plainly, the
  scope is wrong. Repeat it in your report.
- **Surfaces** lists every file the plan creates, modifies or deletes, one
  per list item. The scheduler reads it to decide which tickets can run
  side by side; a missing file sends two branches into the same code.
  `node scripts/factory/plan-surfaces.mjs "<plan file>"` must pass before
  the plan is done.
- **Callers and entrances.** For every function whose behaviour changes,
  list each caller and each path into it, and what happens on that path
  after the change. Include indirect ones: stored data read back through
  it, a retry branch, another screen using the same rule. New rules break
  unlisted paths more than anything else.
- **Every claim about existing code carries `file:line`.** The reviewer will
  check each one.
- **Verification is the agent's work, not the founder's.** Name the tests,
  the exact commands from `FACTORY.md`, and for behaviour that varies with
  input (anything AI-driven, anything parsing user text) the **designed
  variations**: the exact reproduction plus two or three inputs that
  exercise the same class differently. State what a reviewer will need to
  run their own independent pass (fixtures, test accounts, scripts).
- **A new persisted concept** (a table, a field, a cache, a lifecycle
  state, a contract between two surfaces) needs one paragraph: every
  consumer you expect beyond this ticket, who owns its lifecycle, and what
  it deliberately does not cover. A concept shaped for one call site gets
  rewritten within days.
- No time estimates. Explain order, dependencies and relative difficulty.
- No scope beyond what was agreed. A complete contract is not extra scope.

## When the plan is written

- With a tracker, add the "Plan written" label (`factory-tracker` skill).
- Run `node scripts/factory/sequence.mjs refresh` so the swimlanes include
  this plan. Exit 3 means the ticket has no lane yet: the Architect places
  it with the `factory-sequence` skill (if you are not the Architect, say so
  in your report).
- **Report** with the product explanation, any product question in the
  shape below, and the last line `Implementer tier: Tier N` plus the builder.
  In a factory stage, that is your `factory_stage_done` summary. The
  Architect instead queues the ticket on the `planned` pipeline with
  `--tier` and `--builder`.
- Do not start a reviewer and do not start building. The factory starts
  both, in fresh threads.

A product question is asked like this, or not at all:

- **Situation:** who the user is, where they are in the product, what they did.
- **Option A / Option B:** what the user sees in each, with example wording,
  and what follows from it.
- **Recommendation:** which, and why from the user's side.

If you cannot describe a difference a user would see, it is a technical
choice. Make it.
