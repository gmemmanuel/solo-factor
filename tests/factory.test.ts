// Behavioural tests for the factory, driven through the same surfaces bb uses:
// agent tools, thread lifecycle events, RPC and the CLI, against the SDK's fake
// plugin host (real SQLite, recorded bb.sdk calls).
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { type FactoryState } from "../server.js";
import { parseRunCommand } from "../src/factory/runScript.js";

const PROJECT = "proj_1";

interface Spawned {
  id: string;
  title: string;
  prompt: string;
  environment: { type: string; environmentId?: string; workspace?: { type: string } };
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  pinned?: boolean;
  pluginMetadata: { binding: Record<string, string> };
}

/** A last review's note on what changed; any stage may pass one. */
const NOTE = { before: "Users saw the old greeting.", after: "They see the new one.", why: "The founder asked for it." };

function setup() {
  const spawned: Spawned[] = [];
  const sent: { threadId: string; text: string; senderThreadId?: string; attachments?: unknown[] }[] = [];
  const retried: string[] = [];
  const archived: string[] = [];
  const updated: { threadId: string; model?: string; reasoningLevel?: string; title?: string }[] = [];
  const renamed: { environmentId: string; name: string }[] = [];
  const archivedWorkspaces: string[] = [];
  let failSpawn = false;
  /** Who started each thread's latest turn. */
  const lastTurn = new Map<string, "user" | "agent" | "plugin">();
  const host = createFakePluginHost({
    pluginId: "solo-factor",
    agentSkillIds: ["factory", "factory-orchestrator", "factory-issue-owner", "factory-deploy", "factory-harness-improver", "factory-watch", "factory-cleaner", "factory-integrator", "factory-contacts", "factory-onboarding", "factory-debug", "factory-plan", "factory-review-plan", "factory-build", "factory-review-code", "factory-ship", "factory-tracker", "factory-sequence"],
    sdk: {
      projects: {
        list: async () => [{ id: PROJECT, name: "Acme" }],
        attachments: {
          upload: async (args: { filename: string; mimeType?: string; clientFile: Uint8Array }) => ({
            type: "localImage", path: `/attachments/${args.filename}`, name: args.filename, mimeType: args.mimeType, sizeBytes: args.clientFile.length,
          }),
        },
      },
      system: { config: async () => ({ primaryHostId: "host_local" }) },
      threads: {
        spawn: async (args: Record<string, unknown>) => {
          if (failSpawn) throw new Error("provider unavailable");
          const id = `th_${spawned.length + 1}`;
          const environment = args.environment as Spawned["environment"];
          spawned.push({ ...(args as unknown as Spawned), id });
          // Like bb, a new worktree is not known yet when spawn returns.
          return makeThreadResponse({
            id,
            projectId: PROJECT,
            environmentId: environment.type === "reuse" ? environment.environmentId! : null,
          });
        },
        get: async (args: { threadId: string }) => {
          const thread = spawned.find((candidate) => candidate.id === args.threadId)!;
          return makeThreadResponse({
            id: thread.id,
            projectId: PROJECT,
            environmentId:
              thread.environment.type === "reuse" ? thread.environment.environmentId! : `env_${thread.id}`,
          });
        },
        events: {
          list: async (args: { threadId: string }) =>
            lastTurn.has(args.threadId)
              ? [{ type: "client/turn/requested", createdAt: Date.now(), data: { initiator: lastTurn.get(args.threadId) === "agent" ? "agent" : "user", senderThreadId: null, originPluginId: lastTurn.get(args.threadId) === "plugin" ? "solo-factor" : null } }]
              : [],
        },
        send: async (args: { threadId: string; input: { text: string }[]; senderThreadId?: string }) => {
          lastTurn.set(args.threadId, "agent");
          sent.push({ threadId: args.threadId, text: args.input[0]!.text, senderThreadId: args.senderThreadId, ...(args.input.length > 1 ? { attachments: args.input.slice(1) } : {}) });
          return { ok: true, delivery: "sent" };
        },
        retry: async (args: { threadId: string }) => {
          retried.push(args.threadId);
          return {};
        },
        unpin: async () => ({}),
        archive: async (args: { threadId: string }) => {
          archived.push(args.threadId);
          return {};
        },
        update: async (args: { threadId: string; model?: string; reasoningLevel?: string; title?: string }) => {
          updated.push(args);
          return {};
        },
        interactions: { list: async () => [] },
      },
      environments: {
        // The main checkout, where standing agents run, is not a worktree.
        get: async (args: { environmentId: string }) => ({ id: args.environmentId, name: null, isWorktree: args.environmentId !== "env_main" }),
        archiveThreads: async (args: { environmentId: string }) => {
          archivedWorkspaces.push(args.environmentId);
          return {};
        },
        update: async (args: { environmentId: string; name: string }) => {
          renamed.push(args);
          return {};
        },
      },
      plugins: { callRpc: async () => ({ ok: true, channels: [] }) },
    } as never,
  });
  const { harness } = host;
  const rpc = <T>(method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<T>;
  const state = () => rpc<FactoryState>("state", { projectId: PROJECT });
  const enqueue = (key: string, lane: string, pipeline = "full") =>
    rpc("enqueue", { projectId: PROJECT, key, title: `Title of ${key}`, brief: "", lane, pipeline });
  const tool = async (name: string, threadId: string, input: unknown) => {
    const result = await harness.behavior.callAgentTool(name, input, { threadId, projectId: PROJECT });
    return typeof result === "string" ? result : JSON.stringify(result);
  };
  /**
   * The founder typing in a thread themselves, as bb reports it: a turn they
   * started shows in the thread's log; a message that queued behind a running
   * turn raises an event when it is dispatched.
   */
  const founderTypes = (threadId: string, queued = false) => {
    if (!queued) lastTurn.set(threadId, "user");
    return harness.behavior
      .emitThreadEvent((queued ? "message.dispatched" : "thread.active") as never, (queued ? { entry: { threadId, initiator: "user", senderThreadId: null, originPluginId: null } } : { thread: makeThreadResponse({ id: threadId, projectId: PROJECT }) }) as never)
      .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const emit = (event: "thread.idle" | "thread.active" | "thread.failed" | "thread.archived", threadId: string, extra = {}) =>
    harness.behavior
      .emitThreadEvent(event, { thread: makeThreadResponse({ id: threadId, projectId: PROJECT }), ...extra } as never)
      // Handlers are fire-and-forget; let the engine's queue drain.
      .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const item = async (key: string) => (await state()).items.find((candidate) => candidate.key === key)!;
  return {
    host,
    harness,
    spawned,
    sent,
    retried,
    archived,
    archivedWorkspaces,
    renamed,
    updated,
    rpc,
    state,
    enqueue,
    tool,
    emit,
    founderTypes,
    pluginTurn: (threadId: string) => lastTurn.set(threadId, "plugin"),
    item,
    breakSpawn: (broken: boolean) => (failSpawn = broken),
  };
}

let t: ReturnType<typeof setup>;
beforeEach(async () => {
  t = setup();
  await plugin(t.host.bb);
});
afterEach(async () => {
  await t.harness.lifecycle.dispose();
});

describe("swimlanes", () => {
  it("works one ticket per lane, in order, and starts other lanes in parallel", async () => {
    await t.enqueue("APP-1", "Checkout");
    await t.enqueue("APP-2", "Checkout");
    await t.enqueue("APP-3", "Plan");

    expect((await t.item("APP-1")).status).toBe("running");
    expect((await t.item("APP-2")).status).toBe("queued");
    expect((await t.item("APP-3")).status).toBe("running");
    // A thread is titled with its role; the ticket is the workspace's name.
    expect(t.spawned.map((thread) => thread.title)).toEqual(["Plan", "Plan"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.renamed).toEqual([{ environmentId: "env_th_1", name: "APP-1" }, { environmentId: "env_th_2", name: "APP-3" }]);
  });

  it("gives each ticket its own new worktree", async () => {
    await t.enqueue("APP-1", "Checkout");
    expect(t.spawned[0]!.environment).toEqual({
      type: "host",
      hostId: "host_local",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("runs one ticket per lane with no overall limit on lanes", async () => {
    for (const lane of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]) {
      await t.enqueue(`APP-${lane}1`, lane, "small-bug");
      await t.enqueue(`APP-${lane}2`, lane, "small-bug");
    }
    const items = (await t.state()).items;
    expect(items.filter((item) => item.status === "running")).toHaveLength(10);
    expect(items.filter((item) => item.status === "queued")).toHaveLength(10);
  });

  it("lets the founder drag a waiting ticket to a new place in its lane", async () => {
    for (const key of ["APP-1", "APP-2", "APP-3", "APP-4"]) await t.enqueue(key, "Checkout", "small-bug");
    const order = async () => (await t.state()).items.filter((item) => item.lane === "Checkout").map((item) => item.key);
    const id = async (key: string) => (await t.item(key)).id;
    await t.rpc("reorderBefore", { itemId: await id("APP-4"), beforeId: await id("APP-2") });
    expect(await order()).toEqual(["APP-1", "APP-4", "APP-2", "APP-3"]);
    await t.rpc("reorderBefore", { itemId: await id("APP-4"), beforeId: null });
    expect(await order()).toEqual(["APP-1", "APP-2", "APP-3", "APP-4"]);
    await expect(t.rpc("reorderBefore", { itemId: await id("APP-1"), beforeId: null })).rejects.toThrow(/cannot be reordered/);
  });

  it("marks a ticket as working while its thread is in a turn", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    expect((await t.item("APP-1")).working).toBe(true);
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Paused." });
    expect((await t.item("APP-1")).working).toBe(false);
    await t.emit("thread.active", "th_1");
    expect((await t.item("APP-1")).working).toBe(true);
  });

  it("lets the founder reorder the tickets waiting in a lane, and never the one in flight", async () => {
    for (const key of ["APP-1", "APP-2", "APP-3", "APP-4"]) await t.enqueue(key, "Checkout", "small-bug");
    const order = async () =>
      (await t.state()).items.filter((item) => item.lane === "Checkout").map((item) => item.key);
    const reorder = async (key: string, direction: "up" | "down") =>
      t.rpc("reorder", { itemId: (await t.item(key)).id, direction });

    await reorder("APP-4", "up");
    expect(await order()).toEqual(["APP-1", "APP-2", "APP-4", "APP-3"]);
    await reorder("APP-4", "up");
    expect(await order()).toEqual(["APP-1", "APP-4", "APP-2", "APP-3"]);
    // Already first among the waiting tickets: nothing moves, and it cannot pass the one in flight.
    await reorder("APP-4", "up");
    expect(await order()).toEqual(["APP-1", "APP-4", "APP-2", "APP-3"]);
    await expect(reorder("APP-1", "down")).rejects.toThrow(/has started/);

    // The new order is what runs next, and a schedule sync does not undo it.
    await t.harness.behavior.runCli(["sync", JSON.stringify({ lanes: [{ name: "Checkout", items: ["APP-2", "APP-3", "APP-4"].map((key) => ({ key, title: key, pipeline: "small-bug" })) }] })], { projectId: PROJECT });
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Fixed." });
    expect((await t.item("APP-4")).status).toBe("running");
    expect(await order()).toEqual(["APP-1", "APP-4", "APP-2", "APP-3"]);
  });

  it("starts the next ticket in a lane when the one ahead of it is cancelled", async () => {
    await t.enqueue("APP-1", "Checkout");
    await t.enqueue("APP-2", "Checkout");
    await t.rpc("cancel", { itemId: (await t.item("APP-1")).id });
    expect((await t.item("APP-2")).status).toBe("running");
  });

  it("refuses a ticket that is already in the factory", async () => {
    await t.enqueue("APP-1", "Checkout");
    await expect(t.enqueue("app-1", "Other")).rejects.toThrow(/already in the factory/);
  });
});

describe("pipeline handoffs", () => {
  it("runs each stage in a fresh thread, in the same worktree, on that role's model", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          "plan-review": { ...config.roles["plan-review"], providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
          build: { ...config.roles.build, providerId: "codex", model: "gpt-terra" },
        },
      },
    });
    await t.enqueue("APP-1", "Checkout");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Plan is at Plans/APP-1.md." });

    const review = t.spawned[1]!;
    expect(review.title).toBe("Issue owner");
    expect(review.environment).toEqual({ type: "reuse", environmentId: "env_th_1" });
    expect(review).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(review.prompt).toContain("Use the `factory-review-plan` skill");
    expect(review.prompt).toContain("Plan is at Plans/APP-1.md.");
    expect(review.prompt).toContain("factory_stage_done");

    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Plan reviewed; two corrections landed." });
    expect(t.spawned[2]).toMatchObject({ title: "Execution", providerId: "codex", model: "gpt-terra" });
    // Unset role fields are left to the project default rather than sent empty.
    expect(t.spawned[0]).not.toHaveProperty("providerId");
  });

  it("finishes the ticket after the last stage and frees its lane", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.enqueue("APP-2", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Review complete." });
    const final = await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Merged." });

    expect(final).toContain("APP-1 is done");
    expect((await t.item("APP-1")).status).toBe("done");
    expect((await t.item("APP-2")).status).toBe("running");
  });

  it("sends review findings to the author's thread, then moves past the review once fixed", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "changes_requested", change_note: NOTE, summary: "Scope question: should rest days count?" });

    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("should rest days count?");
    expect((await t.item("APP-1")).stageIndex).toBe(0);
    expect(t.spawned).toHaveLength(2);

    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Findings folded in." });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
  });

  it("runs the review again, in a new thread, only when the author asks for it", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "changes_requested", change_note: NOTE, summary: "Change X." });
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Changed scope.", rereview: true });

    expect(t.spawned.at(-1)).toMatchObject({ id: "th_3", title: "Code review" });
  });

  it("returns findings to the thread that queued the ticket when the pipeline has no author stage", async () => {
    const orchestrator = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.tool("factory_enqueue", orchestrator.threadId, { key: "APP-1", title: "Rest days", lane: "Checkout", pipeline: "planned" });
    await t.tool("factory_stage_done", "th_2", { outcome: "changes_requested", change_note: NOTE, summary: "Plan misses migration." });

    expect(t.sent.at(-1)!.threadId).toBe(orchestrator.threadId);
    expect(t.sent.at(-1)!.text).toContain("bb factory advance APP-1");
    expect((await t.item("APP-1")).status).toBe("returned");

    const cli = await t.harness.behavior.runCli(["advance", "APP-1"], { projectId: PROJECT, threadId: orchestrator.threadId });
    expect(cli.exitCode).toBe(0);
    expect(t.spawned.at(-1)!.title).toBe("Execution");
  });

  it("rejects a report from a thread whose stage is no longer current", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    const late = await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Again." });
    expect(late).toContain("not the current stage");
    expect(t.spawned).toHaveLength(2);
  });

  it("does not let a non-review stage request changes", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    const result = await t.tool("factory_stage_done", "th_1", { outcome: "changes_requested", change_note: NOTE, summary: "x" });
    expect(result).toContain("not a review stage");
  });
});

