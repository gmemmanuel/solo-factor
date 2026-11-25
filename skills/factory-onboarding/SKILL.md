---
name: factory-onboarding
description: Set the factory up in a project for the first time. Use when you are a standing factory agent and the project has no FACTORY.md, when the founder says they are new to the factory or asks to set it up, or when asked to re-run the project analysis after the codebase or the founder's way of working has changed.
---

# Onboarding a project into the factory

The factory moves tickets between agents. It knows nothing about this
project until someone writes that down. Onboarding is that someone: you read
the codebase and how the founder already works, write the project profile
every other agent will read, and leave the founder with a factory that fits
them instead of one they must fit.

The Mechanic normally runs this. Any standing agent may, if it is the one the
founder started first.

**The result is four things in the project:** `FACTORY.md`, the profile
agents read; `factory.config.json`, the same facts for the scripts;
`scripts/factory/`, the scripts that enforce the pipeline's rules; and a
short setup list of what the project still lacks, which you then build.
Plus the decisions only the founder can make. Do not start the pipeline on
real work until the first three exist.

## How to behave

- **Look before you ask.** Everything the repository can tell you, read.
  Ask the founder only what it cannot: what they want, how they like to
  work, and what must never happen.
- **Explain as you go, briefly.** The founder may have installed this ten
  minutes ago. Say what the factory is in four or five sentences before the
  first question (below), then teach the rest when it becomes relevant.
- **Ask in the inbox, not with a question box.** Use `factory_ask_founder`,
  one entry per decision, each with options and your recommendation. A
  blocking question box freezes your thread.
- **Change nothing in their repository without saying so.** Onboarding
  writes `FACTORY.md`, your memory file, and (if they agree) pack skills and
  a section in their agent instructions. Put it on a branch and through
  their normal merge path. Nothing else.

## Step 1: say what this is

Tell the founder, in your own words:

> The factory runs each ticket through plan, plan review, build, code review
> and ship. Every stage is a fresh agent on the model you choose for it, so a
> review is always independent. Tickets that would collide wait in the same
> swimlane. You are asked only for product decisions, in one inbox, and you
> try anything users will see before it ships. Standing agents keep the
> picture (Architect), watch real usage (Observer) and improve the factory
> itself (Mechanic, which is me). I am going to read your project, then ask
> you a few things.

## Step 2: read the project

Work through this list and write down what you find, with paths. Skip
nothing; "none found" is a finding.

1. **Shape.** Languages, frameworks, package managers, monorepo or not, what
   deploys where. Is it a mobile app, a web app, a service, a library?
2. **Agent instructions that already exist.** `AGENTS.md`, `CLAUDE.md`,
   `.cursor/rules`, `GEMINI.md`, `.github/copilot-instructions.md`, at the
   root and in subtrees, and the founder's user-level files. These are how
   the founder works today. Note their size: some providers silently
   truncate long instruction files (Codex at about 32 KB).
3. **Skills and commands that already exist.** `.claude/skills`,
   `.agents/skills`, `.claude/commands`, `.codex`, and anything similar. For
   each: what it does, and which factory stage or standing agent it overlaps.
4. **Verification.** The exact commands for lint, types, tests (targeted and
   whole), database tests, end-to-end tests. Run the cheap ones once to
   confirm they work from an agent session. Find the CI configuration and
   the name of the required check.
5. **Branch and merge habits.** Read the last fifty commits and a few merged
   pull requests: branch naming, squash or merge, who merges, how commit
   messages look, whether pull requests carry a ticket key.
6. **Tracker.** Ticket keys in commits and branches, a tracker CLI or API
   script in the repository, credentials an agent can already use. The
   factory works with Linear, or with no tracker; for Linear, find the team
   key and how an agent session gets the API key without printing it.
7. **Plans, decisions, learnings.** Any plan or design documents, an ADR or
   decision log, a `LEARNINGS.md`. Where they live and whether they are
   current.
8. **Environments and danger.** Dev, staging and production; how each is
   deployed; which commands touch real users or real data; what is shared
   between branches (one dev database, one deploy slot, one device).
9. **Evidence the Observer could read.** Error tracking, analytics, a
   database with usage, logs, a feedback table or inbox, LLM traces. For
   each, whether an agent session can actually reach it: try the read path.
10. **UI.** Whether the project can render screens without a device or a
    browser session (a preview or snapshot harness). If the founder must
    try visible changes, how they would run a branch.

