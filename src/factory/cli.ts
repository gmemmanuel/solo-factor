// `bb solo-factor …` — the same operations the Factory page and the agent tools
// use, for agents and scripts. Argument parsing is deliberately small: flags
// are `--name value`, everything else is positional.
import type { FactoryEngine } from "./engine.js";
import { FactoryError } from "./engine.js";
import type { Attachment } from "./model.js";
import type { FactoryStore } from "./store.js";

export const CLI_COMMANDS = [
  { name: "status", summary: "Show lanes, tickets and the inbox", usage: "bb solo-factor status [--project <id>] [--json]" },
  { name: "enqueue", summary: "Add a ticket to a lane", usage: "bb solo-factor enqueue <key> <title…> [--lane <name>] [--pipeline <name>] [--tier 1|2|3] [--builder ui|fullstack] [--brief <text>]" },
  { name: "lanes", summary: "Queue many tickets at once from JSON", usage: "bb solo-factor lanes '<json>'   # {\"lanes\":[{\"name\":\"A\",\"items\":[{\"key\":\"APP-1\",\"title\":\"…\",\"pipeline\":\"planned\",\"brief\":\"…\"}]}]}" },
  { name: "sync", summary: "Make the lanes match a schedule: queue new tickets, move changed ones, drop unstarted ones no longer listed. Never reorders a lane or stops started work", usage: "bb solo-factor sync '<json>'   # same JSON as lanes; list every ticket that belongs in the factory" },
  { name: "move", summary: "Move a ticket to a lane and slot", usage: "bb solo-factor move <key> --lane <name> [--position <n>]" },
  { name: "advance", summary: "Send a ticket on to its next stage", usage: "bb solo-factor advance <key> [--summary <text>]" },
  { name: "cancel", summary: "Take a ticket out of the factory", usage: "bb solo-factor cancel <key>" },
  { name: "rereview", summary: "Send a ticket back to its last review, in a fresh thread, because its work changed after review", usage: "bb solo-factor rereview <key>" },
  { name: "archive", summary: "Archive a merged ticket's workspace and take it off the board (the Done card's Archive button)", usage: "bb solo-factor archive <key>" },
  { name: "done", summary: "Report this thread's stage (same as factory_stage_done)", usage: "bb solo-factor done --outcome complete|changes_requested|blocked --summary <text> [--founder-check <text> [--screenshot <path>]...] [--before <text> --after <text> --why <text>] [--no-founder-check <reason>] [--rereview]" },
  { name: "reopen-check", summary: "Put a ticket that left with an unapproved founder check back at the gate, its check in the inbox", usage: "bb solo-factor reopen-check <KEY> [--approved]" },
  { name: "check-images", summary: "Put the side-by-side before/after image on a check waiting for the founder (same as factory_check_images)", usage: "bb solo-factor check-images --before-after <path> [--screenshot <path>]… [--key <KEY>]" },
  { name: "ask", summary: "Ask the founder (same as factory_ask_founder)", usage: "bb solo-factor ask <question…> [--context <text>] [--option <text>]… [--recommend <text>] [--todo|--testing] [--account <text>] [--step <text>]…" },
  { name: "ask-owner", summary: "Send something back to this ticket's issue owner (same as factory_ask_owner)", usage: "bb solo-factor ask-owner <handoff…>" },
  { name: "follow-up", summary: "Issue owner: continue a shipped ticket under a new one, in the same workspace (same as factory_follow_up)", usage: "bb solo-factor follow-up <key> <title…> --handoff <text>" },
  { name: "retitle", summary: "Title every ticket thread with its role and name each workspace for its ticket", usage: "bb solo-factor retitle [--project <id>]" },
  { name: "note", summary: "Issue owner: replace the ticket note (same as factory_ticket_note)", usage: "bb solo-factor note <text…>" },
  { name: "message", summary: "Message an agent or a ticket's thread", usage: "bb solo-factor message <agent|KEY|KEY:stage> <text…>" },
  { name: "close", summary: "Standing agent: close one of your own inbox questions once it is settled (same as factory_close_ask)", usage: "bb solo-factor close <entry-id>" },
  { name: "inbox", summary: "List open founder decisions", usage: "bb solo-factor inbox [--json]" },
  { name: "approve", summary: "Approve a ticket the founder has tried, so it ships", usage: "bb solo-factor approve <entry-id>" },
  { name: "retag", summary: "Correct an inbox entry's kind", usage: "bb solo-factor retag <entry-id> question|test|todo" },
  { name: "answer", summary: "Answer an inbox entry", usage: "bb solo-factor answer <entry-id> <text…>" },
  { name: "agent", summary: "Start or rotate a standing agent", usage: "bb solo-factor agent start|rotate <agent-id> [--project <id>]" },
  { name: "prompt", summary: "Send a standing agent a prompt, starting it if needed (for automations)", usage: "bb solo-factor prompt <agent-id> <text…> [--project <id>]" },
  { name: "role", summary: "Set which model plays a role", usage: "bb solo-factor role <role> [--provider <id>] [--model <id>] [--reasoning <level>] [--permission accept-edits|auto|full] [--fallback-provider <id>] [--fallback-model <id>] [--fallback-reasoning <level>] [--project <id>]" },
  { name: "tier", summary: "Record a ticket's implementer tier and builder from its plan", usage: "bb solo-factor tier <key> [--tier 1|2|3] [--builder ui|fullstack]" },
  { name: "stage", summary: "Set a stage's prompt (which skill it uses) or role", usage: "bb solo-factor stage <stage> [--prompt <text>] [--role <role>] [--project <id>]   # prompt takes {key} {title} {brief} {previous} {lane}" },
  { name: "config", summary: "Print the factory configuration", usage: "bb solo-factor config [--project <id>]" },
];

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["json", "rereview", "help", "testing", "todo", "approved"]);

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    let value = inline;
    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(name)) value = "true";
      else {
        value = argv[index + 1];
        if (value === undefined) throw new FactoryError(`--${name} needs a value.`);
        index += 1;
      }
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positionals, flags };
}

