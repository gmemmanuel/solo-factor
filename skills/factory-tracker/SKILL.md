---
name: factory-tracker
description: Read, file and update tickets in the project's tracker (Linear today) from a factory thread. Use when a stage or standing agent needs a ticket's text, must file an approved ticket, record a review or reproduction on a ticket, or move a ticket's plan labels or state.
---

# Tickets

The factory works with **Linear** today. `factory.config.json` says so
(`tracker.kind: "linear"`, with the team key and label names), and every
agent reaches it the same way:

```sh
node scripts/factory/linear.mjs issue APP-12
node scripts/factory/linear.mjs board
node scripts/factory/linear.mjs create --title "…" --description-file ticket.md --label "Small bug"
node scripts/factory/linear.mjs comment APP-12 --body-file note.md
node scripts/factory/linear.mjs label APP-12 --add "Plan reviewed" --remove "Plan written"
node scripts/factory/linear.mjs state APP-12 "In Progress"
```

Use this script, not a Linear connector that happens to be in your tool
list: connectors sign in per person and hang in unattended threads. The key
comes from `LINEAR_API_KEY` or the command the project configured. Never
print it.

With `tracker.kind: "none"`, there is no tracker: the factory's own record
(`bb solo-factor status`) and the plan documents are the tickets, and the
commands above do not apply.

## Who may write what

| Action | Who |
|---|---|
| File a ticket | The Architect, after the founder approved filing it. The Integrator, for maintenance. An issue owner, for a follow-on the founder asked for. Nobody else: propose it to the Architect |
| Add "Plan written" | Whoever wrote the plan |
| Replace "Plan written" with "Plan reviewed" | The plan reviewer, when it returned nothing |
| Move to the started state | The builder, when it starts |
| Record a small bug's reproduction, or a review of one | The builder or reviewer, as a comment |
| Close | The ship stage, after the merge, for every ticket the branch resolved |

Preserve labels you did not set. Read the ticket back after writing.

## A ticket worth filing

One product outcome: something a user, or the founder watching a check,
could observe after it closes. If you cannot say what they would observe,
the scope is wrong.

- **Title:** the outcome in plain words.
- **Today / After / Why:** what a user experiences now, what they will, and
  the evidence that it matters.
- **For a bug:** the reproduction, the first broken layer and the root cause
  with `file:line`, if known.
- **Small bug label** only when it is executable as written: a root cause
  with `file:line`, at most two files, no migration.
- Structural work with no visible outcome (a schema field "a later ticket
  will use") is not a ticket. It is an early step of the ticket that
  surfaces it.
- A dependency is a blocking relation in the tracker, never a sentence in a
  description. The scheduler reads relations.

## Coming

A ticket system inside the factory, so a project needs no tracker at all:
tickets, their plans and their history on the Factory page, filed and moved
by the same agents. Until then, Linear, or none.
