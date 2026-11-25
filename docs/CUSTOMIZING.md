# Making the factory yours

The factory is meant to be changed. You installed it from your own clone so
that you, or your Mechanic, can change any part of it. This page says what
there is to decide and where each kind of change belongs.

## The smallest lever that works

| You want to change | Change this | Reach |
|---|---|---|
| A command, a path, a rule about your project | `FACTORY.md` in your repository | one project |
| Which model plays a role, or its fallback | the Factory settings page, or `bb solo-factor role` | one project |
| Which skill a stage uses | `bb solo-factor stage <stage> --prompt …` and the "Stage skills" table in `FACTORY.md` | one project |
| How many tickets run at once, the ticket link | the Factory settings page | one project |
| A script's setting (base branch, CI check, lane limit, tracker, labels) | `factory.config.json` in your repository | one project |
| What a script enforces | `scripts/factory/` in your repository; or `kit/` in your clone, then reinstall | one project; or all |
| How planning, review, build or ship is done | the skill in `skills/` (or your project's own skill) | every project on this machine |
| What a standing agent is for | its charter in `skills/` | every project |
| Stages, pipelines, roles, standing agents that exist by default | `src/factory/defaults.ts` | new projects |
| How tickets move, what the inbox does, the page | `src/factory/engine.ts`, `app.tsx`, with tests | everything |

After changing a skill or code in your clone: `npm run verify`, then
`bb plugin build` and `bb plugin reload solo-factor`.

## Decisions to make on day one

The Mechanic asks these during onboarding and recommends an answer for each.

1. **Models per role, and fallbacks.** The pipeline assumes reasoning is
   spent on planning and review, and that a builder executes a contract.
   If your builder is as strong as your Architect, tiers matter less; if it is
   much weaker, plans must be filled in more completely.
2. **The founder gate.** By default you try every ticket that changes a
   screen or its words, and nothing else. Stricter (every ticket) is safe
   and slow. Looser (none) is right only for a prototype.
3. **Who merges.** Letting the ship stage merge on green CI removes the last
   hand-carry. It is only as safe as your CI.
4. **What agents may do unasked.** Deploying to a dev environment and
   seeding test accounts make agent-run QA possible. Anything touching
   production or real users' data should need you.
5. **Tracker.** Linear is supported directly: agents read, file, label and
   close tickets with `scripts/factory/linear.mjs`, and the scheduler reads
   Linear's blocking relations and plan labels. Without one, the factory's
   own record and the plan documents are the tickets. Filing always starts
   with your approval. A ticket system inside the factory is planned.
6. **Where plans live.** In the repository (`docs/plans/`) is simplest. A
   separate repository keeps plan churn out of your history.
7. **Standing agents.** Start with the Architect and the Mechanic. Each one
   you add is a thread that will ask for your attention.
8. **Concurrency.** Your attention is the limit. Start at two or three
   tickets in flight.

## Using your own skills for a stage

If your project already has a planning, review or shipping skill, keep it:

```sh
bb solo-factor stage plan --prompt 'Use the `my-plan` skill to plan {key}: {title}.\n\n{brief}'
```

The prompt takes `{key}`, `{title}`, `{brief}`, `{previous}` (the previous
stage's handoff) and `{lane}`. Your skill needs to do two things the factory
relies on:

- **Report with the factory's tools** (`factory_stage_done` and friends; the
  bundled `factory` skill is given to every stage thread and explains them).
- **Not do the factory's job:** no starting its own reviewer, no opening a
  pull request before the ship stage, no waiting for a person to confirm
  each step. Nobody is watching a factory thread.

## What transfers, and what you will rewrite

Honest notes from generalizing this out of one project:

- **Transfers as is:** the engine; the worker protocol; the charters; the
  scripts (plan lookup, review receipts, merge and dev turns, swimlane
  scheduling); the plan contract and implementer tiers; "reviewers fix what they find and
  return only product forks, scope changes and contradictions"; one review
  pass; the issue owner; the founder gate.
- **Needs your project's facts** (that is `FACTORY.md`): every command, the
  tracker, the merge path, test accounts, what counts as a live check.
- **Needs building per project**, and the Mechanic owns getting it built
  during setup: the Observer's checks (they depend on where your evidence
  lives; the Observer proposes and schedules them), a deploy runbook, a UI
  preview harness, a live check for behaviour tests cannot prove, and
  wrappers so your deploy commands take their own turn.
- **Assumes GitHub** for the merge turn (pull requests, check runs). A
  repository with a merge queue should use the queue instead.
- **Linear or nothing** for tickets, today.
- **Assumes a single founder.** The inbox, the gate and the charters address
  one decision-maker. A team needs routing this does not have.
- **Assumes git worktrees and pull requests.**

## Taking updates from upstream

Your clone is a fork. Add the original as `upstream`, and pull on a branch:

```sh
git fetch upstream && git checkout -b take-upstream && git merge upstream/main
npm run verify && node scripts/live-check.mjs
```

Skills you edited will conflict where upstream changed them too; that is the
cost of owning them. Changes that would help anyone are welcome back as pull
requests.
