# Factory profile

<!--
This file is how the factory's agents learn your project. Every bundled skill
reads it first. The Mechanic drafts it during onboarding from your codebase and
your answers; after that it is yours. Keep it short and exact: commands that
run as written, paths that exist. Delete guidance comments as you fill sections.
A section that says "none" is better than a section left as a template.
-->

## Project

- **What it is:** <one or two sentences>
- **Who uses it, and what we call them:** <"customers", "athletes", "operators"; agents use this word when they write to you>
- **Stage of life:** <prototype | private beta with real users | production>. <What must never break: real user data, in-flight sessions, …>

## Tracker

- **Where tickets live:** <Linear | none: the factory's own record and the plans are the tickets>
- **Key format:** <APP-123> · **Link:** <https://linear.app/your-team/issue/{key}> (also set under the Factory settings page)
- **How an agent reads, files and updates a ticket:** `node scripts/factory/linear.mjs …` (the `factory-tracker` skill). The API key comes from <`LINEAR_API_KEY` | the command in `tracker.keyCommand`>.
- **Labels the pipeline moves:** Plan written → Plan reviewed; Small bug; Later. **Started state:** <In Progress>

## Plans

- **Where plan documents live:** `docs/plans/` <or another path, or another repository>. `node scripts/factory/plan-doc.mjs` finds a branch's plan; nobody searches by hand.
- **Naming:** `<KEY> - short title.md`. One outcome, one plan, one branch, one pull request.
- **Decision log:** <path, or "none yet"> · **Learnings:** `LEARNINGS.md`
- **Standing references agents must read before planning in a domain:** <list, or "none">

## Branches, CI and merging

- **Base branch:** `main` · **Branch naming:** <e.g. `app-123-short-title`>
- **Required check on a pull request:** <exact CI check name>
- **Who merges:** <the ship stage, with `scripts/factory/ship-turn.mjs land` on green CI | the founder; ship uses `land --no-merge`>
- **Merge method:** <squash | merge | rebase>
- **Shared things only one branch may use at a time**, each with its turn name for `scripts/factory/turn.mjs`:

  | Turn name | What it is | The command that takes the turn itself |
  |---|---|---|
  | `<api>` | <the one dev deployment of the API> | <`scripts/deploy-dev.sh`, or "take it by hand"> |

## Scripts

`scripts/factory/` holds the pipeline's rules as scripts; `factory.config.json` holds their settings. Run them; do not work around one that refuses.

| Script | Answers |
|---|---|
| `plan-doc.mjs` | Which plan belongs to this branch (exit 0), or that it is a small bug (exit 3) |
| `plan-surfaces.mjs` | Whether a plan declares the files it will touch |
| `review-receipt.mjs` | Whether a review is recorded for the exact commit being shipped |
| `ship-turn.mjs` | Whose turn it is to land on the base branch; merges on green CI |
| `turn.mjs` | Whose turn it is to use a shared dev resource |
| `sequence.mjs` | Which tickets can run side by side; publishes the swimlanes |
| `linear.mjs` | Tickets: read, file, label, comment, close |

## Verification

| Need | Command | Notes |
|---|---|---|
| Lint | `<command>` | |
| Types | `<command>` | |
| Tests for changed files | `<command>` | <never run the whole suite locally? say so> |
| Whole suite | `<command>` | <where it runs: CI only, or locally> |
| Database / migration tests | `<command or none>` | |
| Live QA harness for AI or backend behaviour | `<command or none>` | <budget rules, test accounts> |
| Render UI before/after without a device | `<command or none>` | <see the mobile pack's `mobile-ui-preview`> |

- **Test accounts:** <how to create or seed one; the password convention>
- **What agents may do without asking:** <deploy to dev, run migrations on dev, read production read-only, …>
- **What agents must never do:** <deploy to production, change real user data, start long-lived dev servers, …>

## Founder gates

- **The founder tries it before it ships when:** <a screen or copy changes | every ticket | never>
- **How the founder tests:** <on their phone from a preview build | a preview URL | locally>
- **What always needs the founder:** <product behaviour, scope, mockup approval, real users' data>

## Stage skills

Which skill each stage uses. The default is the factory's bundled skill; name
your own when the project has one. Changing a row also needs
`bb solo-factor stage <stage> --prompt "Use the \`<skill>\` skill to …"`.

| Stage | Skill | Project additions the bundled skill must follow |
|---|---|---|
| Diagnose a bug | `factory-debug` | |
| Plan | `factory-plan` | |
| Review plan | `factory-review-plan` | |
| Build | `factory-build` | |
| Review code | `factory-review-code` | |
| Ship | `factory-ship` | |

## Standing agents

| Agent | On? | Method (skill or runbook it follows) | Schedule |
|---|---|---|---|
| Architect | yes | this file + `factory-plan` | weekly retro |
| Mechanic | yes | `factory-mechanic` | weekly retro |
| Observer | <yes/no> | see "Observer checks" | <daily at …> |
| Deployer | <yes/no> | <deploy runbook or skill> | on request only |
| Integrator | <yes/no> | <dependency method> | <weekly> |
| Cleaner | <yes/no> | <disk method> | <weekly> |

## Observer checks

One row per recurring check. The Observer proposes these on its first run.

| Check | Evidence source and how to read it | Cadence | Where it records how far it got |
|---|---|---|---|
| What real users did | <database / analytics / logs; exact read path> | daily | Observer memory file |
| Errors | <Sentry / logs / none> | daily | |
| Did shipped changes work | <what to compare> | weekly | |
| User feedback | <where it lands> | daily | |

## Packs installed

<none | mobile (copied into `<skills dir>` on <date>)>