describe("a ticket's issue owner fields everything about it", () => {
  // th_1 reviews the plan and so owns APP-1; th_2 builds it.
  const start = async () => {
    await t.enqueue("APP-1", "Checkout", "planned");
    expect(t.spawned[0]!.prompt).toContain("You are the issue owner for APP-1");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Plan reviewed." });
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_2", title: "Execution" });
  };

  it("sends the builder's question to the owner, and resumes on its reply", async () => {
    await start();
    const asked = await t.tool("factory_ask_planner", "th_2", { question: "PLANNER INPUT REQUIRED: the replay contract cannot requalify." });
    expect(asked).toContain("issue owner");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("the replay contract cannot requalify");
    expect(t.sent.at(-1)!.text).toContain('to: "APP-1:build"');
    expect((await t.item("APP-1")).status).toBe("with-owner");
    expect((await t.state()).inbox).toEqual([]);

    // The builder ending its turn while it waits is not a stall.
    await t.emit("thread.idle", "th_2", { lastAssistantText: "Waiting on the owner." });
    expect(t.sent.at(-1)!.threadId).toBe("th_1");

    await t.tool("factory_message", "th_1", { to: "APP-1:build", message: "Requalify against v5.12.0; plan updated." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2", senderThreadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("Message from the issue owner for APP-1");
    expect((await t.item("APP-1")).status).toBe("running");

    // Round two works the same way, and the build then finishes normally.
    await t.tool("factory_ask_planner", "th_2", { question: "One more: which fixture?" });
    await t.tool("factory_message", "th_1", { to: "APP-1", message: "The hand-log one." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Built." });
    expect(t.spawned.at(-1)!.title).toBe("Code review");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("keeps every other thread on the ticket out of the founder's inbox: a builder's question or blocker goes to the owner", async () => {
    await start();
    const reply = await t.tool("factory_ask_founder", "th_2", { kind: "decision", question: "May I raise the QA call budget from 10 to 20?", context: "The replay needs 20 calls." });
    expect(reply).toContain("issue owner");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("raise the QA call budget");
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("with-owner");
    // The owner settles it without the founder.
    await t.tool("factory_message", "th_1", { to: "APP-1:build", message: "Yes, 20 calls. Record it in the plan." });
    expect((await t.item("APP-1")).status).toBe("running");

    await t.tool("factory_stage_done", "th_2", { outcome: "blocked", summary: "Dev database is down." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("Dev database is down.");
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("with-owner");
  });

  it("lets the owner ask the founder, and after their answer the ticket waits on the owner to pass it on", async () => {
    await start();
    await t.tool("factory_ask_founder", "th_2", { kind: "decision", question: "Rest day or missed?", context: "long agent text" });
    await t.tool("factory_ask_founder", "th_1", {
      kind: "decision",
      question: "Should a skipped run count as a rest day?",
      context: "Sam skipped Tuesday; today the app counts it as rest.",
      options: ["Count it as rest", "Count it as missed"],
      recommendation: "Count it as missed.",
    });
    const before = await t.state();
    expect(before.inbox).toHaveLength(1);
    expect(before.inbox[0]).toMatchObject({ kind: "question", from: "Issue owner · APP-1", threadId: "th_1", question: "Should a skipped run count as a rest day?" });
    expect((await t.item("APP-1")).status).toBe("needs-founder");

    await t.rpc("answer", { entryId: before.inbox[0]!.id, answer: "Count it as missed." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain('The founder was asked: "Should a skipped run count as a rest day?"');
    expect(t.sent.at(-1)!.text).toContain("Sam skipped Tuesday; today the app counts it as rest.");
    expect(t.sent.at(-1)!.text).toContain("Count it as missed.");
    expect((await t.state()).inbox).toHaveLength(0);
    // The builder is still waiting, so this is not "running" with nobody on it.
    expect((await t.item("APP-1")).status).toBe("with-owner");
    await t.tool("factory_message", "th_1", { to: "APP-1:build", message: "Count it as missed." });
    expect((await t.item("APP-1")).status).toBe("running");
  });

  it("routes an inbox answer to the asking thread with its context, and an answer the founder sent themselves is not sent again", async () => {
    await start();
    await t.tool("factory_ask_founder", "th_1", {
      kind: "decision",
      question: "Should a skipped run count as a rest day?",
      context: "Sam skipped Tuesday; today the app counts it as rest.",
    });
    const entry = (await t.state()).inbox[0]!;
    const route = await t.rpc("answerRoute", { entryId: entry.id });
    expect(route).toMatchObject({ threadId: "th_1", mentionId: entry.id });
    const sentBefore = t.sent.length;
    await t.rpc("answer", { entryId: entry.id, answer: "Count it as missed.", delivered: true });
    expect(t.sent.length).toBe(sentBefore);
    expect((await t.state()).inbox).toHaveLength(0);
    expect((await t.item("APP-1")).status).not.toBe("needs-founder");
  });

  it("accepts an answer the founder sent from the composer after the thread already counted it as their reply", async () => {
    await start();
    await t.tool("factory_ask_founder", "th_1", { kind: "decision", question: "Rest day or missed?" });
    const entry = (await t.state()).inbox[0]!;
    await t.founderTypes("th_1");
    expect((await t.state()).inbox).toHaveLength(0);
    const sentBefore = t.sent.length;
    const saved = await t.rpc("answer", { entryId: entry.id, answer: "Count it as missed.", delivered: true });
    expect(saved).toMatchObject({ status: "answered", answer: "Count it as missed." });
    expect(t.sent.length).toBe(sentBefore);
  });

  it("accepts an inbox answer whose own pill already closed the entry when it reached the thread", async () => {
    await start();
    await t.tool("factory_ask_founder", "th_1", { kind: "todo", question: "Install Tailscale on Friday." });
    const entry = (await t.state()).inbox[0]!;
    const hook = t.harness.registrations.hooks["message.dispatch"]!;
    await hook(makeMessageDispatchHookContext({
      thread: { id: "th_1", projectId: PROJECT },
      initiator: "user", senderThreadId: null, originPluginId: null,
      input: { text: "Done.", blocks: [{ type: "text", text: "Done.", mentions: [{ start: 0, end: 0, resource: { kind: "plugin", pluginId: "solo-factor", itemId: entry.id, label: "Inbox answer" } }] } as never] },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await t.state()).inbox).toHaveLength(0);
    const saved = await t.rpc("answer", { entryId: entry.id, answer: "Done.", delivered: true });
    expect(saved).toMatchObject({ status: "answered", answer: "Done." });
  });

  it("reminds an owner that goes quiet, then tells the founder", async () => {
    await start();
    await t.tool("factory_ask_planner", "th_2", { question: "Blocked on X." });
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Thinking." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("still waiting on you");
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Still thinking." });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "stalled", from: "Issue owner · APP-1" });
  });

  it("starts an owner for a ticket whose plan was reviewed elsewhere, the first time one is needed", async () => {
    await t.enqueue("APP-9", "Checkout", "reviewed");
    expect(t.spawned).toHaveLength(1);
    await t.tool("factory_ask_planner", "th_1", { question: "Blocked." });
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_2", title: "Issue owner", environment: { type: "reuse", environmentId: "env_th_1" } });
    expect(t.spawned.at(-1)!.prompt).toContain("Its plan was reviewed before it reached the factory");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2", senderThreadId: "th_1" });
    // The same owner is used from then on.
    await t.tool("factory_message", "th_2", { to: "APP-9:build", message: "Do X." });
    await t.tool("factory_ask_founder", "th_1", { kind: "decision", question: "And Y?" });
    expect(t.spawned).toHaveLength(2);
    expect(t.sent.at(-1)!.threadId).toBe("th_2");
  });

  it("keeps the owner's ticket note and sends it back with everything handed to the owner", async () => {
    await start();
    expect(await t.tool("factory_ticket_note", "th_2", { note: "Mine." })).toContain("Only a ticket's issue owner");
    await t.tool("factory_ticket_note", "th_1", { note: "Founder wants missed, not rest. Open: copy for the banner." });
    await t.tool("factory_ask_planner", "th_2", { question: "Which copy?" });
    expect(t.sent.at(-1)!.text).toContain("Your ticket note for APP-1:\nFounder wants missed, not rest. Open: copy for the banner.");
  });

  it("clears an inbox entry when the founder answers in the thread instead", async () => {
    await start();
    await t.tool("factory_ask_planner", "th_2", { question: "Which copy?" });
    await t.tool("factory_ask_founder", "th_1", { kind: "decision", question: "Banner copy A or B?" });
    expect((await t.state()).inbox).toHaveLength(1);
    await t.founderTypes("th_2");
    expect((await t.state()).inbox).toHaveLength(1);
    // A turn an agent's message started is not their answer, and neither is one
    // a plugin started, which bb records as the user's.
    await t.emit("thread.active", "th_1");
    expect((await t.state()).inbox).toHaveLength(1);
    t.pluginTurn("th_1");
    await t.emit("thread.active", "th_1");
    expect((await t.state()).inbox).toHaveLength(1);
    await t.founderTypes("th_1");
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("with-owner");

    // The same when their message had to wait behind a running turn.
    await t.tool("factory_ask_founder", "th_1", { kind: "decision", question: "And the colour?" });
    await t.founderTypes("th_1", true);
    expect((await t.state()).inbox).toEqual([]);
  });

  it("keeps a standing agent's questions open when they write about something else, closes one they replie to, and lets the agent close its own", async () => {
    await t.harness.behavior.runCli(["prompt", "orchestrator", "Morning."], { projectId: PROJECT });
    const agent = t.spawned.at(-1)!.id;
    const ask = (question: string) => t.tool("factory_ask_founder", agent, { kind: "decision", question, options: ["A", "B"] });
    expect(await ask("Ship A or B?")).toMatch(/Asked \(inb_/);
    await ask("Which lane for APP-9?");
    const [first, second] = (await t.state()).inbox;
    const hook = t.harness.registrations.hooks["message.dispatch"]!;
    const send = (text: string, mentions: unknown[] = []) =>
      Promise.resolve(hook(makeMessageDispatchHookContext({
        thread: { id: agent, projectId: PROJECT },
        initiator: "user", senderThreadId: null, originPluginId: null,
        input: { text, blocks: [{ type: "text", text, mentions } as never] },
      }))).then(() => new Promise((resolve) => setTimeout(resolve, 30)));
    // About something else: both stay open.
    await send("Also, can you look at the Observer's report?");
    expect((await t.state()).inbox).toHaveLength(2);
    // A Reply from the banner carries one question's pill: that one closes.
    await send("B.", [{ start: 0, end: 0, resource: { kind: "plugin", pluginId: "solo-factor", itemId: first!.id, label: "Reply" } }]);
    expect((await t.state()).inbox.map((entry) => entry.id)).toEqual([second!.id]);
    // The agent closes the other once it is settled in conversation.
    expect(await t.tool("factory_close_ask", agent, { entry_id: second!.id })).toContain("Closed");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("clears it when their reply joins a turn already running, and never delays or blocks their send", async () => {
    await start();
    await t.tool("factory_ask_founder", "th_1", { kind: "todo", question: "Open the thread and answer there." });
    expect((await t.state()).inbox).toHaveLength(1);
    const hook = t.harness.registrations.hooks["message.dispatch"]!;
    const dispatch = (overrides: Parameters<typeof makeMessageDispatchHookContext>[0]) =>
      Promise.resolve(hook(makeMessageDispatchHookContext({ thread: { id: "th_1", projectId: PROJECT }, attempt: "join-turn", ...overrides })));
    // An agent's message, or one a plugin sent, is not their answer; both proceed.
    expect(await dispatch({ initiator: "agent", senderThreadId: "th_9", originPluginId: null })).toEqual({ action: "proceed" });
    expect(await dispatch({ initiator: "user", senderThreadId: null, originPluginId: "solo-factor" })).toEqual({ action: "proceed" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await t.state()).inbox).toHaveLength(1);
    // Their own message, steered into the running turn.
    expect(await dispatch({ initiator: "user", senderThreadId: null, originPluginId: null })).toEqual({ action: "proceed" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await t.state()).inbox).toEqual([]);
  });

  it("briefs an owner whose thread predates owners, the first time the founder writes to it", async () => {
    await start();
    // As saved by a version before owners: the thread was never told what it is.
    t.host.bb.storage.database().prepare(`UPDATE items SET data = json_remove(data, '$.ownerBriefed')`).run();
    await t.founderTypes("th_1");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("this thread is the issue owner for APP-1");
    expect(t.sent.at(-1)!.text).toContain("factory_follow_up");
    // Once is enough.
    const count = t.sent.length;
    await t.founderTypes("th_1");
    expect(t.sent).toHaveLength(count);
  });

  it("retitles threads and workspaces named the old way", async () => {
    await start();
    const report = await t.harness.behavior.runCli(["retitle"], { projectId: PROJECT });
    expect(JSON.stringify(report)).toContain("APP-1: 2 threads");
    expect(t.updated).toEqual(expect.arrayContaining([{ threadId: "th_1", title: "Issue owner" }, { threadId: "th_2", title: "Execution" }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.renamed.at(-1)).toEqual({ environmentId: "env_th_1", name: "APP-1" });
  });

  it("lets any other thread in a project with a factory reach the standing agents, and threads elsewhere get nothing", async () => {
    const side = () => t.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: {}, project: { id: PROJECT, kind: "standard", name: "Acme", gitRemoteUrl: null } } as never),
    );
    expect(((await side())?.tools ?? []).length).toBe(0);
    const { config } = await t.state();
    await t.rpc("saveConfig", { projectId: PROJECT, config });
    const tools = ((await side())?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["factory_message", "factory_status"]));
  });

  it("offers the tools and the owner's charter to every stage thread", async () => {
    const config = await t.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { binding: { kind: "stage", itemId: "itm_1", stage: "build" } } } as never),
    );
    const tools = (config?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(tools).toContain("factory_ask_planner");
    expect(tools).toContain("factory_ticket_note");
  });
});

describe("small bugs ride with a planned ticket", () => {
  it("attaches a small bug to the next planned ticket in its lane, and tells every stage about it", async () => {
    await t.enqueue("APP-1", "Checkout", "planned");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Plan reviewed." });
    await t.enqueue("APP-2", "Checkout", "planned");
    // APP-1 is already being built, so the bug rides with APP-2, which has not started.
    const queued = await t.tool("factory_enqueue", "th_1", { key: "APP-50", title: "Skip button misaligned", lane: "Checkout", pipeline: "small-bug" });
    expect(queued).toContain("APP-50 rides with APP-2");
    const state = await t.state();
    expect(state.items.map((item) => item.key)).toEqual(["APP-1", "APP-2"]);
    expect((await t.item("APP-2")).riders).toEqual([{ key: "APP-50", title: "Skip button misaligned", brief: "" }]);
    // No workspace or thread of its own.
    expect(t.spawned).toHaveLength(2);
    await expect(t.enqueue("APP-50", "Checkout", "small-bug")).rejects.toThrow(/riding with APP-2/);

    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Reviewed." });
    await t.tool("factory_stage_done", "th_4", { outcome: "complete", change_note: NOTE, summary: "Shipped." });
    // APP-2 starts: its owner and then its builder are both told about the bug.
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_5", title: "Issue owner" });
    expect(t.spawned.at(-1)!.prompt).toContain("- APP-50: Skip button misaligned");
    await t.tool("factory_stage_done", "th_5", { outcome: "complete", change_note: NOTE, summary: "Plan reviewed." });
    expect(t.spawned.at(-1)!.title).toBe("Execution");
    expect(t.spawned.at(-1)!.prompt).toContain("Small bugs ride with this ticket");
    expect(t.spawned.at(-1)!.prompt).toContain("- APP-50: Skip button misaligned");
  });

  it("tells an owner already at work when a small bug joins its ticket", async () => {
    await t.enqueue("APP-1", "Checkout", "planned");
    await t.enqueue("APP-51", "", "small-bug");
    expect((await t.item("APP-1")).riders.map((rider) => rider.key)).toEqual(["APP-51"]);
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("A small bug now rides with APP-1: APP-51");
  });

  it("runs a small bug on its own only when no planned ticket is coming up, and moves it if its ticket is cancelled", async () => {
    await t.enqueue("APP-60", "Checkout", "small-bug");
    expect(t.spawned.at(-1)).toMatchObject({ title: "Fix" });

    await t.enqueue("APP-1", "Other", "planned");
    await t.enqueue("APP-2", "Other", "planned");
    await t.enqueue("APP-61", "Other", "small-bug");
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Plan reviewed." });
    await t.enqueue("APP-62", "Other", "small-bug");
    expect((await t.item("APP-2")).riders.map((rider) => rider.key)).toEqual(["APP-62"]);
    await t.rpc("cancel", { itemId: (await t.item("APP-2")).id });
    // Nothing planned is left to ride with in that lane, so it queues alone.
    expect((await t.item("APP-62")).pipeline).toBe("small-bug");
    expect((await t.item("APP-1")).riders.map((rider) => rider.key)).toEqual(["APP-61"]);
  });
});

describe("founder inbox", () => {
  it("signals open windows to chime when something lands in the inbox", async () => {
    const arrivals = () => t.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "factory-inbox-arrived").length;
    const planner = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    expect(arrivals()).toBe(0);
    await t.tool("factory_ask_founder", planner.threadId, { kind: "decision", question: "Create a ticket?" });
    expect(arrivals()).toBe(1);
  });

  it("keeps the issue owner's question to the founder open when a stage reports, and closes it only when the ticket ends", async () => {
    await t.enqueue("APP-1", "Checkout", "planned");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Plan reviewed." });
    // th_1 now owns APP-1 and asks the founder, as APP-991's owner did.
    await t.tool("factory_ask_founder", "th_1", { kind: "decision", question: "Fix the repeats first or ship now?", options: ["Fix first", "Ship now"] });
    const asked = (await t.state()).inbox.find((entry) => entry.question.startsWith("Fix the repeats"))!;
    expect(asked).toBeDefined();
    // The builder reports; that is not their answer.
    await t.tool("factory_stage_done", "th_2", { outcome: "blocked", change_note: NOTE, summary: "Waiting on the founder." });
    expect((await t.state()).inbox.some((entry) => entry.id === asked.id)).toBe(true);
    await t.harness.behavior.runCli(["cancel", "APP-1"], { projectId: PROJECT });
    expect((await t.state()).inbox.some((entry) => entry.id === asked.id)).toBe(false);
  });

  it("refuses a test account email too long to type on a phone", async () => {
    await t.enqueue("APP-1", "Checkout", "small-bug");
    await expect(t.tool("factory_ask_founder", "th_1", { kind: "test", question: "Try it", account: "qa-app406-phone-7f8d63e2@example.test / pw", steps: ["Open it."] })).rejects.toThrow(/at most 20 characters/);
  });

  it("files a request to try something already shipped as a test, not a decision", async () => {
    await t.enqueue("APP-1", "Checkout", "small-bug");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Fixed and merged." });
    await t.tool("factory_ask_founder", "th_1", { kind: "test", question: "Try the skip button", context: "Skip now works for upcoming sessions.", account: "1006@t.qa / pw", steps: ["Open Park Loop.", "Tap Skip."], options: ["ignored"] });
    const entry = (await t.state()).inbox[0]!;
    expect(entry).toMatchObject({ kind: "test", threadId: "th_1" });
    // A test carries an account and steps, never options.
    expect(entry.context).toBe("Skip now works for upcoming sessions.\n\nTest account: 1006@t.qa / pw\n\n**Steps**\n- Open Park Loop.\n- Tap Skip.");
    expect(entry.options).toEqual([]);
    // Their notes still go to the thread that built it.
    await t.rpc("answer", { entryId: entry.id, answer: "Undo is missing." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });

    // Something they simply has to do is a to-do, including when the chief of staff files it.
    await t.tool("factory_ask_founder", "th_1", { kind: "todo", question: "Record the menu transition on your phone", steps: ["Open the menu."], options: ["Done", "Not now"], recommendation: "Do it." });
    expect((await t.state()).inbox.map((item) => item.kind)).toContain("todo");
    // "Do it" and "not now" are not options: a to-do never shows a choice.
    expect((await t.state()).inbox.find((item) => item.kind === "todo")).toMatchObject({ options: [], recommendation: "" });

    // An entry filed under the wrong kind can be corrected.
    await t.tool("factory_ask_founder", "th_1", { kind: "decision", question: "Try it again" });
    const find = async () => (await t.state()).inbox.find((item) => item.question === "Try it again")!;
    expect((await find()).kind).toBe("question");
    await t.harness.behavior.runCli(["retag", (await find()).id, "test"], { projectId: PROJECT });
    expect((await find()).kind).toBe("test");
  });

  it("sends the files the founder attached to an answer along with it, and lets a file be the whole answer", async () => {
    const planner = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.tool("factory_ask_founder", planner.threadId, { kind: "todo", question: "Record the menu on your phone" });
    const entry = (await t.state()).inbox[0]!;
    const video = { type: "localFile", path: "uploads/menu.mov", name: "menu.mov", mimeType: "video/quicktime", sizeBytes: 1200 };
    await t.rpc("answer", { entryId: entry.id, answer: "", attachments: [video] });
    expect(t.sent.at(-1)).toMatchObject({ threadId: entry.threadId, attachments: [video] });
    expect(t.sent.at(-1)!.text).toContain("See the attached.");
    expect((await t.state()).inbox).toEqual([]);

    // With neither words nor a file there is nothing to send.
    await t.tool("factory_ask_founder", planner.threadId, { kind: "todo", question: "Record it again" });
    const again = (await t.state()).inbox[0]!;
    await expect(t.rpc("answer", { entryId: again.id, answer: "  " })).rejects.toThrow();
  });

  it("lets a standing agent ask the founder directly", async () => {
    const planner = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.tool("factory_ask_founder", planner.threadId, { kind: "decision", question: "Create a ticket for the new error class?" });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "question", from: "Architect" });
  });

  it("does not remind a thread that is waiting on its own background work", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    const waiting = (extra: object) =>
      t.harness.behavior
        .emitThreadEvent("thread.idle", { thread: { ...makeThreadResponse({ id: "th_1", projectId: PROJECT }), ...extra }, lastAssistantText: "Local CI is still running." } as never)
        .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await waiting({ activeBackgroundCommandCount: 1 });
    await waiting({ activeBackgroundAgentCount: 1 });
    expect(t.sent).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("running");
    // With nothing running in the background, the usual reminder applies.
    await waiting({});
    expect(t.sent).toHaveLength(1);
  });

  it("nudges a thread that stops without reporting, then escalates the second time", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.emit("thread.idle", "th_1", { lastAssistantText: "All done!" });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain("factory_stage_done");
    expect((await t.state()).inbox).toHaveLength(0);

    await t.emit("thread.idle", "th_1", { lastAssistantText: "Really done." });
    const { inbox } = await t.state();
    expect(inbox[0]).toMatchObject({ kind: "stalled", context: "Really done." });
    expect((await t.item("APP-1")).status).toBe("stalled");

    // Typing in the thread by hand clears the stall.
    await t.emit("thread.active", "th_1");
    expect((await t.item("APP-1")).status).toBe("running");
    expect((await t.state()).inbox).toHaveLength(0);
  });

  it("clears a stall notice when a stalled agent then asks for a decision", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Hm." });
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Hm." });
    expect((await t.item("APP-1")).status).toBe("stalled");

    await t.tool("factory_ask_founder", "th_1", { kind: "decision", question: "Which unit?" });
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("with-owner");
  });

  it("puts a failed turn in the inbox and retries it on request", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.emit("thread.failed", "th_1", { error: "rate limited" });
    const { inbox } = await t.state();
    expect(inbox[0]).toMatchObject({ kind: "failed", context: "rate limited" });

    await t.rpc("retry", { entryId: inbox[0]!.id });
    expect(t.retried).toEqual(["th_1"]);
    expect((await t.item("APP-1")).status).toBe("running");
  });

  it("reports a stage that could not start, and starts it again on retry", async () => {
    t.breakSpawn(true);
    await t.enqueue("APP-1", "Checkout", "reviewed");
    const { inbox } = await t.state();
    expect(inbox[0]!.context).toContain("provider unavailable");

    t.breakSpawn(false);
    await t.rpc("retry", { entryId: inbox[0]!.id });
    expect(t.spawned[0]!.title).toBe("Execution");
    expect((await t.item("APP-1")).status).toBe("running");
  });

  it("flags a stage thread that was archived out from under its ticket", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.emit("thread.archived", "th_1");
    expect((await t.state()).inbox[0]!.kind).toBe("failed");
  });
});

describe("standing agents and messaging", () => {
  it("starts an agent once, unpinned, in the main checkout, on its role's model", async () => {
    const first = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    const second = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });

    expect(second.threadId).toBe(first.threadId);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]).toMatchObject({
      pinned: false,
      environment: { type: "host", hostId: "host_local", workspace: { type: "unmanaged", path: null } },
    });
    expect(t.spawned[0]!.prompt).toContain("factory-orchestrator");
    expect(t.spawned[0]!.prompt).toContain("docs/agents/orchestrator/MEMORY.md");
  });

  it("rotates an agent: the old thread writes its memory, then a fresh thread takes over", async () => {
    const first = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.rpc("rotateAgent", { projectId: PROJECT, agentId: "orchestrator" });
    expect(t.sent.at(-1)!.text).toContain("docs/agents/orchestrator/MEMORY.md");
    expect(t.spawned).toHaveLength(1);

    await t.emit("thread.idle", first.threadId, { lastAssistantText: "Memory updated." });
    expect(t.spawned).toHaveLength(2);
    const agent = (await t.state()).agents.find((state) => state.agentId === "orchestrator")!;
    expect(agent).toMatchObject({ threadId: "th_2", rotating: false });
  });

  it("lets a scheduled prompt start a standing agent and reuse its thread afterwards", async () => {
    const first = await t.harness.behavior.runCli(["prompt", "watch", "Daily", "check."], { projectId: PROJECT });
    expect(first.exitCode).toBe(0);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.prompt).toContain("factory-watch");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", text: "Daily check." });

    await t.harness.behavior.runCli(["prompt", "watch", "Again."], { projectId: PROJECT });
    expect(t.spawned).toHaveLength(1);
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", text: "Again." });
  });

  it("adds the Cleaner to a saved configuration that predates it, beside the other agents' memory files", async () => {
    const { config } = await t.state();
    const { cleaner: _agent, integrator: _integrator, ...agents } = config.agents;
    const { cleaner: _role, integrator: _integratorRole, ...roles } = config.roles;
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: { ...config, roles, agents: { ...agents, orchestrator: { ...agents.orchestrator!, memoryPath: "/vault/Factory agents/Orchestrator memory.md" } } },
    });
    const upgraded = (await t.state()).config;
    expect(upgraded.agents.cleaner).toMatchObject({ label: "Cleaner", role: "cleaner", skill: "factory-cleaner", memoryPath: "/vault/Factory agents/Cleaner memory.md" });
    expect(upgraded.roles.cleaner).toMatchObject({ label: "Cleaner" });

    expect(upgraded.agents.integrator).toMatchObject({ label: "Integrator", role: "integrator", skill: "factory-integrator", memoryPath: "/vault/Factory agents/Integrator memory.md" });
    const started = await t.harness.behavior.runCli(["prompt", "cleaner", "Computer", "cleanup."], { projectId: PROJECT });
    expect(started.exitCode).toBe(0);
    expect(t.spawned.at(-1)!.prompt).toContain("factory-cleaner");
    expect(t.spawned.at(-1)!.prompt).toContain("Cleaner memory.md");
    // Standing agents share the main checkout: they make changes in their own worktree.
    expect(t.spawned.at(-1)!.prompt).toContain("Never switch its branch");
    expect(t.spawned.at(-1)!.prompt).toContain("never with your own interactive question");
  });

  it("lets an outside service wake a standing agent through the inbound hook", async () => {
    const response = await t.harness.behavior.fetchHttp("POST", "/prompt", {
      body: JSON.stringify({ projectId: PROJECT, agent: "watch", text: "New feedback row 123" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("New feedback row 123");
    expect(t.sent.at(-1)!.text).toContain("not from the founder");

    const unknown = await t.harness.behavior.fetchHttp("POST", "/prompt", {
      body: JSON.stringify({ projectId: PROJECT, agent: "nobody", text: "x" }),
      headers: { "content-type": "application/json" },
    });
    expect(unknown.status).toBe(400);

    const malformed = await t.harness.behavior.fetchHttp("POST", "/prompt", {
      body: JSON.stringify({ agent: "watch" }),
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
  });

  it("starts the Architect when the Observer hands it findings before it was ever started", async () => {
    await t.harness.behavior.runCli(["prompt", "watch", "Daily check."], { projectId: PROJECT });
    const result = await t.tool("factory_message", "th_1", { to: "orchestrator", message: "Two new error classes." });
    expect(result).toContain("Delivered to Architect");
    expect(t.spawned.map((thread) => thread.title)).toEqual(["Observer", "Architect"]);
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2", senderThreadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("Message from Observer");
  });

  it("offers a deployer as a standing agent with its own model and charter", async () => {
    const { config } = await t.state();
    expect(config.agents.deploy).toMatchObject({ label: "Deployer", role: "deploy", skill: "factory-deploy" });
    await t.rpc("saveConfig", { projectId: PROJECT, config: { ...config, roles: { ...config.roles, deploy: { ...config.roles.deploy, providerId: "codex", model: "gpt-luna" } } } });
    await t.rpc("startAgent", { projectId: PROJECT, agentId: "deploy" });
    expect(t.spawned.at(-1)).toMatchObject({ title: "Deployer", providerId: "codex", model: "gpt-luna", pinned: false });
    expect(t.spawned.at(-1)!.prompt).toContain("factory-deploy");
  });

  it("delivers messages between a worker and the orchestrator", async () => {
    const orchestrator = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_message", "th_2", { to: "orchestrator", message: "Plan and code disagree on units." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: orchestrator.threadId, senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("Message from Execution for APP-1");

    await t.tool("factory_message", orchestrator.threadId, { to: "APP-1", message: "Use miles." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2" });
  });

  it("lets a side thread talk with a standing agent, and the agent answer it", async () => {
    await t.harness.behavior.runCli(["prompt", "orchestrator", "Morning."], { projectId: PROJECT });
    const architect = t.spawned.at(-1)!.id;
    await t.tool("factory_message", "thr_side1", { to: "orchestrator", message: "The founder wants your view on this proposal." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: architect });
    expect(t.sent.at(-1)!.text).toContain('reply with factory_message to "thr_side1"');
    await t.tool("factory_message", architect, { to: "thr_side1", message: "Agreed on the first two; not the third." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "thr_side1", senderThreadId: architect });
    expect(t.sent.at(-1)!.text).toContain("Message from Architect");
  });

  it("gives factory tools only to factory threads", async () => {
    const configure = (pluginMetadata: Record<string, unknown>) =>
      t.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata } as never));

    const names = (tools: readonly { name: string }[] | undefined) => (tools ?? []).map((tool) => tool.name);

    const outsider = await configure({});
    expect(names(outsider?.tools)).toEqual([]);

    const worker = await configure({ binding: { kind: "stage", itemId: "itm_1", stage: "build" } });
    expect(names(worker?.tools)).toEqual(["factory_stage_done", "factory_ask_founder", "factory_ask_planner", "factory_check_images", "factory_ticket_note", "factory_follow_up", "factory_message"]);
    expect(JSON.stringify(worker?.skills)).toContain("factory-issue-owner");

    const orchestrator = await configure({ binding: { kind: "agent", agentId: "orchestrator", projectId: PROJECT } });
    expect(names(orchestrator?.tools)).toContain("factory_enqueue");
    expect(JSON.stringify(orchestrator?.skills)).toContain("factory-orchestrator");
  });
});

describe("the last review writes what changed", () => {
  it("refuses the last review's report without a change note, records nothing, and keeps the note once given", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    const refused = await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Reviewed." });
    expect(refused).toContain("pass change_note");
    expect(t.spawned).toHaveLength(2);
    expect((await t.item("APP-1")).changeNote).toBeNull();

    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Reviewed.", change_note: { before: " Old copy. ", after: "New copy.", why: "Clearer." } });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
    expect((await t.item("APP-1")).changeNote).toMatchObject({ before: "Old copy.", after: "New copy.", why: "Clearer.", by: "Code review" });
    // Shipping does not need another note.
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", summary: "Merged." });
    expect((await t.item("APP-1")).status).toBe("done");
  });

  it("lets earlier stages report without one, and takes the note from a founder check when one is given", async () => {
    await t.enqueue("APP-1", "Checkout");
    // Plan, then plan review: a later review follows, so no note is needed.
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Planned." });
    expect(await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Plan reviewed." })).not.toContain("change_note");
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", summary: "Built." });
    await t.tool("factory_stage_done", "th_4", {
      outcome: "complete",
      summary: "Reviewed.",
      founder_check: { before: "Sets took two taps.", why: "Too slow mid-session.", now: "One tap checks a set off.", account: "1006@t.qa / pw", steps: ["Open a session"], no_screenshots: "Behaviour only." },
    });
    expect((await t.item("APP-1")).changeNote).toMatchObject({ before: "Sets took two taps.", after: "One tap checks a set off.", why: "Too slow mid-session." });
    // The test account is kept on its own, so a Run script can sign the dev build into it.
    expect((await t.item("APP-1")).founderCheck).toMatchObject({ account: "1006@t.qa / pw" });
  });
});

describe("the founder tries a visible change before it ships", () => {
  const SHOT = join(mkdtempSync(join(tmpdir(), "factory-shots-")), "before-after.png");
  writeFileSync(SHOT, Buffer.from("89504e470d0a1a0a", "hex"));
  const CHECK = {
    before: "Checking off a set took two taps.",
    why: "Users mid-checkout want one tap.",
    now: "One tap checks a set off.",
    account: "1006@t.qa / pw",
    steps: ["Open today's strength session.", "Tap the first set: it shows a check."],
    before_after: SHOT,
  };

  it("carries the before/after screenshots to the inbox, and refuses a check with neither screenshots nor a reason", async () => {
    await t.enqueue("APP-1", "Checkout");
    for (const thread of ["th_1", "th_2", "th_3"]) await t.tool("factory_stage_done", thread, { outcome: "complete", summary: "Done." });
    const { before_after: _shot, ...bare } = CHECK;
    await expect(t.tool("factory_stage_done", "th_4", { outcome: "complete", summary: "Reviewed.", change_note: NOTE, founder_check: bare })).rejects.toThrow(/side-by-side before\/after image/);
    await t.tool("factory_stage_done", "th_4", { outcome: "complete", summary: "Reviewed.", change_note: NOTE, founder_check: CHECK });
    expect((await t.item("APP-1")).founderCheck?.screenshots).toEqual([expect.objectContaining({ type: "localImage", path: "/attachments/before-after.png", mimeType: "image/png" })]);
    const entry = (await t.state()).inbox.find((candidate) => candidate.kind === "check")!;
    expect(await t.rpc("checkScreenshots", { entryId: entry.id })).toHaveLength(1);
    const missing = await t.tool("factory_stage_done", "th_4", { outcome: "complete", summary: "Again.", change_note: NOTE, founder_check: { ...CHECK, before_after: "/nowhere/after.png" } });
    expect(String(missing)).toMatch(/could not be read/);
    // A check already waiting gets its image from any of the ticket's threads.
    expect(await t.tool("factory_check_images", "th_1", { before_after: SHOT, screenshots: [SHOT] })).toMatch(/Added 2 image/);
    expect((await t.item("APP-1")).founderCheck?.screenshots).toHaveLength(2);
    // Another thread (the Mechanic, a fresh session) names the ticket from the CLI.
    const cli = await t.harness.behavior.runCli(["check-images", "--before-after", SHOT, "--key", "APP-1"], { projectId: PROJECT, threadId: "th_9" });
    expect(cli.stdout).toMatch(/Added 1 image/);
    expect((await t.item("APP-1")).founderCheck?.screenshots).toHaveLength(1);
  });
  const RENDERED = [
    "**Before:** Checking off a set took two taps.",
    "**Why:** Users mid-checkout want one tap.",
    "**Now:** One tap checks a set off.",
    "**Needs your review**",
    "Test account: 1006@t.qa / pw",
    "**Steps to test**\n- Open today's strength session.\n- Tap the first set: it shows a check.",
  ].join("\n\n");
  const toGate = async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Review complete.", founder_check: CHECK });
  };

  it("holds before ship with the check in the inbox, and ships when they approves", async () => {
    await toGate();
    expect(t.spawned).toHaveLength(2);
    const { inbox } = await t.state();
    expect(inbox[0]).toMatchObject({ kind: "check", from: "Founder QA · APP-1", context: RENDERED });
    expect((await t.item("APP-1")).status).toBe("needs-founder");

    await t.rpc("approve", { entryId: inbox[0]!.id });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("holds at the gate when the ship stage itself sends a check, and reruns ship once they approves", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Review complete." });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
    // As APP-1037's ship stage did: it prepared the PR and sent a check instead of merging.
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Ship prepared, sent for the phone check.", founder_check: CHECK });
    expect((await t.item("APP-1")).status).toBe("needs-founder");
    const entry = (await t.state()).inbox.find((candidate) => candidate.kind === "check")!;
    expect(entry).toBeDefined();
    const sentBefore = t.sent.length;
    const spawnedBefore = t.spawned.length;
    await t.rpc("approve", { entryId: entry.id });
    // Ship runs again: its thread is told to carry on, or a new one starts.
    expect(t.sent.length > sentBefore || t.spawned.length > spawnedBefore).toBe(true);
    expect((await t.item("APP-1")).status).toBe("running");
    await t.tool("factory_stage_done", (await t.item("APP-1")).threads.ship!, { outcome: "complete", change_note: NOTE, summary: "Merged." });
    expect((await t.item("APP-1")).status).toBe("done");
  });

  it("puts a ticket that left with an unapproved check back at the gate", async () => {
    await toGate();
    const item = await t.item("APP-1");
    // As the factory left APP-1037 before the gate held: archived, check unapproved.
    t.host.bb.storage.database().prepare(`UPDATE items SET data = json_set(data, '$.status', 'archived') WHERE id = ?`).run(item.id);
    for (const entry of (await t.state()).inbox) await t.rpc("dismiss", { entryId: entry.id });
    const result = await t.harness.behavior.runCli(["reopen-check", "APP-1"], { projectId: PROJECT });
    expect(result.stdout).toMatch(/back at the founder gate/);
    expect((await t.item("APP-1")).status).toBe("needs-founder");
    expect((await t.state()).inbox.some((entry) => entry.kind === "check")).toBe(true);
    // They approved it in another question: --approved sends it straight to ship.
    for (const entry of (await t.state()).inbox) await t.rpc("dismiss", { entryId: entry.id });
    t.host.bb.storage.database().prepare(`UPDATE items SET data = json_set(data, '$.status', 'archived') WHERE id = ?`).run(item.id);
    const approved = await t.harness.behavior.runCli(["reopen-check", "APP-1", "--approved"], { projectId: PROJECT });
    expect(approved.stdout + (approved.stderr ?? "")).toMatch(/approved and back in its ship stage/);
    expect((await t.item("APP-1")).status).toBe("running");
    expect(t.spawned.at(-1)!.title).toBe("Ship");
  });

  // th_1 owns APP-1 (it reviewed the plan), th_2 builds, th_3 reviews the code.
  const ownedToGate = async () => {
    await t.enqueue("APP-1", "Checkout", "planned");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Plan reviewed." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Built.", founder_check: CHECK });
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Review complete." });
    const entry = (await t.state()).inbox[0]!;
    // The check lives in the owner's thread: that is where they talk about this ticket.
    expect(entry).toMatchObject({ kind: "check", threadId: "th_1" });
    return entry;
  };

  it("routes notes on a check to the issue owner, and notes they sent themselves still hand the ticket to the owner", async () => {
    const first = await ownedToGate();
    const route = await t.rpc("answerRoute", { entryId: first.id });
    expect(route).toMatchObject({ threadId: "th_1" });
    const sentBefore = t.sent.length;
    await t.rpc("answer", { entryId: first.id, answer: "The check mark is too small.", delivered: true });
    expect(t.sent.length).toBe(sentBefore);
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("with-owner");
  });

  it("sends their notes to the issue owner, who sends the builder the work; they are asked again after the fix", async () => {
    const first = await ownedToGate();
    await t.rpc("answer", { entryId: first.id, answer: "The check mark is too small." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("The check mark is too small.");
    expect(t.sent.at(-1)!.text).toContain('to: "APP-1:build"');
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("with-owner");

    // An owner that sits on their notes is reminded.
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Hm." });
    expect(t.sent.at(-1)!.text).toContain("The founder's notes on APP-1 are still with you");

    const sent = await t.tool("factory_message", "th_1", { to: "APP-1:build", message: "Make the check mark 24pt. Plan updated." });
    expect(sent).toContain("APP-1 is back in that stage");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("call factory_stage_done again");
    expect(await t.item("APP-1")).toMatchObject({ status: "running", stageIndex: 1 });

    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Bigger check mark.", founder_check: { ...CHECK, now: "One tap checks a set off, with a 24pt mark." } });
    // Rework is new code: it is reviewed again, in a fresh thread, before they are asked.
    expect(t.spawned).toHaveLength(4);
    expect(t.spawned.at(-1)!.title).toBe("Code review");
    expect((await t.state()).inbox).toEqual([]);
    await t.tool("factory_stage_done", "th_4", { outcome: "complete", change_note: NOTE, summary: "Rework reviewed." });
    // Still no ship until they have tried it again.
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "check", threadId: "th_1" });
    expect((await t.state()).inbox[0]!.context).toContain("with a 24pt mark.");
  });

  it("never shows them the old check after their notes: the builder replaces it or withdraws it", async () => {
    const first = await ownedToGate();
    await t.rpc("answer", { entryId: first.id, answer: "Drop the notification; just retry twice and alert me." });
    await t.tool("factory_message", "th_1", { to: "APP-1:build", message: "No user notification now. Plan updated." });
    // Reporting without either is refused, and nothing is recorded.
    const refused = await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Reworked." });
    expect(refused).toContain("founder_check_withdrawn");
    expect((await t.state()).inbox).toEqual([]);
    expect(await t.item("APP-1")).toMatchObject({ status: "running", stageIndex: 1 });
    // Nothing they can see changes any more: the check goes, and the ticket ships.
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Reworked.", founder_check_withdrawn: "The user notification was removed; nothing on screen changes." });
    expect((await t.item("APP-1")).founderCheck).toBeNull();
    expect((await t.state()).inbox).toEqual([]);
    expect(t.spawned.at(-1)!.title).toBe("Code review");
    await t.tool("factory_stage_done", "th_4", { outcome: "complete", change_note: NOTE, summary: "Rework reviewed." });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
  });

  it("sends a ticket back to review in a fresh thread when its work changed after review", async () => {
    const entry = await ownedToGate();
    await t.rpc("approve", { entryId: entry.id });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
    const result = await t.harness.behavior.runCli(["rereview", "APP-1"], { projectId: PROJECT });
    expect(result.exitCode).toBe(0);
    expect(t.spawned.at(-1)).toMatchObject({ title: "Code review" });
    expect(t.spawned.at(-1)!.prompt).toContain("changed after its last review");
    expect(await t.item("APP-1")).toMatchObject({ status: "running", stageIndex: 2 });
    // The ship thread that was running is no longer the ticket's stage.
    expect(await t.tool("factory_stage_done", "th_4", { outcome: "complete", change_note: NOTE, summary: "Merged." })).toContain("not the current stage");
  });

  it("takes notes they type in the owner's thread the same way, and lets the owner hand the check back unchanged", async () => {
    await ownedToGate();
    await t.founderTypes("th_1");
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("with-owner");

    expect(await t.tool("factory_stage_done", "th_1", { outcome: "blocked", summary: "x" })).toContain('Only outcome \\"complete\\" applies here');
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "The mark is already 24pt; your phone has Larger Text on." });
    const again = (await t.state()).inbox[0]!;
    expect(again).toMatchObject({ kind: "check", threadId: "th_1" });
    expect(again.context).toContain("**From the issue owner:** The mark is already 24pt; your phone has Larger Text on.");
    expect(again.context).toContain("**Now:** One tap checks a set off.");
    expect((await t.item("APP-1")).status).toBe("needs-founder");
    await t.rpc("approve", { entryId: again.id });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
  });

  it("reopens a shipped ticket when its owner sends the builder follow-up work", async () => {
    const entry = await ownedToGate();
    await t.rpc("approve", { entryId: entry.id });
    await t.tool("factory_stage_done", "th_4", { outcome: "complete", change_note: NOTE, summary: "Merged." });
    expect((await t.item("APP-1")).status).toBe("done");

    // They give feedback after it shipped; the owner plans the fix and sends it on.
    await t.tool("factory_message", "th_1", { to: "APP-1:build", message: "Follow-up: the mark overlaps long exercise names." });
    expect(await t.item("APP-1")).toMatchObject({ status: "running", stageIndex: 1 });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Fixed the overlap.", founder_check: CHECK });
    expect(t.spawned.at(-1)!.title).toBe("Code review");
    await t.tool("factory_stage_done", t.spawned.at(-1)!.id, { outcome: "complete", change_note: NOTE, summary: "Follow-up reviewed." });
    // It comes back to them to try before it ships again.
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "check", threadId: "th_1" });
  });

  it("lets the owner continue a shipped ticket under a new ticket, in the same workspace and the same owner thread", async () => {
    const entry = await ownedToGate();
    await t.rpc("approve", { entryId: entry.id });
    expect(await t.tool("factory_follow_up", "th_1", { key: "APP-20", title: "Round two", handoff: "Fix the overlap." })).toContain("has not shipped");
    await t.tool("factory_stage_done", "th_4", { outcome: "complete", change_note: NOTE, summary: "Merged." });
    expect(await t.tool("factory_follow_up", "th_2", { key: "APP-20", title: "Round two", handoff: "x" })).toContain("Only a ticket's issue owner");

    const reply = await t.tool("factory_follow_up", "th_1", { key: "APP-20", title: "Round two", handoff: "Fix the overlap with long names." });
    expect(reply).toContain("APP-20 has taken over this workspace");
    // A builder starts on the handoff in the shipped ticket's workspace: no new worktree.
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_5", title: "Execution", environment: { type: "reuse", environmentId: "env_th_1" } });
    expect(t.spawned.at(-1)!.prompt).toContain("Fix the overlap with long names.");
    expect(t.renamed.at(-1)).toEqual({ environmentId: "env_th_1", name: "APP-20" });
    // The shipped ticket leaves the board; nothing is done and in progress at once.
    const board = (await t.state()).items.filter((item) => item.status !== "archived");
    expect(board.map((item) => [item.key, item.status, item.pipeline])).toEqual([["APP-20", "running", "reviewed"]]);
    // The same thread owns the new ticket: the builder's questions come to it.
    await t.tool("factory_ask_planner", "th_5", { question: "Which names?" });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", senderThreadId: "th_5" });
    expect((await t.item("APP-20")).status).toBe("with-owner");
  });

  it("sends their notes straight to the builder of a small bug running alone, which owns itself", async () => {
    await t.enqueue("APP-7", "Checkout", "small-bug");
    await t.tool("factory_ask_founder", "th_1", { kind: "todo", question: "Record the menu" });
    const entry = (await t.state()).inbox[0]!;
    // Its builder is its owner, so it reaches the inbox itself.
    expect(entry).toMatchObject({ kind: "todo", threadId: "th_1", from: "Fix · APP-7" });
    await t.rpc("answer", { entryId: entry.id, answer: "Done." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.spawned).toHaveLength(1);
  });

  it("starts an owner for their notes on a ticket whose plan was reviewed elsewhere", async () => {
    await toGate();
    const first = (await t.state()).inbox[0]!;
    await t.rpc("answer", { entryId: first.id, answer: "The check mark is too small." });
    // A ticket reviewed elsewhere gets its owner now, and the notes go there.
    expect(t.spawned.at(-1)!.title).toBe("Issue owner");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_3" });
    expect(t.sent.at(-1)!.text).toContain("The check mark is too small.");
  });

  it("ships straight through when no stage recorded a check", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Review complete." });
    expect(t.spawned.at(-1)!.title).toBe("Ship");
  });

  it("keeps a merged ticket under Done until the founder archives its workspace, and never archives for them", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Reviewed." });
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Merged." });
    expect(t.archived).toEqual([]);
    expect((await t.item("APP-1")).status).toBe("done");

    await t.emit("thread.archived", "th_1");
    await t.emit("thread.archived", "th_2");
    expect((await t.item("APP-1")).status).toBe("done");
    await t.emit("thread.archived", "th_3");
    expect((await t.item("APP-1")).status).toBe("archived");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("never shows a merged ticket as working, even before its ship thread goes idle", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Reviewed." });
    await t.emit("thread.active", "th_3");
    expect((await t.item("APP-1")).working).toBe(true);
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Merged." });
    expect((await t.item("APP-1")).working).toBe(false);
    // The idle that follows finds no current stage; the ticket stays at rest.
    await t.emit("thread.idle", "th_3");
    expect((await t.item("APP-1")).working).toBe(false);
  });

  it("archives a merged ticket's workspace from its Done card and takes it off the board", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await expect(t.rpc("archiveDone", { itemId: (await t.item("APP-1")).id })).rejects.toThrow(/not merged/);
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Reviewed." });
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Merged." });
    await t.rpc("archiveDone", { itemId: (await t.item("APP-1")).id });
    // Every stage shares one worktree, so it is archived once.
    expect(t.archivedWorkspaces).toEqual(["env_th_1"]);
    expect((await t.item("APP-1")).status).toBe("archived");
  });

  it("leaves the Integrator's Maintenance lane alone when the schedule syncs", async () => {
    await t.harness.behavior.runCli(["sync", JSON.stringify({ lanes: [{ name: "Checkout", items: [{ key: "APP-1", title: "One", pipeline: "planned", waitingOn: ["APP-9"] }] }] })], { projectId: PROJECT });
    await t.harness.behavior.runCli(["enqueue", "APP-1039", "PostHog SDK current", "--lane", "Maintenance", "--pipeline", "planned"], { projectId: PROJECT });
    await t.harness.behavior.runCli(["enqueue", "APP-1040", "Expo patch", "--lane", "Maintenance", "--pipeline", "planned"], { projectId: PROJECT });
    // A later schedule that does not list them cancels neither the running one nor the queued one.
    await t.harness.behavior.runCli(["sync", JSON.stringify({ lanes: [{ name: "Checkout", items: [{ key: "APP-1", title: "One", pipeline: "planned", waitingOn: ["APP-9"] }] }] })], { projectId: PROJECT });
    expect((await t.item("APP-1039")).status).toBe("running");
    expect((await t.item("APP-1040")).status).toBe("queued");
  });

  it("never starts a ticket the schedule says is waiting on another, and starts it once the wait is gone", async () => {
    const sync = (items: unknown[]) =>
      t.harness.behavior.runCli(["sync", JSON.stringify({ lanes: [{ name: "Checkout", items }] })], { projectId: PROJECT });
    await sync([{ key: "APP-964", title: "Team note", pipeline: "planned", waitingOn: ["APP-406"] }]);
    expect(t.spawned).toHaveLength(0);
    expect(await t.item("APP-964")).toMatchObject({ status: "queued", waitingOn: ["APP-406"] });
    // APP-406 merged: the next schedule no longer lists the wait.
    await sync([{ key: "APP-964", title: "Team note", pipeline: "planned" }]);
    expect(t.spawned).toHaveLength(1);
    expect((await t.item("APP-964")).waitingOn).toEqual([]);
  });

  it("shows a ticket parked for later in its lane and never starts it", async () => {
    const sync = (items: unknown[]) =>
      t.harness.behavior.runCli(["sync", JSON.stringify({ lanes: [{ name: "Checkout", items }] })], { projectId: PROJECT });
    await sync([
      { key: "APP-1", title: "Parked", pipeline: "planned", parked: true },
      { key: "APP-2", title: "Ready", pipeline: "small-bug" },
    ]);
    // The parked ticket does not hold the lane up.
    expect(await t.item("APP-1")).toMatchObject({ status: "queued", parked: true });
    expect((await t.item("APP-2")).status).toBe("running");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", change_note: NOTE, summary: "Fixed." });
    expect(t.spawned).toHaveLength(1);

    // The founder removes the Later label: the next schedule starts it.
    await sync([{ key: "APP-1", title: "Parked", pipeline: "reviewed" }]);
    expect(t.spawned.at(-1)!.title).toBe("Execution");
    expect(await t.item("APP-1")).toMatchObject({ status: "running", parked: false, pipeline: "reviewed" });
  });
});