export interface CliContext {
  threadId?: string;
  projectId?: string;
}

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export async function runCli(
  argv: string[],
  ctx: CliContext,
  store: FactoryStore,
  engine: FactoryEngine,
  storeScreenshot?: (projectId: string, path: string) => Promise<Attachment>,
): Promise<CliResult> {
  const usage = ["Usage:", ...CLI_COMMANDS.map((command) => `  ${command.usage}`)].join("\n");
  try {
    const { positionals, flags } = parse(argv);
    const [command, ...rest] = positionals;
    const flag = (name: string) => flags.get(name)?.at(-1);
    const json = flags.has("json");
    const ok = (value: unknown, text: string): CliResult => ({
      exitCode: 0,
      stdout: json ? JSON.stringify(value) : text,
    });
    const projectId = () => {
      const id = flag("project") ?? ctx.projectId;
      if (id === undefined) {
        throw new FactoryError("No project in context. Add --project <project-id> (see `bb project list`).");
      }
      return id;
    };
    const thread = () => {
      if (ctx.threadId === undefined) {
        throw new FactoryError("This command reports for the calling thread; run it from inside a factory thread.");
      }
      return ctx.threadId;
    };
    const itemByKey = (key: string | undefined) => {
      if (key === undefined) throw new FactoryError("Name the ticket key.");
      const item = store.findItemByKey(projectId(), key);
      if (item === null) throw new FactoryError(`No ticket "${key}" in this project's factory.`);
      return item;
    };

    switch (command) {
      case undefined:
      case "help":
        return { exitCode: 0, stdout: usage };
      case "status": {
        const items = store.listItems(projectId());
        const inbox = store.listInbox({ status: "open" }).filter((e) => e.projectId === projectId());
        return ok({ items, inbox }, formatStatus(store, projectId()));
      }
      case "enqueue": {
        const [key, ...title] = rest;
        if (key === undefined || title.length === 0) break;
        const item = await engine.enqueue({
          projectId: projectId(),
          key,
          title: title.join(" "),
          brief: flag("brief"),
          lane: flag("lane"),
          pipeline: flag("pipeline"),
          ...(flag("tier") === undefined ? {} : { tier: Number(flag("tier")) }),
          ...(flag("builder") === "ui" || flag("builder") === "fullstack" ? { builder: flag("builder") as "ui" | "fullstack" } : {}),
          originThreadId: ctx.threadId ?? null,
        });
        if (item.key !== key) return ok(item, `${key} rides with ${item.key} in lane "${item.lane}": built, reviewed and shipped with it.`);
        return ok(item, `${item.key} queued in lane "${item.lane}" (${item.status}).`);
      }
      case "lanes": {
        const raw = rest.join(" ");
        let plan: unknown;
        try {
          plan = JSON.parse(raw);
        } catch {
          throw new FactoryError("`bb solo-factor lanes` takes one JSON argument; see `bb solo-factor help`.");
        }
        const lanes = (plan as { lanes?: unknown }).lanes;
        if (!Array.isArray(lanes)) throw new FactoryError('Expected {"lanes":[…]}.');
        const report: string[] = [];
        for (const lane of lanes as { name?: string; items?: unknown }[]) {
          for (const entry of (Array.isArray(lane.items) ? lane.items : []) as Record<string, string>[]) {
            try {
              const item = await engine.enqueue({
                projectId: projectId(),
                key: String(entry.key ?? ""),
                title: String(entry.title ?? entry.key ?? ""),
                brief: entry.brief,
                pipeline: entry.pipeline,
                lane: lane.name,
                originThreadId: ctx.threadId ?? null,
              });
              report.push(`${item.key}: queued in "${item.lane}"`);
            } catch (error) {
              report.push(`${entry.key}: skipped (${error instanceof Error ? error.message : String(error)})`);
            }
          }
        }
        return ok({ report }, report.join("\n") || "Nothing to queue.");
      }
      case "sync": {
        let plan: { lanes?: unknown };
        try {
          plan = JSON.parse(rest.join(" ")) as { lanes?: unknown };
        } catch {
          throw new FactoryError("`bb solo-factor sync` takes one JSON argument; see `bb solo-factor help`.");
        }
        if (!Array.isArray(plan.lanes)) throw new FactoryError('Expected {"lanes":[…]}.');
        const lanes = (plan.lanes as { name?: unknown; items?: unknown }[]).map((lane) => ({
          name: String(lane.name ?? ""),
          items: (Array.isArray(lane.items) ? (lane.items as Record<string, unknown>[]) : []).map((entry) => ({
            key: String(entry.key ?? ""),
            title: String(entry.title ?? entry.key ?? ""),
            ...(typeof entry.brief === "string" ? { brief: entry.brief } : {}),
            ...(typeof entry.pipeline === "string" ? { pipeline: entry.pipeline } : {}),
            ...(entry.tier === 1 || entry.tier === 2 || entry.tier === 3 ? { tier: entry.tier } : {}),
            ...(entry.builder === "ui" || entry.builder === "fullstack" ? { builder: entry.builder as "ui" | "fullstack" } : {}),
            ...(Array.isArray(entry.waitingOn) ? { waitingOn: (entry.waitingOn as unknown[]).filter((key): key is string => typeof key === "string") } : {}),
            ...(entry.parked === true ? { parked: true } : {}),
          })),
        }));
        const report = await engine.syncLanes(projectId(), lanes, ctx.threadId ?? null);
        return ok({ report }, report.join("\n") || "Lanes already match.");
      }
      case "move": {
        const item = itemByKey(rest[0]);
        const lane = flag("lane") ?? item.lane;
        const position = flag("position");
        const moved = await engine.move(item.id, lane, position === undefined ? undefined : Number(position));
        return ok(moved, `${moved.key} is now in "${moved.lane}" at slot ${moved.position}.`);
      }
      case "tier": {
        const item = itemByKey(rest[0]);
        const tier = flag("tier");
        const builder = flag("builder");
        if (tier === undefined && builder === undefined) throw new FactoryError("Give --tier 1|2|3, --builder ui|fullstack, or both.");
        if (tier !== undefined && !["1", "2", "3"].includes(tier)) throw new FactoryError("--tier is 1, 2 or 3.");
        if (builder !== undefined && builder !== "ui" && builder !== "fullstack") throw new FactoryError("--builder is ui or fullstack.");
        const set = await engine.setTier(item.id, tier === undefined ? undefined : Number(tier), builder);
        return ok(set, `${set.key}: tier ${set.tier ?? "unset"}, builder ${set.builder ?? "unset"}.`);
      }
      case "advance": {
        const moved = await engine.advance(itemByKey(rest[0]).id, flag("summary"));
        return ok(moved, `${moved.key} advanced (${moved.status}).`);
      }
      case "cancel": {
        const cancelled = await engine.cancel(itemByKey(rest[0]).id);
        return ok(cancelled, `${cancelled.key} cancelled.`);
      }
      case "close": {
        if (rest[0] === undefined) break;
        const closed = await engine.closeAsk(thread(), rest[0]);
        return ok(closed, `Closed: ${closed.question}`);
      }
      case "rereview": {
        const sent = await engine.rereview(itemByKey(rest[0]).id);
        return ok(sent, `${sent.key} is back in review in a fresh thread.`);
      }
      case "archive": {
        const archived = await engine.archiveDone(itemByKey(rest[0]).id);
        return ok(archived, `${archived.key} archived with its workspace.`);
      }
      case "done": {
        const outcome = flag("outcome");
        const summary = flag("summary");
        if (outcome !== "complete" && outcome !== "changes_requested" && outcome !== "blocked") break;
        if (summary === undefined) break;
        const [before, after, why] = [flag("before"), flag("after"), flag("why")];
        const changeNote = before !== undefined && after !== undefined && why !== undefined ? { before, after, why } : undefined;
        const shotPaths = flags.get("screenshot") ?? [];
        if (shotPaths.length > 0 && storeScreenshot === undefined) throw new FactoryError("Screenshots cannot be stored here.");
        const screenshots = await Promise.all(shotPaths.map((path) => storeScreenshot!(projectId(), path)));
        const text = await engine.stageDone(thread(), { outcome, summary, rereview: flags.has("rereview"), founderCheck: flag("founder-check"), founderCheckWithdrawn: flag("no-founder-check"), changeNote, screenshots });
        return ok({ message: text }, text);
      }
      case "reopen-check": {
        const item = await engine.reopenCheck(projectId(), rest[0] ?? "", flags.has("approved"));
        return ok(item, flags.has("approved") ? `${item.key} is approved and back in its ship stage (${item.status}).` : `${item.key} is back at the founder gate (${item.status}); its check is in the inbox.`);
      }
      case "check-images": {
        const first = flag("before-after");
        if (first === undefined) throw new FactoryError("Give --before-after <absolute path to the side-by-side image>.");
        if (storeScreenshot === undefined) throw new FactoryError("Images cannot be stored here.");
        const key = flag("key");
        const shots = await Promise.all([first, ...(flags.get("screenshot") ?? [])].map((path) => storeScreenshot(projectId(), path)));
        const text = await engine.setCheckImages(key === undefined ? thread() : null, shots, key === undefined ? undefined : { projectId: projectId(), key });
        return ok({ ok: true }, text);
      }
      case "ask": {
        if (rest.length === 0) break;
        const entry = await engine.ask(thread(), {
          question: rest.join(" "),
          context: flag("context"),
          options: flags.get("option") ?? [],
          recommendation: flag("recommend"),
          kind: flags.has("todo") ? "todo" : flags.has("testing") ? "test" : "decision",
          account: flag("account"),
          steps: flags.get("step"),
        });
        return ok(entry, entry.id === "" ? "Sent to this ticket's issue owner. The reply will arrive in this thread. End your turn." : `Asked (${entry.id}). The answer will arrive in the thread it concerns. End your turn.`);
      }
      case "ask-owner": {
        if (rest.length === 0) break;
        const text = await engine.askOwner(thread(), rest.join(" "));
        return ok({ message: text }, text);
      }
      case "follow-up": {
        const [key, ...title] = rest;
        const handoff = flag("handoff");
        if (key === undefined || title.length === 0 || handoff === undefined) break;
        const item = await engine.followUp(thread(), { key, title: title.join(" "), handoff });
        return ok(item, `${item.key} has taken over the workspace and its builder has started.`);
      }
      case "retitle": {
        const report = await engine.retitle(projectId());
        return ok(report, report.length === 0 ? "Nothing to retitle." : report.join("\n"));
      }
      case "note": {
        if (rest.length === 0) break;
        const text = await engine.setNote(thread(), rest.join(" "));
        return ok({ message: text }, text);
      }
      case "message": {
        const [to, ...text] = rest;
        if (to === undefined || text.length === 0) break;
        const sent = await engine.message(projectId(), ctx.threadId ?? null, to, text.join(" "));
        return ok({ message: sent }, sent);
      }
      case "inbox": {
        const entries = store.listInbox({ status: "open" });
        return ok(
          entries,
          entries.length === 0
            ? "Inbox is empty."
            : entries.map((e) => `${e.id}  [${e.kind}] ${e.from}: ${e.question}`).join("\n"),
        );
      }
      case "approve": {
        if (rest[0] === undefined) break;
        const item = await engine.approveCheck(rest[0]);
        return ok(item, `${item.key} approved (${item.status}).`);
      }
      case "retag": {
        const [id, kind] = rest;
        if (id === undefined || (kind !== "question" && kind !== "test" && kind !== "todo")) break;
        const entry = await engine.retag(id, kind);
        return ok(entry, `Now shown as ${kind}.`);
      }
      case "answer": {
        const [id, ...text] = rest;
        if (id === undefined || text.length === 0) break;
        const entry = await engine.answer(id, text.join(" "));
        return ok(entry, "Answer delivered.");
      }
      case "agent": {
        const [action, agentId] = rest;
        if (agentId === undefined || (action !== "start" && action !== "rotate")) break;
        const state =
          action === "start"
            ? await engine.startAgent(projectId(), agentId)
            : await engine.rotateAgent(projectId(), agentId);
        return ok(state, `${agentId}: thread ${state.threadId ?? "pending"}${state.rotating ? " (handing off)" : ""}.`);
      }
      case "prompt": {
        const [agentId, ...text] = rest;
        if (agentId === undefined || text.length === 0) break;
        const state = await engine.promptAgent(projectId(), agentId, text.join(" "));
        return ok(state, `Prompt sent to ${agentId} (thread ${state.threadId}).`);
      }
      case "role": {
        const [roleId] = rest;
        const config = store.getConfig(projectId());
        const role = roleId === undefined ? undefined : config.roles[roleId];
        if (roleId === undefined || role === undefined) {
          throw new FactoryError(`Name a role: ${Object.keys(config.roles).join(", ")}.`);
        }
        const permission = flag("permission");
        if (permission !== undefined && !["", "accept-edits", "auto", "full"].includes(permission)) {
          throw new FactoryError("--permission is accept-edits, auto or full.");
        }
        const next = {
          ...role,
          providerId: flag("provider") ?? role.providerId,
          model: flag("model") ?? role.model,
          reasoningLevel: flag("reasoning") ?? role.reasoningLevel,
          permissionMode: (permission ?? role.permissionMode) as typeof role.permissionMode,
          fallbackProviderId: flag("fallback-provider") ?? role.fallbackProviderId,
          fallbackModel: flag("fallback-model") ?? role.fallbackModel,
          fallbackReasoningLevel: flag("fallback-reasoning") ?? role.fallbackReasoningLevel,
        };
        store.setConfig(projectId(), { ...config, roles: { ...config.roles, [roleId]: next } });
        return ok(next, `${roleId}: ${describeRole(next)}`);
      }
      case "stage": {
        // How onboarding points a stage at the project's own skill instead of
        // the bundled one, without the settings page.
        const [stageId] = rest;
        const config = store.getConfig(projectId());
        const stage = stageId === undefined ? undefined : config.stages[stageId];
        if (stageId === undefined || stage === undefined) {
          throw new FactoryError(`Name a stage: ${Object.keys(config.stages).join(", ")}.`);
        }
        const role = flag("role");
        if (role !== undefined && config.roles[role] === undefined) {
          throw new FactoryError(`No role "${role}". Roles: ${Object.keys(config.roles).join(", ")}.`);
        }
        // A shell passes "\n" as two characters; a prompt's blank lines are typed that way.
        const prompt = flag("prompt")?.replace(/\\n/g, "\n");
        if (prompt !== undefined && prompt.trim() === "") throw new FactoryError("--prompt cannot be empty.");
        const next = { ...stage, prompt: prompt ?? stage.prompt, role: role ?? stage.role };
        store.setConfig(projectId(), { ...config, stages: { ...config.stages, [stageId]: next } });
        return ok(next, `${stageId}: role ${next.role}\n${next.prompt}`);
      }
      case "config":
        return { exitCode: 0, stdout: JSON.stringify(store.getConfig(projectId()), null, 2) };
    }
    return { exitCode: 1, stderr: usage };
  } catch (error) {
    if (error instanceof FactoryError || (error instanceof Error && error.name === "ZodError")) {
      return { exitCode: 1, stderr: error.message };
    }
    return { exitCode: 1, stderr: `Factory error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function describeRole(role: { providerId: string; model: string; reasoningLevel: string; fallbackModel?: string; fallbackProviderId?: string }): string {
  const parts = [role.providerId, role.model, role.reasoningLevel].filter((part) => part !== "");
  const base = parts.length === 0 ? "project default" : parts.join(" · ");
  return role.fallbackModel ? `${base} (falls back to ${[role.fallbackProviderId, role.fallbackModel].filter(Boolean).join(" ")})` : base;
}

export function formatStatus(store: FactoryStore, projectId: string): string {
  const config = store.getConfig(projectId);
  const items = store.listItems(projectId).filter((item) => item.status !== "cancelled" && item.status !== "archived");
  const lines: string[] = [];
  const lanes = [...new Set(items.map((item) => item.lane))];
  for (const lane of lanes) {
    lines.push(`${lane}`);
    for (const item of items.filter((candidate) => candidate.lane === lane)) {
      const stageId = config.pipelines[item.pipeline]?.[item.stageIndex];
      const stage = stageId === undefined ? "" : (config.stages[stageId]?.label ?? stageId);
      lines.push(`  ${item.key}  ${item.parked ? "later" : item.status}${item.status === "done" ? "" : `  ${stage}`}  — ${item.title}`);
      for (const rider of item.riders) lines.push(`      + ${rider.key}  rides with ${item.key}  — ${rider.title}`);
    }
  }
  if (lines.length === 0) lines.push("No tickets in the factory.");
  const inbox = store.listInbox({ status: "open" }).filter((entry) => entry.projectId === projectId);
  lines.push("", inbox.length === 0 ? "Inbox: empty" : `Inbox: ${inbox.length} waiting on the founder`);
  for (const entry of inbox) lines.push(`  ${entry.id}  ${entry.from}: ${entry.question}`);
  return lines.join("\n");
}
