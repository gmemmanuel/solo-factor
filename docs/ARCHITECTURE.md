# Architecture

## One idea

bb already has the right primitives: projects, worktree environments, threads on any provider, a queue, events, and a plugin SDK. The factory adds the one thing missing for a staged pipeline: something that decides **what starts next, where, on which model, and who is told**.

```text
Founder ──► Architect (standing thread, main checkout)
                │  factory_enqueue
                ▼
        ┌──────────── lanes ────────────┐
        │ Checkout:  APP-12 ─► APP-15 ─► … │   one ticket at a time per lane
        │ Plan:   APP-20 ─► …           │   lanes run side by side, up to the cap
        └───────────────────────────────┘
                │ each ticket: its own worktree
                ▼
   plan ─► review plan ─► build ─► review code ─► ship
   (each stage: a fresh thread, the role's model, same worktree)
                │
                ├─ factory_stage_done ──► next stage / findings to author
                ├─ factory_ask_founder ─► Inbox ─► answer back to that thread
                └─ factory_message ─────► another thread
```

## Pieces

| Piece | File | Notes |
|---|---|---|
| Engine | `src/factory/engine.ts` | Pure rules. Serialises every mutation through one promise chain, so two events cannot both start a ticket. Talks to bb only through `Effects` |
| Store | `src/factory/store.ts` | Plugin SQLite: `items`, `inbox`, `agents`, `thread_bindings`, `configs`. JSON documents with indexed columns, validated on read |
| Effects | `server.ts` | `threads.spawn`, `threads.send`, `threads.retry`, `threads.get`, `threads.unpin`, `threads.interactions.list`, push notification RPC, realtime publish |
| Events | `server.ts` | `thread.idle`, `thread.active`, `thread.failed`, `thread.archived`, `thread.deleted`, `interaction.pending` |
| Agent tools | `server.ts` | `factory_stage_done`, `factory_ask_founder`, `factory_message`, `factory_enqueue`, `factory_status` |
| CLI | `src/factory/cli.ts` | `bb solo-factor …`, the same operations for agents and scripts |
| Inbound hook | `server.ts` | `POST /api/v1/plugins/solo-factor/http/prompt` with the plugin token wakes a standing agent. Reachable from this machine only; bb's public address puts its own sign-in in front |
| Page | `app.tsx` | Nav panel at `/plugins/solo-factor/factory`, with an inbox count on the rail. An inbox answer is sent from the thread's own composer (a hidden `ThreadChat`), with the factory's context in an agent-only mention pill (`bb.ui.registerMentionProvider`, provider `inbox-answer`) |
| Skills | `skills/` | `factory` (worker protocol); charters: `factory-architect` (Architect), `factory-mechanic` (Mechanic), `factory-observer` (Observer), `factory-deployer` (Deployer), `factory-integrator`, `factory-cleaner`, `factory-issue-owner`, `factory-contacts`; process defaults: `factory-debug`, `factory-plan`, `factory-review-plan`, `factory-build`, `factory-review-code`, `factory-ship`; and `factory-onboarding` |
| Project profile | `templates/FACTORY.md` | Copied into a project by onboarding. Every bundled skill reads the project's copy first |
| Packs | `packs/` | Stack-specific skills copied into a project (`mobile`) |

## Four layers

| Layer | Where | Owns |
|---|---|---|
| Flow | `src/` (the engine) | What starts next, where, on which model, and who is told. No opinion on how work is done |
| Process | `skills/` | The worker protocol, standing agents' charters, and default process skills. No project specifics |
| Enforcement | `kit/`, installed into a project as `scripts/factory/` | Plan lookup, review receipts, merge and dev turns, swimlane scheduling, Linear. Rules as exit codes |
| Project | the project's `FACTORY.md` and its own skills | Commands, paths, tracker, gates, stack |

Which skills a thread gets is decided in `server.ts` (`bb.agents.configure`), keyed on the thread's plugin metadata: stage and owner threads get the protocol, the owner charter and the process skills; standing agents get the protocol, their charter, onboarding and the process skills; any other thread in a project with a factory gets `factory-contacts`.