describe("builder tiers", () => {
  it("builds a ticket on the model set for its plan's tier, and tier 1 or no tier on the base builder", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          build: { ...config.roles.build, providerId: "codex", model: "gpt-sol" },
          "build-tier-2": { ...config.roles["build-tier-2"], providerId: "claude-code", model: "claude-opus-5-5" },
          "build-tier-3": { ...config.roles["build-tier-3"], providerId: "claude-code", model: "claude-fable-5-2" },
        },
      },
    });
    const sync = JSON.stringify({
      lanes: [
        { name: "A", items: [{ key: "APP-1", title: "One", pipeline: "reviewed", tier: 1 }] },
        { name: "B", items: [{ key: "APP-2", title: "Two", pipeline: "reviewed", tier: 2 }] },
        { name: "C", items: [{ key: "APP-3", title: "Three", pipeline: "reviewed", tier: 3 }] },
        { name: "D", items: [{ key: "APP-4", title: "Four", pipeline: "reviewed" }] },
      ],
    });
    await t.harness.behavior.runCli(["sync", sync], { projectId: PROJECT });
    expect(t.spawned.map((thread) => `${thread.title} ${thread.model}`)).toEqual([
      "Execution gpt-sol",
      "Execution claude-opus-5-5",
      "Execution claude-fable-5-2",
      "Execution gpt-sol",
    ]);
    // The tier chooses the builder only; the reviewer is the same for all.
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", change_note: NOTE, summary: "Built." });
    expect(t.spawned.at(-1)).not.toHaveProperty("model");
  });

  it("builds a UI ticket on the UI builder for its tier, and a tier 3 UI plan on the UI tier 2 builder", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          build: { ...config.roles.build, providerId: "codex", model: "gpt-sol" },
          "ui-build": { ...config.roles["ui-build"], providerId: "claude-code", model: "claude-opus-5-5" },
          "ui-build-tier-2": { ...config.roles["ui-build-tier-2"], providerId: "claude-code", model: "claude-fable-5-2" },
        },
      },
    });
    const sync = JSON.stringify({
      lanes: [
        { name: "A", items: [{ key: "APP-1", title: "One", pipeline: "reviewed", tier: 1, builder: "ui" }] },
        { name: "B", items: [{ key: "APP-2", title: "Two", pipeline: "reviewed", tier: 2, builder: "ui" }] },
        { name: "C", items: [{ key: "APP-3", title: "Three", pipeline: "reviewed", tier: 3, builder: "ui" }] },
        { name: "D", items: [{ key: "APP-4", title: "Four", pipeline: "reviewed", tier: 1, builder: "fullstack" }] },
      ],
    });
    await t.harness.behavior.runCli(["sync", sync], { projectId: PROJECT });
    expect(t.spawned.map((thread) => `${thread.title} ${thread.model}`)).toEqual([
      "Execution claude-opus-5-5",
      "Execution claude-fable-5-2",
      "Execution claude-fable-5-2",
      "Execution gpt-sol",
    ]);
    expect((await t.item("APP-2")).builder).toBe("ui");
    // Enqueued by hand, too.
    await t.harness.behavior.runCli(["enqueue", "APP-5", "Five", "--lane", "E", "--pipeline", "reviewed", "--tier", "1", "--builder", "ui"], { projectId: PROJECT });
    expect(t.spawned.at(-1)!.model).toBe("claude-opus-5-5");
  });
});