## Step 3: compare with the factory's defaults

For each row, decide **keep theirs**, **use the bundled skill**, or **merge**,
and say why in one line.

| Factory piece | Bundled default | Look for theirs |
|---|---|---|
| Diagnose a bug | `factory-debug` | a debugging runbook or skill |
| Plan | `factory-plan` | a planning or spec skill, a plan template |
| Review plan | `factory-review-plan` | usually none |
| Build | `factory-build` | implementation rules in `AGENTS.md` |
| Review code | `factory-review-code` | a review checklist or skill |
| Ship | `factory-ship` | a release or pull-request skill, merge automation |
| Swimlanes | `factory-sequence` and `scripts/factory/sequence.mjs` | usually none |
| Tickets | `factory-tracker` and `scripts/factory/linear.mjs` | a tracker script or connector |
| Deploy | none: the Deployer needs the project's own runbook | deploy scripts, a release skill |
| Dependencies | none: the Integrator needs a method | Renovate, Dependabot, an update skill |
| Their own enforcement scripts | `scripts/factory/` | merge queues, branch protection, a plan or review check |

Rules for the decision:

- **Their skill wins when it exists and is good.** Point the stage at it:
  `bb solo-factor stage <stage> --prompt "Use the \`<their-skill>\` skill to …
  {key}: {title}.\n\n{brief}\n\n{previous}"`. Keep the placeholders the
  default prompt had (`bb solo-factor config` shows them).
- **A bundled skill needs the profile.** It reads `FACTORY.md` for commands,
  paths and rules. Anything the project requires beyond the bundled skill
  goes in that stage's row of "Stage skills", not in a fork of the skill.
- **Find the conflicts.** The usual ones: their instructions tell an agent
  to open a pull request when it finishes (the factory's ship stage does
  that); to ask the user before each step (nobody is watching a factory
  thread); to spawn its own reviewer (the factory starts one, in a fresh
  thread); or to push to the base branch. List each with the file and line
  and the smallest edit that removes it.
- **Enforcement they already have wins too.** If the repository uses a
  GitHub merge queue, the ship turn is redundant: say so in `FACTORY.md` and
  have the ship stage use the queue. Never run two mechanisms for one rule.
- **A mobile app gets the mobile pack.** If the project is React Native,
  Expo, or native iOS or Android, offer `packs/mobile` (see Step 6).

## Step 4: ask the founder what only they know

Put these in the inbox. Recommend an answer for each, from what you read.
Skip any the repository already answered.

1. **Models per role.** Which provider and model plays Architect, issue
   owner (plan reviewer), builder tiers, code reviewer and shipper, and
   what each falls back to on a usage limit. Recommend: strongest model on
   Architect, plan review and code review; a cheaper one on tier 1 builds
   and ship. Say what they have installed (`bb provider list`).
2. **What they must try before it ships.** Recommend: anything that changes
   a screen or its words. Ask how they test (phone, preview link, locally).
3. **Who merges.** The ship stage on green CI, or the founder. Recommend the
   ship stage once they have watched two or three tickets go through.
4. **What agents may do unasked** in dev, and what is off limits.
5. **Which standing agents to turn on now.** Recommend Architect and
   Mechanic today; Observer once there are real users or real traffic to
   read; Deployer when there is a runbook; Integrator and Cleaner later.
6. **How many tickets at once.** Recommend 2 or 3 to start, not the default
   8: the founder's attention is the limit, not the machine's.
7. **How they like to be written to.** Length, format, what to call their
   users. Record the answer in `FACTORY.md` under Project.

Also ask, once, the open question: **"How have you been working with agents
so far, and what about it costs you the most?"** Their answer is your first
retro. Write it into your memory file.

## Step 5: install the scripts and write the profile

The factory's repository is the founder's clone (`bb plugin list` shows
where the plugin was installed from). From the project's root, on a branch:

```sh
node <factory clone>/kit/install.mjs .
```