## Configuration

Per bb project, falling back to `src/factory/defaults.ts`:

- **roles**: provider, model, thinking level, permission mode. Empty means the project default.
- **stages**: label, role, one-line prompt naming a skill (a bundled `factory-*` process skill by default, a project's own after `bb solo-factor stage`), and whether it is a review.
- **pipelines**: ordered stage lists. Defaults: `full`, `planned` (starts at plan review), `reviewed` (starts at build), `small-bug`.
- **maxActiveItems**: tickets in flight across all lanes. Default 8.
- **agents**: standing agents, each with a role, a charter skill, and a memory file path in the repo.

## Ticket lifecycle

```text
queued ─► running ─► done
            │  ▲
            │  └── answer / retry / thread resumed
            ├─► needs-founder   (asked a question, or reported blocked)
            ├─► returned        (review sent findings back to whoever queued it)
            ├─► stalled         (stopped twice without reporting)
            └─► failed          (turn failed, stage could not start, thread removed)
```

Every state except `queued`, `done` and `cancelled` holds its lane and counts toward the cap.

## Rules worth knowing

- **Independent review is structural.** Every stage is a new thread, so a reviewer never shares context with the author. The plugin also tells stage threads not to launch their own reviewer.
- **One review pass.** A review that requests changes is recorded as passed. Findings go to the author's existing thread; when the author reports done, the ticket skips that review unless the author passes `rereview`.
- **Findings with no author stage** (a ticket queued already planned) go to the thread that queued it, usually the architect, which fixes the plan and runs `bb solo-factor advance`.
- **Silence is handled.** A stage thread that goes idle without reporting gets one reminder. The second time, the ticket is `stalled` and the founder is told.
- **A ticket's planner is its plan reviewer.** `factory_ask_owner` sends a stage's question to the thread of the nearest earlier review stage (else whoever queued the ticket, else the architect) and sets `with-planner`; the reply by `factory_message` to the stage's thread resumes it.
- **Builder tiers.** A stage may name a role per plan tier (`tierRoles`); the ticket's tier picks it, and a ticket without one uses the stage's own role.
- **Fallback on a usage limit.** A role may name a fallback model. When a factory thread's turn fails on a usage limit, the thread is moved to the fallback and rerun once, and the role's new threads start on the fallback until the limit's reported reset. With no fallback the failure goes to the inbox.
- **Tools are scoped.** Stage threads get report, ask and message. Standing agents also get enqueue and status. Other threads get nothing and use the CLI.
- **The inbox spans projects.** It is the founder's single queue.

## Issue owners

Every ticket has one thread the founder talks to: its **issue owner**. A stage marked `owner` makes the thread that runs it the owner from then on; by default that is plan review. A ticket whose plan was reviewed elsewhere gets an owner thread in its workspace the first time one is needed.

- **Only the owner reaches the inbox for its ticket.** `factory_ask_founder`, `factory_ask_owner` and a blocked report from any other thread on the ticket go to the owner, and the ticket shows as with its owner until the owner replies to the stage, sends the builder work, or asks the founder.
- **The founder's notes on a check go to the owner.** The owner plans the change and messages the builder's stage, which is what moves the ticket back to that stage. The same message reopens a ticket that already shipped. If nothing should change, the owner reports "complete" and the check returns to the founder with the owner's reason.
- **Follow-up under a new ticket.** `factory_follow_up` on a shipped ticket creates the new ticket on the pipeline that follows the owner stage, in the same workspace, rebinds the owner thread to it, renames the workspace, archives the shipped ticket and starts the builder on the owner's handoff.
- **Names.** A thread is titled with its role (`Issue owner`, `Execution`, `Code review`, `Ship`); the workspace is named for the ticket with `environments.update`, once bb has assigned the worktree.
- **The factory still moves tickets.** The owner never starts a stage. A separate code reviewer always runs; findings go to the builder directly.
- **The ticket note.** The owner keeps a short note through `factory_ticket_note`. The engine stores it and appends it to everything it hands the owner, so it survives compaction.
- **A reply in the thread answers the inbox.** When the founder starts a turn in a thread that has an open ask, the ask closes. bb raises no event for that, so on `thread.active` the server reads the thread's latest `client/turn/requested` event and checks its initiator.

## Small bugs

A ticket on the `small-bug` pipeline gets no workspace. It is attached to the next planned ticket whose build has not started, in the lane named or in any lane, and every stage of that ticket is told to cover it. With no planned ticket coming up it runs alone on the `fix` stage, whose builder owns it.

## Standing agents

Six by default; most projects start two. The **Architect** (id `architect`) decides what becomes work, files and plans every ticket itself and queues it; the **Observer** (id `observer`) reads what real users did each day, runs the other recurring checks and hands everything it found to the Architect, and the **Mechanic** (id `mechanic`) understands how the factory is built and keeps improving the whole kit: this plugin, the skill library across projects, and the checks. It runs the weekly retro and takes the founder's factory requests. Its work crosses projects, so it works in its own worktree of whichever repository it changes. Scheduled work reaches them through bb Automations running `bb solo-factor prompt <agent> "…"`, which starts the agent if it has no thread. A message to an unstarted standing agent starts it too.

A standing agent is a pinned thread in the project's main checkout, started from the page. Its first prompt names its charter skill and its memory file. "Fresh thread" asks the current thread to write everything it knows to the memory file; when that thread goes idle, a new thread starts from the file and the old one is unpinned.

## What the factory deliberately leaves to others

| Need | Who does it |
|---|---|
| Workspace sidebar, tabs, run script | bb's Conductor layout plugin (on bb's main branch, not yet in 0.49); until then bb's sidebar groups threads by worktree |
| Cap on running threads per machine | bb's built-in Concurrency limit plugin |
| Scheduled prompts (weekly retro, triage) | bb's built-in Automations plugin, running `bb solo-factor prompt <agent> "…"` as a script |
| Notifications to phone and desktop | bb's built-in Push notifications plugin (the factory calls it) |
| Pull request status | bb's built-in GitHub PR status plugin |
| Taking turns for dev deploys and merging | `kit/turn.mjs` and `kit/ship-turn.mjs`: file-based turns shared by every worktree of a repository, expiring on their own |
| Which tickets may run side by side | `kit/sequence.mjs` validates the Architect's schedule against plans' declared files, branches' real changes and tracker blockers, then calls `bb solo-factor sync`. The engine only runs the lanes it is given |
| Tickets | Linear, through `kit/linear.mjs`, or none. A built-in ticket system is planned |
| How to plan, review, build, ship | Skills: the bundled defaults in `skills/`, or the project's own. Never the engine |
| Everything specific to one project | That project's `FACTORY.md` |

## Experimental bb APIs in use

- `app.slots.experimental_appOverlay` mounts the inbox chime once per window, so it plays on any page.
- `experimental_appOverlay` also mounts the Run watcher, which lists each thread's terminals and listens to `thread:changed` for `terminals-changed`.
- `app.contentScripts` with `experimental_setThreadRowStatus` puts the "Run is up" mark on a thread row. It is the only way a plugin can decorate a row, and it has no SDK client, so it hands its setter to the overlay.
- `navigate.experimental_openTerminal` shows the Run terminal beside the Factory page.
- `useComposers()` finds the thread's composer once it is on screen, and `composer.replace` puts an inbox draft into it. `app.composer.customize({ banners })` shows the open ask above a thread's composer.
- `sdk.projects.attachments.upload` stores a file the founder attaches; the uploaded record is passed to `threads.send` as an input part.

- `app.slots.navPanel({ experimental_useBadge })` for the rail count.
- `threads.interactions.list` result shape is read defensively.

Everything else is on stable SDK surfaces.