describe("falling back when a model's limit runs out", () => {
  const limit = (threadId: string, resetsAtMs: number | null = Date.now() + 3_600_000) =>
    t.harness.behavior
      .emitThreadEvent("turn.failed", makeTurnFailedEvent({
        threadId,
        errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
        rateLimits: resetsAtMs === null ? null : ({ windows: [{ resetsAtMs }] } as never),
      } as never) as never)
      .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const withFallback = async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          build: { ...config.roles.build, providerId: "claude-code", model: "claude-fable-5-2", reasoningLevel: "medium", fallbackModel: "claude-opus-5-5" },
        },
      },
    });
  };

  it("moves the thread to the fallback model and reruns the turn, without bothering the founder", async () => {
    await withFallback();
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await limit("th_1");
    await t.emit("thread.failed", "th_1", { error: "usage limit reached" });
    expect(t.updated).toEqual([{ threadId: "th_1", model: "claude-opus-5-5", reasoningLevel: "medium" }]);
    // A new turn, not a retry: bb replays a retried request on its original model.
    expect(t.retried).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("now runs on claude-opus-5-5");

    // The rerun starts: the ticket is running again and the failure leaves the inbox.
    await t.emit("thread.active", "th_1");
    expect((await t.item("APP-1")).status).toBe("running");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("starts that role's new threads on the fallback until the limit resets", async () => {
    await withFallback();
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await limit("th_1", Date.now() + 3_600_000);
    await t.enqueue("APP-2", "Plan", "reviewed");
    expect(t.spawned.at(-1)).toMatchObject({ title: "Execution", model: "claude-opus-5-5" });
  });

  it("switches a thread once: a limit on the fallback too goes to the founder", async () => {
    await withFallback();
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await limit("th_1");
    await limit("th_1");
    expect(t.updated).toHaveLength(1);
    await t.emit("thread.failed", "th_1", { error: "usage limit reached" });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "failed" });
  });

  it("hands a stage to a new thread on another provider, in the same worktree, with a handover", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          build: { ...config.roles.build, providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", fallbackProviderId: "codex", fallbackModel: "gpt-sol" },
        },
      },
    });
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await t.emit("thread.failed", "th_1", { error: "usage limit reached" });
    await limit("th_1");

    // A thread cannot change provider: nothing is switched in place.
    expect(t.updated).toEqual([]);
    expect(t.retried).toEqual([]);
    const replacement = t.spawned.at(-1)!;
    expect(replacement).toMatchObject({ id: "th_2", title: "Execution", providerId: "codex", model: "gpt-sol" });
    expect(replacement).not.toHaveProperty("reasoningLevel");
    expect(replacement.environment).toEqual({ type: "reuse", environmentId: "env_th_1" });
    expect(replacement.prompt).toContain("bb thread log th_1");
    expect(replacement.prompt).toContain("do not redo finished work");
    expect((await t.item("APP-1")).status).toBe("running");
    expect((await t.state()).inbox).toEqual([]);

    // The new thread reports for the stage; the old one no longer can.
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", change_note: NOTE, summary: "Built." });
    expect(t.spawned.at(-1)!.title).toBe("Code review");
    // A limit on the fallback as well goes to the founder, not back and forth.
    await t.enqueue("APP-2", "Plan", "reviewed");
    expect(t.spawned.at(-1)).toMatchObject({ title: "Execution", providerId: "codex" });
  });

  it("moves a standing agent to a new thread on another provider when its limit runs out", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          orchestrator: { ...config.roles.orchestrator, providerId: "claude-code", model: "claude-opus-5-5", fallbackProviderId: "codex", fallbackModel: "gpt-sol" },
        },
      },
    });
    await t.rpc("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await limit("th_1");
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_2", title: "Architect", providerId: "codex", model: "gpt-sol", pinned: false });
    expect(t.spawned.at(-1)!.prompt).toContain("bb thread log th_1");
    expect((await t.state()).agents.find((agent) => agent.agentId === "orchestrator")!.threadId).toBe("th_2");
  });

  it("leaves a role with no fallback alone", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    await limit("th_1");
    expect(t.updated).toEqual([]);
    expect(t.retried).toEqual([]);
  });
});