That copies the scripts into `scripts/factory/` and writes a starter
`factory.config.json`. Fill the config from what you found: `baseBranch`,
`plansDir`, `keyPattern` if ticket keys are unusual, `ci.check` (the exact
name of the required check), `merge.method`, `lanes.max` (what the founder
chose), and `tracker` (`kind: "linear"`, `team`, `url`, the label names,
and `keyCommand` if the key comes from a password manager's CLI). Then
prove each script against the real project:

```sh
node scripts/factory/plan-doc.mjs --plan-dir      # prints a directory that exists
node scripts/factory/turn.mjs status
node scripts/factory/ship-turn.mjs status
node scripts/factory/linear.mjs board             # with Linear: the open tickets
node scripts/factory/sequence.mjs collect         # the board; needs bb open
```

With Linear, create the labels the config names ("Plan written", "Plan
reviewed", "Small bug", "Later") if the team lacks them. A script that
fails here will fail a stage later: fix the config or the access now.

Then copy `templates/FACTORY.md` to the project root and fill every section
from Steps 2 to 4. Commands must run as written; paths must
exist. Where something does not exist yet (no plan directory, no decision
log), create the minimum (`docs/plans/`, an empty `LEARNINGS.md`) and say so.

Then add a short section to the project's agent instructions (`AGENTS.md`,
or whatever they use) so agents outside the factory know it exists:

```markdown
## Factory

This project runs on the bb Factory. `FACTORY.md` is the project profile:
commands, paths, gates and which skill each pipeline stage uses. Read it
before planning, building, reviewing or shipping. Work in a factory thread
reports with `factory_stage_done` and never opens its own review.
```

Set what you decided: `bb solo-factor role …` for each role, `bb solo-factor stage …`
for each repointed stage, the ticket link and the ticket limit under
the Factory settings page.

## Step 6: packs

A pack is a set of stack-specific skills that live in the project, not in
the plugin, because the project will change them. To install one, copy
`packs/<name>/skills/*` from the factory's repository into the project's
skill directory (`.agents/skills/` or `.claude/skills/`, wherever its skills
already live), then edit each to match the project: real commands, real
paths, the project's name for things. Record it under "Packs installed".

## Step 7: build what the project lacks

The scripts cover what every project shares. Three things cannot be
shipped, because they depend on the project, and a factory without them
runs blind. You own getting each one built. Write them in your memory file
as a setup list, and work it down with the founder over the first days:

1. **Shared things that need turns.** From item 8 of Step 2: anything only one
   branch may use at a time. Give each a short name, list them in
   `FACTORY.md`, and wrap the project's deploy or test command so it takes
   the turn itself (`turn.mjs take <name>` before, `renew` during). A rule
   agents must remember is weaker than a wrapper that does it.
2. **A way to see UI without a device** (if the product has screens). If
   the project cannot render its screens to images, the founder's check has
   no before/after picture and builders ship UI unseen. Queue the harness
   as a ticket through the Architect; the mobile pack's `mobile-ui-preview`
   describes its shape. Record the render command in `FACTORY.md`.
3. **A deploy runbook** (if the founder wants the Deployer). Read the deploy
   scripts, CI and release history, write the runbook as a project skill,
   and have the founder confirm it before first use. The Deployer's charter
   says what it must contain.
4. **The Observer's checks.** The Observer sets these up itself on its
   first run: it inventories what evidence it can read, proposes checks and
   schedules them. Your part is to make sure that run happens once there is
   something to observe, that each check it could not reach gets its access
   fixed, and that the checks land in `FACTORY.md`.
5. **A live check for behaviour tests cannot prove** (if the product has AI
   or background behaviour): a replay or end-to-end runner a builder can
   run against dev with a test account, and a budget for it. Queue it as a
   ticket; record the command in `FACTORY.md`.

Each of these is done when an agent that has never seen the project can use
it from `FACTORY.md` alone.

## Step 8: start the others, and prove it works

1. Tell the founder to start the Architect from the Agents page (or run
   `bb solo-factor agent start architect`), and any other agents they chose.
   Each reads `FACTORY.md` and runs its own first-run section.
2. Ask the founder for one small, real change. Have the Architect file,
   plan and queue it. Watch it go through every stage. This first ticket is
   the test of the profile: every question a stage asks that the profile
   should have answered is a line to add.
3. Schedule the weekly retros with bb Automations:

   ```sh
   bb automation create --project <id> --name "Factory retro" \
     --cron "0 9 * * 1" --timezone <IANA zone> \
     --script 'bb solo-factor prompt mechanic "Run the weekly retro."'
   ```

4. Report to the founder in a few lines: what you set up, what you changed
   in their repository, the conflicts you removed, what is still open in
   their inbox, and what to do tomorrow (bring the Architect the next piece
   of work).

## Re-running

Run Steps 2 and 3 again when the founder asks, or when a retro shows the
profile has drifted from the code. Update `FACTORY.md` in place; do not
start over.
