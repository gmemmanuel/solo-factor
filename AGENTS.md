# Factory

A bb plugin that turns bb into a solo founder's software factory. TypeScript, bb plugin SDK. Plugin id `solo-factor`, shown in bb as **Factory**.

This repository is meant to be forked and changed by the founder who runs it, usually through their Mechanic agent. Read `LEARNINGS.md` and `docs/DECISIONS.md` before changing anything. Log each session in `docs/WORKLOG.md`.

## What this is for

A founder builds a product with a pipeline of independent agents: plan, review plan, build, review code, ship. Moving tickets between those agents by hand is the founder's whole day. This plugin does the moving: it starts each stage in its own thread on the model chosen for that role, keeps colliding work in sequence with swimlanes, and puts only real founder decisions in one inbox.

**Four layers, kept apart.**

- **The engine owns the flow, never the craft.** `src/` has no opinion on how to plan, review, build or ship. Stage prompts name a skill and add the reporting protocol.
- **Skills own the process.** `skills/` holds the worker protocol, the standing agents' charters, and default process skills (`factory-plan`, `factory-build`, …). They hold no project specifics.
- **Scripts own enforcement.** `kit/` holds the rules that must not depend on an agent remembering them: plan lookup, review receipts, merge and dev turns, swimlane scheduling, Linear. Onboarding installs them into a project as `scripts/factory/`. When agents keep missing a written rule, the fix is a script that refuses, not a louder rule.
- **The project owns its facts.** Commands, paths, the tracker, gates: a project's `FACTORY.md` (template in `templates/`) and `factory.config.json`, written during onboarding. A project's own skills replace any bundled process skill.

When something is tempting to hardcode, ask which layer it belongs to. It is almost never the engine.

## Layout

| Path | What it is |
|---|---|
| `server.ts` | Backend entry: wires bb (threads, events, tools, CLI, RPC) to the engine, and decides which skills and tools each thread gets |
| `src/factory/engine.ts` | The state machine: lanes, stages, handoffs, inbox, standing agents, messaging. All bb access goes through `Effects` |
| `src/factory/store.ts` | SQLite persistence (plugin database). Migrations are append-only |
| `src/factory/model.ts` | Zod shapes shared by server and page |
| `src/factory/defaults.ts` | Default roles, stages, pipelines, standing agents |
| `src/factory/cli.ts` | `bb factory …` |
| `app.tsx` | The Factory page: inbox, swimlanes, standing agents, roles |
| `skills/` | Shipped with the plugin: `factory` (worker protocol), charters (`factory-orchestrator`, `-issue-owner`, `-harness-improver`, `-watch`, `-deploy`, `-integrator`, `-cleaner`, `-contacts`), process (`factory-debug`, `-plan`, `-review-plan`, `-build`, `-review-code`, `-ship`, `-sequence`, `-tracker`) and `factory-onboarding` |
| `kit/` | Zero-dependency Node scripts installed into a project as `scripts/factory/`: `plan-doc`, `plan-surfaces`, `review-receipt`, `ship-turn`, `turn`, `sequence`, `linear`, plus `install.mjs` and their `*.test.mjs` |
| `packs/` | Stack-specific skills that onboarding copies into a project (`mobile`) |
| `templates/` | `FACTORY.md`, the project profile |
| `tests/factory.test.ts` | Behaviour tests on the SDK's fake plugin host |
| `scripts/live-check.mjs` | End-to-end check against a real, throwaway bb server |
| `components/`, `lib/`, `hooks/` | UI source vendored by `bb plugin new`. Ours to edit, but prefer leaving it alone |

## Rules

- **Verify with both suites before saying a change works:** `npm run verify` (typecheck, unit tests, build) and `node scripts/live-check.mjs`. The fake host cannot catch bb's real behaviour; shipped-blocking bugs have been found only by the live check (see `LEARNINGS.md`).
- **Add a test for every rule you add to the engine**, driven through a tool, an event, RPC, or the CLI, not by calling engine methods directly.
- **Every rule a script enforces has a test** in `kit/*.test.mjs` (`npm run test:kit`). Scripts stay dependency-free and keep their decisions in pure exported functions, so the rules are testable without a repository, GitHub or Linear. Tests never reach a real service.
- **A new bundled skill is registered in three places:** its folder in `skills/`, the skill lists in `server.ts`, and `agentSkillIds` in the test harness. A test checks every default stage prompt names a skill that ships.
- **Use public SDK surfaces only.** No bb internals, no DOM scraping. `experimental_` APIs are allowed; note them in `docs/ARCHITECTURE.md`.
- **Reuse bb before building.** bb ships a Conductor-style sidebar, a thread concurrency limit, scheduled automations, push notifications, and PR status. Check the marketplace before adding a surface.
- **Never spend the founder's model quota in tests.** The live check uses bb's echo provider. Do not point checks at a real provider.
- **Never touch the founder's real bb data** (`~/.bb`). Checks run with their own data folder and ports.
- **Store migrations are append-only.** Never edit a shipped statement in `MIGRATIONS`. Saved per-project configuration is data too: a renamed default needs a rule in `withNewDefaults`.
- **Skills are written for an agent that has never seen this project.** No project names, no ticket numbers, no dates of decisions. A rule carries its reason in one clause.
- Founder-facing text (inbox entries, page copy, agent prompts) is plain language: no internal labels, no bare ticket numbers without titles.

## Commands

```sh
npm install
npm run verify                  # typecheck + engine tests + script tests + build
node scripts/live-check.mjs     # real bb, fake model, scratch project; add --keep to look at it
bb plugin install .             # install into your bb (needs bb 0.49+)
bb plugin dev                   # rebuild and reload on save
```

## Where knowledge goes

- `docs/DECISIONS.md`: what the founder decided about the factory, newest first. Check before re-opening a question.
- `LEARNINGS.md`: non-obvious engineering and process lessons.
- `docs/WORKLOG.md`: one entry per session, plus **Next up**, which is the backlog.
- A project's own facts never go here: they go in that project's `FACTORY.md`.