describe("configuration and CLI", () => {
  it("points a stage at a project's own skill from the command line, and refuses an unknown stage or role", async () => {
    const prompt = "Use the `acme-plan` skill to plan {key}: {title}.";
    await t.harness.behavior.runCli(["stage", "plan", "--prompt", prompt, "--role", "plan-review"], { projectId: PROJECT });
    const { config } = await t.state();
    expect(config.stages.plan).toMatchObject({ prompt, role: "plan-review", review: false });
    expect(JSON.stringify(await t.harness.behavior.runCli(["stage", "nope", "--prompt", "x"], { projectId: PROJECT }))).toContain("Name a stage");
    expect(JSON.stringify(await t.harness.behavior.runCli(["stage", "plan", "--role", "nope"], { projectId: PROJECT }))).toContain("No role");
    expect((await t.state()).config.stages.plan.prompt).toBe(prompt);
    await t.harness.behavior.runCli(["stage", "plan", "--prompt", "Plan {key}.\\n\\n{brief}"], { projectId: PROJECT });
    expect((await t.state()).config.stages.plan.prompt).toBe("Plan {key}.\n\n{brief}");
  });

  it("records the tier a plan reviewer confirmed, so the build runs on that tier's builder", async () => {
    await t.enqueue("APP-1", "Checkout", "planned");
    await t.harness.behavior.runCli(["tier", "APP-1", "--tier", "2", "--builder", "ui"], { projectId: PROJECT });
    const item = (await t.state()).items.find((candidate) => candidate.key === "APP-1")!;
    expect(item).toMatchObject({ tier: 2, builder: "ui" });
    expect(JSON.stringify(await t.harness.behavior.runCli(["tier", "APP-1", "--tier", "4"], { projectId: PROJECT }))).toContain("1, 2 or 3");
  });

  it("gives stage threads the bundled process skills, and standing agents those plus onboarding", async () => {
    const stage = await t.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { binding: { kind: "stage", itemId: "itm_1", stage: "build" } } } as never),
    );
    expect(JSON.stringify(stage?.skills)).toContain("factory-build");
    expect(JSON.stringify(stage?.skills)).not.toContain("factory-onboarding");
    const agent = await t.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { binding: { kind: "agent", agentId: "harness-improver", projectId: PROJECT } } } as never),
    );
    expect(JSON.stringify(stage?.skills)).not.toContain("factory-sequence");
    for (const skill of ["factory-harness-improver", "factory-onboarding", "factory-plan", "factory-sequence", "factory-tracker"]) expect(JSON.stringify(agent?.skills)).toContain(skill);
  });

  it("gives a configuration saved before builder tiers existed tier 2 and 3 builders copied from its builder", async () => {
    const { config } = await t.state();
    const { "build-tier-2": _two, "build-tier-3": _three, "ui-build": _ui, "ui-build-tier-2": _ui2, ...roles } = config.roles;
    const old = {
      ...config,
      roles: { ...roles, build: { ...roles.build, label: "Builder", providerId: "codex", model: "gpt-sol", reasoningLevel: "medium" } },
      stages: { ...config.stages, build: { ...config.stages.build, tierRoles: {} } },
    };
    await t.rpc("saveConfig", { projectId: PROJECT, config: old });
    const upgraded = (await t.state()).config;
    // Tiers first, then the UI builders (22 Nov), which relabel the builders full-stack.
    expect(upgraded.roles.build.label).toBe("Full-stack builder, tier 1");
    expect(upgraded.roles["build-tier-3"]).toMatchObject({ label: "Full-stack builder, tier 3", providerId: "codex", model: "gpt-sol", reasoningLevel: "medium" });
    expect(upgraded.roles["ui-build"]).toMatchObject({ label: "UI builder, tier 1" });
    expect(upgraded.stages.build.tierRoles).toEqual({ "2": "build-tier-2", "3": "build-tier-3", "ui:1": "ui-build", "ui:2": "ui-build-tier-2" });
  });

  it("retires the chief of staff from a configuration saved before issue owners, and makes the plan reviewer the owner", async () => {
    const { config } = await t.state();
    const old = {
      ...config,
      roles: { ...config.roles, "plan-review": { ...config.roles["plan-review"], label: "Plan reviewer", model: "fable" }, "chief-of-staff": { ...config.roles.ship, label: "Chief of staff" } },
      agents: { ...config.agents, "chief-of-staff": { label: "Chief of staff", role: "chief-of-staff", skill: "factory-chief-of-staff", memoryPath: "docs/chief.md" } },
      stages: Object.fromEntries(Object.entries(config.stages).map(([id, stage]) => [id, { ...stage, owner: false }])),
    };
    await t.rpc("saveConfig", { projectId: PROJECT, config: old });
    const upgraded = (await t.state()).config;
    expect(upgraded.agents["chief-of-staff"]).toBeUndefined();
    expect(upgraded.roles["chief-of-staff"]).toBeUndefined();
    expect(upgraded.roles["plan-review"]).toMatchObject({ label: "Issue owner", model: "fable" });
    expect(upgraded.stages["plan-review"]!.owner).toBe(true);
    expect(upgraded.stages.build!.owner).toBe(false);
  });

  it("renames the planner and Watch to their current names in a saved configuration, and leaves a name the founder chose", async () => {
    const { config } = await t.state();
    const old = {
      ...config,
      roles: { ...config.roles, orchestrator: { ...config.roles.orchestrator, label: "Planner / strategist" }, watch: { ...config.roles.watch, label: "Night watch" } },
      agents: { ...config.agents, orchestrator: { ...config.agents.orchestrator, label: "Planner / strategist" }, watch: { ...config.agents.watch, label: "Watch" } },
    };
    await t.rpc("saveConfig", { projectId: PROJECT, config: old });
    const upgraded = (await t.state()).config;
    expect(upgraded.roles.orchestrator!.label).toBe("Architect");
    expect(upgraded.agents.orchestrator!.label).toBe("Architect");
    expect(upgraded.agents.watch!.label).toBe("Observer");
    expect(upgraded.roles.watch!.label).toBe("Night watch");
  });

  it("renames the CTO to Architect and the harness improver to Mechanic in a saved configuration", async () => {
    const { config } = await t.state();
    const old = {
      ...config,
      roles: { ...config.roles, orchestrator: { ...config.roles.orchestrator, label: "CTO" }, "harness-improver": { ...config.roles["harness-improver"], label: "Harness improver" } },
      agents: { ...config.agents, orchestrator: { ...config.agents.orchestrator, label: "CTO" }, "harness-improver": { ...config.agents["harness-improver"], label: "Harness improver" } },
    };
    await t.rpc("saveConfig", { projectId: PROJECT, config: old });
    const upgraded = (await t.state()).config;
    expect(upgraded.roles.orchestrator!.label).toBe("Architect");
    expect(upgraded.agents.orchestrator!.label).toBe("Architect");
    expect(upgraded.roles["harness-improver"]!.label).toBe("Mechanic");
    expect(upgraded.agents["harness-improver"]!.label).toBe("Mechanic");
  });

  it("rejects a configuration whose stage names an undefined role", async () => {
    const { config } = await t.state();
    await expect(
      t.rpc("saveConfig", {
        projectId: PROJECT,
        config: { ...config, stages: { ...config.stages, build: { ...config.stages.build, role: "nobody" } } },
      }),
    ).rejects.toThrow(/role "nobody"/);
  });

  it("sets a role's model from the command line", async () => {
    const result = await t.harness.behavior.runCli(
      ["role", "ship", "--provider", "codex", "--model", "gpt-luna", "--reasoning", "low"],
      { projectId: PROJECT },
    );
    expect(result.stdout).toBe("ship: codex · gpt-luna · low");
    expect((await t.state()).config.roles.ship).toMatchObject({ providerId: "codex", model: "gpt-luna" });
  });

  it("queues a whole swimlane plan from JSON and prints the board", async () => {
    const plan = JSON.stringify({
      lanes: [
        { name: "Checkout", items: [{ key: "APP-1", title: "Rest days", pipeline: "reviewed" }, { key: "APP-2", title: "Units" }] },
        { name: "Plan", items: [{ key: "APP-3", title: "Week sizing", pipeline: "small-bug" }] },
      ],
    });
    const queued = await t.harness.behavior.runCli(["lanes", plan], { projectId: PROJECT });
    expect(queued.exitCode).toBe(0);

    const status = await t.harness.behavior.runCli(["status"], { projectId: PROJECT });
    expect(status.stdout).toContain("APP-1  running  Execution  — Rest days");
    expect(status.stdout).toContain("APP-2  queued");
    expect(status.stdout).toContain("APP-3  running  Fix");
  });

  it("syncs lanes to a schedule without reordering a lane or touching started work", async () => {
    const sync = (lanes: unknown) =>
      t.harness.behavior.runCli(["sync", JSON.stringify({ lanes })], { projectId: PROJECT });
    await sync([
      { name: "Lane 1", items: [{ key: "APP-1", title: "One", pipeline: "reviewed" }, { key: "APP-2", title: "Two" }, { key: "APP-3", title: "Three" }] },
      { name: "Lane 2", items: [{ key: "APP-4", title: "Four", pipeline: "reviewed" }] },
    ]);
    expect((await t.item("APP-1")).status).toBe("running");
    expect((await t.item("APP-2")).status).toBe("queued");

    // The founder puts APP-3 ahead of APP-2 inside the lane.
    await t.rpc("move", { itemId: (await t.item("APP-3")).id, lane: "Lane 1", position: 2 });

    // Next schedule: APP-5 is new, APP-2 left the board, APP-4 changed lanes,
    // and the running APP-1 is no longer listed.
    const second = await sync([
      { name: "Lane 1", items: [{ key: "APP-3", title: "Three" }, { key: "APP-5", title: "Five" }, { key: "APP-4", title: "Four" }] },
    ]);
    expect(second.stdout).toContain('APP-5: queued in "Lane 1"');
    expect(second.stdout).toContain("APP-2: removed");
    expect(second.stdout).toContain('APP-4: moved from "Lane 2" to "Lane 1"');
    expect((await t.item("APP-1")).status).toBe("running");
    expect((await t.item("APP-4")).status).toBe("running");
    const lane = (await t.state()).items
      .filter((item) => item.lane === "Lane 1" && item.status !== "cancelled")
      .map((item) => item.key);
    expect(lane).toEqual(["APP-1", "APP-3", "APP-5", "APP-4"]);

    // Running the same schedule again changes nothing.
    expect((await sync([{ name: "Lane 1", items: [{ key: "APP-3", title: "Three" }, { key: "APP-5", title: "Five" }, { key: "APP-4", title: "Four" }] }])).stdout).toBe("Lanes already match.");
    expect(t.spawned).toHaveLength(2);
  });

  it("keeps tickets and configuration across a plugin reload", async () => {
    await t.enqueue("APP-1", "Checkout", "reviewed");
    const reloaded = await t.harness.lifecycle.reload(plugin);
    t.harness = reloaded.harness;
    const state = (await reloaded.harness.behavior.callRpc("state", { projectId: PROJECT })) as FactoryState;
    expect(state.items.map((item) => `${item.key} ${item.status}`)).toEqual(["APP-1 running"]);
  });
});

describe("the project's Run command", () => {
  it("reads the plain form and Conductor's table form, preferring the table marked default", () => {
    expect(parseRunCommand('[scripts]\nsetup = "./setup.sh"\nrun = "npm run dev"\n')).toBe("npm run dev");
    expect(
      parseRunCommand('[scripts.run.web]\ncommand = "npm run web"\n\n# the phone build\n[scripts.run.run]\ncommand = "npm run dev"\ndefault = true\n'),
    ).toBe("npm run dev");
    expect(parseRunCommand('[scripts.run.web]\ncommand = "npm run web"\n[scripts.run.ios]\ncommand = "npm run ios"\n')).toBe("npm run web");
  });

  it("finds nothing in a file with no run command, even when a prompt's text looks like one", () => {
    expect(parseRunCommand('[scripts]\nsetup = "./setup.sh"\n\n[prompts]\ncode_review = """Use the skill.\nrun = "not this"\n"""\n')).toBeNull();
  });
});

describe("bundled skills", () => {
  it("ships a skill folder for every skill the plugin hands to a thread, named as its frontmatter says", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const folders = readdirSync(new URL("../skills", import.meta.url)).filter((name) => !name.startsWith("."));
    for (const folder of folders) {
      const text = readFileSync(new URL(`../skills/${folder}/SKILL.md`, import.meta.url), "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${folder}\\n`));
    }
    // Every skill a default stage prompt names is one the plugin ships.
    const { config } = await t.state();
    for (const stage of Object.values(config.stages)) {
      for (const [, name] of stage.prompt.matchAll(/`(factory-[a-z-]+)` skill/g)) expect(folders).toContain(name);
    }
  });
});
