// Factory — frontend entry. One page: the founder's inbox on top, the
// swimlanes under it, then who plays each role and the standing agents.
// React and @get-bb/plugin-sdk/app are provided by bb at load time.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  Markdown,
  ThreadChat,
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_useAppPanel,
  experimental_usePluginId,
  useBbNavigate,
  useComposer,
  useComposers,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { ComposerDraftSnapshot, PluginFileOpenerProps, PluginNavPanelProps, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FactoryState, rpcContract } from "./server";
import type { Attachment, Config, InboxEntry, Item, Role } from "./src/factory/model";
import { RUN_SETTINGS_FILE, RUN_TERMINAL_TITLE, parseRunCommand } from "./src/factory/runScript";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CHANGED = "factory-changed";
const PROJECT_KEY = "solo-factor.factory.project";
const INBOX_ARRIVED = "factory-inbox-arrived";
const CHIME_KEY = "solo-factor.factory.chime";
const OPEN_KEY = "solo-factor.factory.inbox.open";
const PANEL_WIDTH_KEY = "solo-factor.factory.inbox.width";
const PANEL_DEFAULT = 544;
const PANEL_MIN = 360;
/** The inbox list keeps at least this much room beside the panel. */
const LIST_MIN = 320;

/**
 * Two soft, falling bell notes, like a station announcement chime. Made with
 * the browser's own audio, so there is no sound file to ship.
 */
let audio: AudioContext | null = null;
function playChime() {
  try {
    audio ??= new AudioContext();
    const context = audio;
    void context.resume();
    const start = context.currentTime + 0.02;
    // E5 then C5: a calm falling third.
    [659.25, 523.25].forEach((frequency, index) => {
      const at = start + index * 0.42;
      const gain = context.createGain();
      gain.connect(context.destination);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.6);
      // A fundamental with a quiet octave above gives it a bell's warmth.
      for (const [multiple, level] of [[1, 1], [2, 0.25]] as const) {
        const tone = context.createOscillator();
        const mix = context.createGain();
        tone.type = "sine";
        tone.frequency.value = frequency * multiple;
        mix.gain.value = level;
        tone.connect(mix).connect(gain);
        tone.start(at);
        tone.stop(at + 1.7);
      }
    });
  } catch {
    // No audio available: the inbox count and push notification still arrive.
  }
}
const chimeOn = () => typeof localStorage === "undefined" || localStorage.getItem(CHIME_KEY) !== "off";

/** Mounted once per bb window, whatever page is showing. */
function InboxChime() {
  useRealtime(INBOX_ARRIVED, () => {
    if (chimeOn()) playChime();
  });
  return null;
}

type Sdk = ReturnType<typeof useSdk>;
type Navigate = ReturnType<typeof useBbNavigate>;

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(content: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(content), (char) => char.charCodeAt(0)));
}

/** The Run terminals that are up, across the given threads. */
async function runningRuns(sdk: Sdk, threadIds: readonly string[]) {
  const lists = await Promise.all(
    threadIds.map((threadId) => sdk.terminals.list({ scope: { kind: "thread", threadId } }).catch(() => ({ sessions: [] }))),
  );
  return lists.flatMap((list) => list.sessions).filter((session) => session.title === RUN_TERMINAL_TITLE && (session.status === "running" || session.status === "starting"));
}

/**
 * Start the project's Run command in a ticket's workspace, in a terminal
 * titled "Run" as bb's own Run button does, after stopping every other Run in
 * the project. The
 * terminal opens beside the inbox when this surface can show one (the QR code
 * for a phone is in it); otherwise bb goes to the thread.
 */
async function runInWorkspace(sdk: Sdk, navigate: Navigate, threadId: string): Promise<void> {
  const thread = await sdk.threads.get({ threadId });
  if (thread.environmentId === null) throw new Error("This thread has no workspace to run in.");
  const environment = await sdk.environments.get({ environmentId: thread.environmentId });
  if (environment.path === null) throw new Error("This workspace has no checkout to run in.");
  const file = await sdk.files
    .read({ hostId: environment.hostId, rootPath: environment.path, path: `${environment.path}/${RUN_SETTINGS_FILE}` })
    .catch(() => null);
  const command = file === null ? null : parseRunCommand(file.contentEncoding === "utf8" ? file.content : fromBase64(file.content));
  if (command === null) throw new Error(`This project has no Run command. Add one to ${RUN_SETTINGS_FILE}.`);
  // One Run at a time across the whole project, not just this workspace: the
  // phone opens whichever app the dev server serves, and two servers fight
  // over it (founder, 25 Nov 2026).
  const projectThreads = await sdk.threads.list({ projectId: thread.projectId, includeHidden: true });
  const scanned = [...new Set([threadId, ...projectThreads.map((other) => other.id), ...runs.map((session) => session.threadId)])];
  const stale = await runningRuns(sdk, scanned);
  await Promise.all(stale.map((session) => sdk.terminals.close({ terminalId: session.id, mode: "force" }).catch(() => undefined)));
  await recheckRuns(scanned);
  const terminal = await sdk.terminals.create({ scope: { kind: "thread", threadId }, cols: 120, rows: 32, title: RUN_TERMINAL_TITLE, start: { mode: "shell" } });
  await sdk.terminals.input({ terminalId: terminal.id, dataBase64: toBase64(`${command}\n`) });
  await recheckRuns([threadId]);
  const shown = await navigate.experimental_openTerminal({ terminalId: terminal.id }).catch(() => false);
  if (!shown) navigate.toThread(threadId);
}

async function stopRuns(sdk: Sdk, sessions: readonly RunSession[]): Promise<void> {
  await Promise.all(sessions.map((session) => sdk.terminals.close({ terminalId: session.terminalId, mode: "force" })));
  await recheckRuns([...new Set(sessions.map((session) => session.threadId))]);
}

/**
 * Which Run commands are up, kept for the whole app: the sidebar marks those
 * workspaces and an inbox card turns its Run button into Stop. A plugin can
 * only decorate thread rows, and only from its app-wide script, so that script
 * hands its setter to the overlay below, which has the SDK to watch terminals.
 */
interface RunSession {
  terminalId: string;
  threadId: string;
  environmentId: string | null;
}
type RowStatusSetter = (threadId: string, status: { icon: string; label: string; tone: "running" } | null) => void;
const RUN_MARK = { icon: "Play", label: "Run is up in this workspace", tone: "running" } as const;
let runs: readonly RunSession[] = [];
const runListeners = new Set<() => void>();
let recheckRuns: (threadIds: readonly string[]) => Promise<void> = async () => undefined;
let setRowStatus: RowStatusSetter | null = null;
const marked = new Set<string>();

function syncMarks() {
  if (setRowStatus === null) return;
  const up = new Set(runs.map((session) => session.threadId));
  for (const threadId of marked) {
    if (up.has(threadId)) continue;
    marked.delete(threadId);
    setRowStatus(threadId, null);
  }
  for (const threadId of up) {
    if (marked.has(threadId)) continue;
    marked.add(threadId);
    setRowStatus(threadId, RUN_MARK);
  }
}

function RunWatch() {
  const sdk = useSdk();
  useEffect(() => {
    let stopped = false;
    const check = async (threadIds: readonly string[]) => {
      const found = await runningRuns(sdk, threadIds);
      if (stopped) return;
      runs = [
        ...runs.filter((session) => !threadIds.includes(session.threadId)),
        ...found.flatMap((session) => (session.threadId === null ? [] : [{ terminalId: session.id, threadId: session.threadId, environmentId: session.environmentId }])),
      ];
      syncMarks();
      for (const listener of runListeners) listener();
    };
    recheckRuns = check;
    sdk.threads.list({}).then((threads) => check(threads.map((thread) => thread.id)), () => undefined);
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.id !== undefined && event.changes.includes("terminals-changed")) void check([event.id]).catch(() => undefined);
      },
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [sdk]);
  return null;
}

/** The Run terminals that are up in the workspace this thread belongs to. */
function useRunsBeside(threadId: string): readonly RunSession[] {
  const sdk = useSdk();
  const all = useSyncExternalStore(
    (listener) => {
      runListeners.add(listener);
      return () => runListeners.delete(listener);
    },
    () => runs,
  );
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  useEffect(() => {
    if (threadId === "") return;
    sdk.threads.get({ threadId }).then((thread) => setEnvironmentId(thread.environmentId), () => undefined);
  }, [sdk, threadId]);
  return useMemo(
    () => all.filter((session) => session.threadId === threadId || (environmentId !== null && session.environmentId === environmentId)),
    [all, environmentId, threadId],
  );
}

/**
 * What the founder has written on an inbox entry and not yet sent. Kept in the
 * browser so it survives leaving the page, and handed to the thread's own
 * composer when they open the thread instead of answering here.
 */
interface ReplyDraft {
  text: string;
  attachments: Attachment[];
}
const DRAFT_KEY = "solo-factor.factory.draft.";
const NO_DRAFT: ReplyDraft = { text: "", attachments: [] };
const isBlank = (draft: ReplyDraft) => draft.text.trim() === "" && draft.attachments.length === 0;

function readDraft(entryId: string): ReplyDraft {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY + entryId) ?? "null");
    if (typeof saved !== "object" || saved === null) return NO_DRAFT;
    const { text, attachments } = saved as Partial<ReplyDraft>;
    return { text: typeof text === "string" ? text : "", attachments: Array.isArray(attachments) ? attachments : [] };
  } catch {
    return NO_DRAFT;
  }
}

function writeDraft(entryId: string, draft: ReplyDraft) {
  try {
    if (isBlank(draft)) localStorage.removeItem(DRAFT_KEY + entryId);
    else localStorage.setItem(DRAFT_KEY + entryId, JSON.stringify(draft));
  } catch {
    // A full or blocked store only costs the draft its persistence.
  }
}

function useReplyDraft(entryId: string) {
  const [draft, setDraft] = useState(() => readDraft(entryId));
  const update = useCallback(
    (next: (current: ReplyDraft) => ReplyDraft) =>
      setDraft((current) => {
        const value = next(current);
        writeDraft(entryId, value);
        return value;
      }),
    [entryId],
  );
  return [draft, update] as const;
}

interface Handoff {
  entryId: string;
  threadId: string;
  draft: ReplyDraft;
  tries: number;
}
let handoff: Handoff | null = null;
const handoffListeners = new Set<() => void>();
function setHandoff(next: Handoff | null) {
  handoff = next;
  for (const listener of handoffListeners) listener();
}

/**
 * Moves an inbox draft into the thread's composer once that composer is on
 * screen. The inbox copy is cleared only after the composer shows it, so a
 * draft is never lost between the two.
 */
function DraftHandoff() {
  const composers = useComposers();
  const pending = useSyncExternalStore(
    (listener) => {
      handoffListeners.add(listener);
      return () => handoffListeners.delete(listener);
    },
    () => handoff,
  );
  useEffect(() => {
    if (pending === null) return;
    const composer = composers.find((candidate) => candidate.scope.kind === "thread" && candidate.scope.threadId === pending.threadId);
    if (composer === undefined) return;
    const missing = pending.draft.attachments.filter((file) => !composer.draft.attachments.some((present) => present.path === file.path));
    if (composer.text.includes(pending.draft.text) && missing.length === 0) {
      writeDraft(pending.entryId, NO_DRAFT);
      setHandoff(null);
      return;
    }
    if (pending.tries >= 3) {
      setHandoff(null);
      return;
    }
    pending.tries += 1;
    composer.replace((current) => ({
      text: current.text.includes(pending.draft.text) ? current.text : current.text.trim() === "" ? pending.draft.text : `${current.text}\n\n${pending.draft.text}`,
      mentions: current.mentions,
      attachments: [...current.attachments, ...missing],
    }));
  }, [composers, pending]);
  return null;
}

/**
 * An inbox answer sent from the thread's own composer, so bb shows it as the
 * founder's message. The composer has to be on screen, so the inbox mounts the
 * thread's chat out of sight while it sends. The factory's context for the
 * agent rides in a mention pill only the agent can read. Their own draft in that
 * thread, if any, is put back afterwards.
 */
interface FounderSend {
  threadId: string;
  text: string;
  attachments: Attachment[];
  mention: { provider: string; id: string; label: string };
  phase: "waiting" | "filled" | "sending";
  /** Their own draft in that thread, put back after the send. */
  kept: ComposerDraftSnapshot | null;
  done: (error?: unknown) => void;
}
let founderSend: FounderSend | null = null;
const founderSendListeners = new Set<() => void>();
function setFounderSend(next: FounderSend | null) {
  founderSend = next;
  for (const listener of founderSendListeners) listener();
}

function sendAsFounder(threadId: string, text: string, attachments: Attachment[], mention: FounderSend["mention"]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The thread's composer did not open in time.")), 20_000);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      if (founderSend?.done === finish) setFounderSend(null);
      if (error === undefined) resolve();
      else reject(error);
    };
    setFounderSend({ threadId, text, attachments, mention, phase: "waiting", kept: null, done: finish });
  });
}

function FounderSendHost() {
  const composers = useComposers();
  const pending = useSyncExternalStore(
    (listener) => {
      founderSendListeners.add(listener);
      return () => founderSendListeners.delete(listener);
    },
    () => founderSend,
  );
  useEffect(() => {
    if (pending === null || pending.phase === "sending") return;
    const composer = composers.find((candidate) => candidate.scope.kind === "thread" && candidate.scope.threadId === pending.threadId);
    if (composer === undefined) return;
    if (pending.phase === "waiting") {
      // Fill the draft once, then send as soon as bb would let Enter send it.
      pending.kept = composer.draft;
      pending.phase = "filled";
      composer.replace({ text: pending.text, mentions: [], attachments: pending.attachments });
      composer.insert([pending.mention], { at: "end", block: true });
      return;
    }
    if (composer.isSubmittingBlocked || composer.isSubmitting) return;
    pending.phase = "sending";
    const kept = pending.kept;
    const restore = () => {
      if (kept !== null && (kept.text.trim() !== "" || kept.attachments.length > 0)) composer.replace({ text: kept.text, mentions: kept.mentions, attachments: kept.attachments });
    };
    composer.submit().then(
      () => {
        restore();
        pending.done();
      },
      (error: unknown) => {
        composer.replace({ text: kept?.text ?? "", mentions: kept?.mentions ?? [], attachments: kept?.attachments ?? [] });
        pending.done(error);
      },
    );
  }, [composers, pending]);
  if (pending === null) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed -left-[9999px] top-0 h-[600px] w-[480px] opacity-0" data-testid="founder-send-host">
      <ThreadChat threadId={pending.threadId} variant="compact" />
    </div>
  );
}

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
interface Catalog {
  providers: { id: string; name: string }[];
  models: { providerId: string; id: string; name: string; reasoning: string[] }[];
}

/**
 * What the founder was asked, shown above the composer of the thread it is
 * about, so the thread they open to answer in shows the question.
 */
const BANNER_OPEN_KEY = "solo-factor.banner.open";

/** The question in full in the Reply pill; only a very long one is shortened, at a word. */
function replyLabel(question: string): string {
  const text = question.trim().replace(/\s+/g, " ");
  if (text.length <= 160) return text;
  const cut = text.slice(0, 157);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120))}…`;
}

function InboxBanner() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const refetch = useCallback(() => {
    if (threadId === null) return;
    rpc.call("state", { projectId: null }).then(
      (state) => setEntries(state.inbox.filter((entry) => entry.threadId === threadId && entry.kind !== "interaction")),
      () => undefined,
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  // Collapsed by default to one line, so it never takes the thread's space;
  // they open it when they want the detail. Remembered per entry.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(JSON.parse(localStorage.getItem(BANNER_OPEN_KEY) ?? "[]") as string[]));
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(BANNER_OPEN_KEY, JSON.stringify([...next].slice(-50)));
      return next;
    });
  if (entries.length === 0) return null;
  // A picked option goes in after the pill, as in the inbox: they can add to it, then send.
  const reply = (entry: InboxEntry, choice?: string) => {
    void rpc.call("answerRoute", { entryId: entry.id }).then(
      (route) => {
        const pill = { provider: route.provider, id: route.mentionId, label: `Reply: ${replyLabel(entry.question)}` };
        composer.insert(choice === undefined ? [pill] : [pill, ` ${choice}`], { at: "end", block: true });
        composer.focus?.();
      },
      () => undefined,
    );
  };
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="inbox-banner">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        {entries.length === 1 ? "1 question waiting for you" : `${entries.length} questions waiting for you`}
      </div>
      <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto">
        {entries.map((entry) => {
          const expanded = open.has(entry.id);
          return (
            <li key={entry.id} className={cn("px-3 py-2", expanded && "bg-muted/20")}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Hide" : "Show"} details: ${entry.question}`}
                  data-testid="inbox-banner-toggle"
                  onClick={() => toggle(entry.id)}
                >
                  <svg viewBox="0 0 16 16" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} aria-hidden="true">
                    <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="shrink-0 rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground">{KIND_LABEL[entry.kind]}</span>
                  <span className={cn("min-w-0 flex-1 text-sm font-medium", !expanded && "truncate")}>{entry.question}</span>
                </button>
                {/* Reply here: their message carries this question's pill and answers it alone. */}
                <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-xs" data-testid="inbox-banner-reply" onClick={() => reply(entry)}>
                  Reply
                </Button>
              </div>
              {expanded ? (
                <div className="ml-1.5 mt-2 space-y-2 border-l-2 border-border pl-3 text-sm">
                  {entry.context === "" ? null : <Markdown content={entry.context} className="text-sm" />}
                  {entry.options.length === 0 ? null : (
                    <div className="space-y-1.5">
                      {entry.options.map((option, index) => (
                        <Button
                          key={index}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-auto w-full justify-start gap-2 whitespace-normal py-1.5 text-left font-normal"
                          data-testid="inbox-banner-option"
                          onClick={() => reply(entry, `${String.fromCharCode(65 + index)}. ${option}`)}
                        >
                          <span className="shrink-0 font-semibold">{String.fromCharCode(65 + index)}</span>
                          <span className="min-w-0 text-sm">{option}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                  {entry.recommendation === "" ? null : <Markdown content={`**Recommendation:** ${entry.recommendation}`} className="text-sm" />}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function useFactory() {
  const rpc = useRpc<typeof rpcContract>();
  const [projectId, setProjectId] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(PROJECT_KEY),
  );
  const [state, setState] = useState<FactoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("state", { projectId }).then((next) => {
      setState(next);
      setError(null);
    }, report);
  }, [rpc, projectId, report]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  const selectProject = useCallback((id: string) => {
    localStorage.setItem(PROJECT_KEY, id);
    setProjectId(id);
  }, []);
  /** Run a mutation, then refetch; failures show in the page's error line. */
  const run = useCallback(
    (work: Promise<unknown>) => work.then(refetch, report),
    [refetch, report],
  );
  return { rpc, state, error, run, selectProject };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground";

// ------------------------------------------------------------------- inbox

const KIND_LABEL: Record<InboxEntry["kind"], string> = {
  question: "Decision",
  interaction: "Answer in the thread",
  stalled: "Stopped",
  failed: "Failed",
  blocked: "Blocked",
  check: "Not released yet",
  test: "Released",
  todo: "To do",
};

/**
 * The founder does two kinds of thing, so the inbox has two columns:
 * decisions, and founder QA (trying work before or after it is released, and
 * anything else only they can do by hand). Work that stopped or failed asks them
 * what to do next, which is a decision.
 */
const COLUMNS: { id: string; title: string; empty: string; kinds: InboxEntry["kind"][] }[] = [
  { id: "decisions", title: "Decisions", empty: "Nothing to decide.", kinds: ["question", "interaction", "stalled", "failed", "blocked"] },
  { id: "qa", title: "Founder QA", empty: "Nothing to try.", kinds: ["check", "test", "todo"] },
];

const ACCENT: Record<InboxEntry["kind"], string> = {
  question: "border-l-sky-500",
  interaction: "border-l-sky-500",
  todo: "border-l-emerald-500",
  check: "border-l-emerald-500",
  test: "border-l-emerald-500/40",
  stalled: "border-l-red-500",
  failed: "border-l-red-500",
  blocked: "border-l-red-500",
};

function ago(time: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

function ticketLink(config: Config, key: string): string | null {
  return config.ticketUrl === "" ? null : config.ticketUrl.replace("{key}", encodeURIComponent(key));
}

/** A small arrow that opens the ticket where it is tracked. */
function TicketLink({ url, ticket }: { url: string | null; ticket: string }) {
  const navigate = useBbNavigate();
  if (url === null) return null;
  return (
    <button
      type="button"
      aria-label={`Open ${ticket} in the tracker`}
      title={`Open ${ticket} in the tracker`}
      data-testid="ticket-link"
      className="shrink-0 rounded px-1 text-sm leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
      onClick={() => navigate.openUrl(url)}
    >
      ↗
    </button>
  );
}

/** How many steps an entry lists. */
const stepCount = (entry: InboxEntry) => (entry.context.match(/(^|\n)- /g) ?? []).length;

/**
 * The one line a card may carry under the ticket's title: the direction
 * itself, when it is short enough to read whole. QA that only says "try it"
 * carries none, and nothing on a card is ever cut off with an ellipsis.
 */
function direction(entry: InboxEntry, ticket: string | null, title: string | null): string {
  if (entry.kind === "check" || entry.kind === "test") return "";
  let text = entry.question.trim();
  if (ticket !== null && title !== null) text = text.replace(`${ticket} (${title}) `, "").replace(`${ticket} (${title})`, "");
  return text.length <= 90 ? text : "";
}

/** The small card: the ticket, its status, and a direction only when there is a short one. */
function InboxTile({ entry, ticket, title, active, onOpen }: { entry: InboxEntry; ticket: string | null; title: string | null; active: boolean; onOpen: () => void }) {
  const steps = stepCount(entry);
  const line = direction(entry, ticket, title);
  return (
    <li>
      <button
        type="button"
        data-testid="inbox-tile"
        aria-pressed={active}
        className={cn(
          "block w-full space-y-1 rounded-lg border border-l-[3px] border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ACCENT[entry.kind],
          active && "bg-secondary/60",
        )}
        onClick={onOpen}
      >
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono font-medium text-foreground">{ticket ?? entry.from}</span>
          <span>{KIND_LABEL[entry.kind]}</span>
          {steps === 0 ? null : <span>{steps} steps</span>}
          <span className="flex-1" />
          <span title={new Date(entry.createdAt).toLocaleString()}>{ago(entry.createdAt)}</span>
        </span>
        {title === null ? null : <span className="block text-sm font-medium leading-snug">{title}</span>}
        {/* An agent's entry has no ticket title: its question is the title, cut to two lines. */}
        {title === null ? (
          <span className="line-clamp-2 block text-sm font-medium leading-snug" data-testid="inbox-tile-question">{entry.question}</span>
        ) : line === "" ? null : (
          <span className="block text-sm leading-snug text-muted-foreground">{line}</span>
        )}
      </button>
    </li>
  );
}

/** Everything about one entry: the full text, the reply box and every action. Fills the inbox panel below its header. */
/**
 * The before/after renders a check carries, above its steps: they look at them
 * before they test, and sometimes instead (founder, 25 Nov 2026). A click opens
 * one full size.
 */
function CheckScreenshots({ entry, rpc }: { entry: InboxEntry; rpc: Rpc }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  type Shot = { name: string; url: string; hostId: string | null; hostPath: string | null };
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    if (entry.kind !== "check") return;
    let cancelled = false;
    const urls: string[] = [];
    rpc.call("checkScreenshots", { entryId: entry.id }).then(
      (attachments) =>
        Promise.all(
          attachments.map((attachment) =>
            sdk.projects.attachments.read({ projectId: entry.projectId, path: attachment.path }).then(
              (file) => {
                const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }));
                urls.push(url);
                return { name: attachment.name, url, hostId: attachment.hostId, hostPath: attachment.hostPath };
              },
              () => null,
            ),
          ),
        ).then((loaded) => {
          if (!cancelled) setShots(loaded.filter((shot): shot is Shot => shot !== null));
        }),
      () => undefined,
    );
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [entry.id, entry.kind, entry.projectId, rpc, sdk]);
  if (shots.length === 0) return null;
  // A small preview here; a click opens the full image in bb's file preview
  // beside the inbox, where they can zoom (founder, 25 Nov 2026).
  const open = (shot: Shot) => {
    const shown =
      shot.hostId !== null && shot.hostPath !== null
        ? navigate.experimental_openFilePreview({ target: { kind: "host", hostId: shot.hostId, path: shot.hostPath }, location: null, opener: IMAGE_VIEWER_ID })
        : false;
    if (!shown) window.open(shot.url, "_blank", "noopener");
  };
  return (
    <div className="flex flex-wrap gap-2" data-testid="check-screenshots">
      {shots.map((shot, index) => (
        <button
          key={shot.url}
          type="button"
          onClick={() => open(shot)}
          className="group flex items-center gap-3 overflow-hidden rounded-md border border-border bg-muted/30 p-1.5 pr-3 text-left transition-colors hover:bg-accent"
          aria-label={`Open ${index === 0 ? "the before and after image" : shot.name} beside the inbox`}
          data-testid="check-screenshot"
        >
          <img src={shot.url} alt="" className="block h-16 w-24 rounded-sm bg-background object-cover object-top" />
          <span className="text-sm">
            <span className="block font-medium">{index === 0 ? "Before and after" : shot.name}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function InboxCard({ entry, rpc, run }: { entry: InboxEntry; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const [confirmShip, setConfirmShip] = useState(false);
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const running = useRunsBeside(entry.threadId);
  const [draft, setDraft] = useReplyDraft(entry.id);
  const [uploading, setUploading] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const setAnswer = (text: string) => setDraft((current) => ({ ...current, text }));
  // Grow with the text, up to about a dozen lines, then scroll.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, 320)}px`;
  }, [draft.text]);
  const attach = (files: readonly File[]) => {
    if (files.length === 0) return;
    setUploading((count) => count + files.length);
    run(
      Promise.all(
        files.map((file) =>
          sdk.projects.attachments
            .upload({ projectId: entry.projectId, clientFile: file })
            .then((uploaded) => setDraft((current) => ({ ...current, attachments: [...current.attachments, uploaded] })))
            .finally(() => setUploading((count) => count - 1)),
        ),
      ),
    );
  };
  const ready = !isBlank(draft) && uploading === 0;
  const submit = () => {
    if (!ready) return;
    if (handoff?.entryId === entry.id) setHandoff(null);
    const { text, attachments } = draft;
    // Their words go from the thread's own composer, so they show as their. If
    // that fails, the factory sends them, so an answer is never lost.
    const delivered = rpc
      .call("answerRoute", { entryId: entry.id })
      .then((route) => sendAsFounder(route.threadId, text.trim() === "" ? "See the attached." : text, attachments, { provider: route.provider, id: route.mentionId, label: "Inbox answer" }))
      .then(
        () => true,
        (error: unknown) => {
          console.warn("[factory] inbox answer sent by the factory instead of the composer:", error instanceof Error ? error.message : error);
          return false;
        },
      );
    run(delivered.then((sent) => rpc.call("answer", { entryId: entry.id, answer: text, attachments, delivered: sent })).then(() => setDraft(() => NO_DRAFT)));
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  // Enter sends, as in bb's own composer; on a phone it is a new line and the button sends.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches) return;
    event.preventDefault();
    submit();
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    attach(files);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    attach(Array.from(event.dataTransfer.files));
  };
  const openThread = () => {
    if (!isBlank(draft)) setHandoff({ entryId: entry.id, threadId: entry.threadId, draft, tries: 0 });
    openThreadOrAgent(navigate, entry.threadId);
  };
  const urgent = entry.kind === "failed" || entry.kind === "stalled";
  const canRun = entry.threadId !== "" && (entry.kind === "todo" || entry.kind === "test" || entry.kind === "check");
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4" data-testid="inbox-entry">
      {entry.kind === "check" ? null : <p className="text-sm font-semibold leading-snug">{entry.question}</p>}
      <CheckScreenshots entry={entry} rpc={rpc} />
      {entry.context === "" ? null : <Markdown content={entry.context} className="text-sm" />}
      {entry.options.length === 0 ? null : (
        <div className="flex flex-col items-stretch gap-1.5 sm:items-start">
          {entry.options.map((option, index) => (
            <Button
              key={option}
              variant="outline"
              size="sm"
              className="h-auto min-h-10 justify-start whitespace-normal py-2 text-left sm:min-h-0 sm:py-1.5"
              onClick={() => setAnswer(option)}
            >
              <span className="mr-2 shrink-0 font-semibold">{String.fromCharCode(65 + index)}</span>
              <span className="min-w-0">{option}</span>
            </Button>
          ))}
        </div>
      )}
      {entry.recommendation === "" ? null : (
        <div className="rounded-md bg-secondary/50 px-3 py-2">
          <Markdown content={`**Recommendation:** ${entry.recommendation}`} className="text-sm" />
        </div>
      )}
      <form onSubmit={send} onDrop={onDrop} onDragOver={(event) => event.preventDefault()} className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {entry.kind === "interaction" ? null : (
          <>
            <textarea
              ref={box}
              rows={1}
              value={draft.text}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={entry.kind === "question" ? "Your decision" : entry.kind === "test" ? "Anything wrong? (goes to the builder)" : entry.kind === "todo" ? "Done? Add anything the agent should know" : entry.kind === "check" ? "What to change (sends it back to the builder)" : "Tell the agent what to do"}
              aria-label={`Answer ${entry.from}`}
              data-testid="inbox-reply"
              className="min-h-10 w-full basis-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:min-h-9 sm:text-sm"
            />
            {draft.attachments.length === 0 && uploading === 0 ? null : (
              <ul className="flex basis-full flex-wrap gap-1.5 text-xs" data-testid="inbox-attachments">
                {draft.attachments.map((file) => (
                  <li key={file.path} className="flex items-center gap-1 rounded bg-secondary px-2 py-1 text-secondary-foreground">
                    <span className="max-w-48 truncate">{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setDraft((current) => ({ ...current, attachments: current.attachments.filter((kept) => kept.path !== file.path) }))}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {uploading === 0 ? null : <li className="px-2 py-1 text-muted-foreground">Uploading…</li>}
              </ul>
            )}
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              data-testid="inbox-attach-input"
              onChange={(event) => {
                attach(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            {/* Attach sits left of Send, Dismiss right of it, as in a chat composer. */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-10 w-10 shrink-0 p-0 text-muted-foreground sm:h-8 sm:w-8"
              aria-label="Attach files"
              data-testid="inbox-attach"
              onClick={() => picker.current?.click()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </Button>
            <Button type="submit" size="sm" variant={entry.kind === "check" ? "outline" : "default"} className="h-10 flex-1 sm:h-8 sm:flex-none" disabled={!ready}>
              {entry.kind === "check" ? "Send back" : "Send"}
            </Button>
          </>
        )}
        <Button type="button" size="sm" variant="ghost" className="h-10 text-muted-foreground sm:h-8" data-testid="inbox-dismiss" onClick={() => run(rpc.call("dismiss", { entryId: entry.id }))}>
          Dismiss
        </Button>
        {entry.kind === "check" ? (
          // Shipping takes two presses, so a stray click cannot release anything.
          <Button
            type="button"
            size="sm"
            variant={confirmShip ? "destructive" : "default"}
            className="ml-auto h-10 sm:h-8"
            data-testid="inbox-approve"
            onClick={() => {
              if (confirmShip) run(rpc.call("approve", { entryId: entry.id }));
              else setConfirmShip(true);
            }}
            onBlur={() => setConfirmShip(false)}
          >
            {confirmShip ? "Press again to ship" : "Approve and ship"}
          </Button>
        ) : null}
        {entry.kind === "failed" ? (
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => run(rpc.call("retry", { entryId: entry.id }))}>
            Retry
          </Button>
        ) : null}
      </form>
      </div>
      {/* Leaving the inbox (the thread, the app) is pinned to the panel's bottom right. */}
      {!canRun && entry.threadId === "" ? null : (
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3" data-testid="inbox-panel-footer">
          {canRun ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-10 sm:h-8"
              data-testid="inbox-run"
              onClick={() => run(running.length > 0 ? stopRuns(sdk, running) : runInWorkspace(sdk, navigate, entry.threadId))}
            >
              {running.length > 0 ? "Stop" : "Run"}
            </Button>
          ) : null}
          {entry.threadId === "" ? null : (
            <Button type="button" size="sm" variant="outline" className="h-10 sm:h-8" data-testid="inbox-open-thread" onClick={openThread}>
              Open thread
            </Button>
          )}
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------- swimlanes

const STATUS_STYLE: Record<Item["status"], string> = {
  queued: "text-muted-foreground",
  running: "text-foreground",
  "needs-founder": "text-destructive",
  "with-owner": "text-foreground",
  "with-planner": "text-foreground",
  triage: "text-foreground",
  returned: "text-foreground",
  stalled: "text-destructive",
  failed: "text-destructive",
  done: "text-muted-foreground",
  archived: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};
const STATUS_LABEL: Record<Item["status"], string> = {
  queued: "Queued",
  running: "Running",
  "needs-founder": "Waiting for you",
  "with-owner": "With issue owner",
  "with-planner": "With issue owner",
  triage: "With issue owner",
  returned: "Returned to planner",
  stalled: "Stalled",
  failed: "Failed",
  done: "Done",
  archived: "Archived",
  cancelled: "Cancelled",
};

function Ticket({ item, config, rpc, run, canMoveUp = false, canMoveDown = false, draggable = false, onShowNote }: { item: Item; config: Config; rpc: Rpc; run: (work: Promise<unknown>) => void; canMoveUp?: boolean; canMoveDown?: boolean; draggable?: boolean; onShowNote?: (item: Item) => void }) {
  const navigate = useBbNavigate();
  const [dropTarget, setDropTarget] = useState(false);
  const stages = config.pipelines[item.pipeline] ?? [];
  const stageId = stages[item.stageIndex];
  const stageLabel = stageId === undefined ? "" : (config.stages[stageId]?.label ?? stageId);
  const waiting = item.status === "queued";
  const forFounder = item.status === "needs-founder";
  // A ticket held before ship for the founder's check is in its own stage.
  const shown = item.status === "done" ? "Merged" : forFounder && item.founderCheck !== null && !item.founderCheck.approved ? "Founder QA" : stageLabel;
  const note =
    waiting && item.waitingOn.length > 0
      ? `Waiting on ${item.waitingOn.join(", ")}`
      : item.status === "running" || waiting || item.status === "done" || forFounder ? "" : STATUS_LABEL[item.status];
  // The founder talks to a ticket through its issue owner, so that is the
  // thread a ticket opens. Before it has one: the thread working on it now.
  const threadId =
    item.ownerThreadId ??
    stages.filter((id) => config.stages[id]?.owner === true).map((id) => item.threads[id]).find((id) => id !== undefined) ??
    (stageId === undefined ? undefined : item.threads[stageId]) ??
    stages.map((id) => item.threads[id]).filter((id) => id !== undefined).at(-1);
  return (
    <div
      className={cn("space-y-1 rounded-md border border-border bg-card p-2.5 text-sm", draggable && "cursor-grab", dropTarget && "border-foreground")}
      data-testid="ticket"
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/factory-ticket", `${item.lane}|${item.id}`);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false);
        const [lane, id] = event.dataTransfer.getData("text/factory-ticket").split("|");
        if (!draggable || lane !== item.lane || id === undefined || id === item.id) return;
        event.preventDefault();
        run(rpc.call("reorderBefore", { itemId: id, beforeId: item.id }));
      }}
    >
      <div className="flex items-center gap-2">
        {item.working ? (
          <span className="relative flex size-2 shrink-0" aria-label="Working now" data-testid="working">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
        ) : null}
        <span className="font-mono font-medium">{item.key}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", note === "" ? "text-muted-foreground" : STATUS_STYLE[item.status])}>
          {note === "" ? shown : `${shown} · ${note}`}
        </span>
        {item.parked ? (
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground" data-testid="later">
            Later
          </span>
        ) : null}
        {item.tier === null ? null : (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" data-testid="tier">
            {item.builder === "ui" ? "UI · " : ""}Tier {item.tier}
          </span>
        )}
        <TicketLink url={ticketLink(config, item.key)} ticket={item.key} />
      </div>
      <p className="text-muted-foreground">{item.title}</p>
      {item.riders.length === 0 ? null : (
        <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="riders">
          {item.riders.map((rider) => (
            <li key={rider.key}>
              + <span className="font-mono">{rider.key}</span> {rider.title}
            </li>
          ))}
        </ul>
      )}
      {waiting ? (
        canMoveUp || canMoveDown ? (
          <div className="flex items-center justify-end gap-0.5">
            <button type="button" className="rounded px-1 text-xs leading-4 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={`Move ${item.key} earlier`} disabled={!canMoveUp} onClick={() => run(rpc.call("reorder", { itemId: item.id, direction: "up" }))}>
              ↑
            </button>
            <button type="button" className="rounded px-1 text-xs leading-4 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={`Move ${item.key} later`} disabled={!canMoveDown} onClick={() => run(rpc.call("reorder", { itemId: item.id, direction: "down" }))}>
              ↓
            </button>
          </div>
        ) : null
      ) : threadId === undefined ? null : (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => openThreadOrAgent(navigate, threadId)}>
            Open thread
          </Button>
          {forFounder ? <span className="text-xs font-medium text-destructive">Waiting for you</span> : null}
          {item.status === "done" && item.changeNote !== null && onShowNote !== undefined ? (
            <Button variant="outline" size="sm" className="h-7 px-2" data-testid="change-note" onClick={() => onShowNote(item)}>
              What changed
            </Button>
          ) : null}
          {item.status === "done" ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-muted-foreground"
              data-testid="archive-done"
              onClick={() => run(rpc.call("archiveDone", { itemId: item.id }))}
            >
              Archive
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** What a merged ticket changed, written by its last review, in a panel at the right. */
function ChangeNotePanel({ item, onClose, anchor }: { item: Item; onClose: () => void; anchor: HTMLElement | null }) {
  const note = item.changeNote!;
  // Start below bb's page header, which sits above the plugin's page: pinned
  // to the window's top, the header's rule cut through the title.
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const place = () => {
      let scroller: HTMLElement | null = anchor?.parentElement ?? null;
      while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const host = scroller ?? anchor?.parentElement ?? null;
      setTop(host === null ? 0 : Math.max(0, Math.round(host.getBoundingClientRect().top)));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const section = (label: string, text: string) => (
    <section className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      <Markdown content={text} className="text-sm" />
    </section>
  );
  return (
    <aside
      className="fixed bottom-0 right-0 z-50 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-border bg-background p-5 shadow-xl"
      style={{ top }}
      data-testid="change-note-panel"
      aria-label={`What ${item.key} changed`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-medium">{item.key}</p>
          <p className="text-base font-semibold">{item.title}</p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose} aria-label="Close">
          Close
        </Button>
      </div>
      {section("Before", note.before)}
      {section("After", note.after)}
      {section("Why", note.why)}
      <p className="mt-auto text-xs text-muted-foreground">
        Written by {note.by} on {new Date(note.at).toLocaleDateString(undefined, { day: "numeric", month: "long" })}.
      </p>
    </aside>
  );
}

function Swimlanes({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const open = state.items.filter((item) => item.status !== "done" && item.status !== "archived" && item.status !== "cancelled");
  // Merged, with a workspace the founder has not archived yet.
  const finished = state.items.filter((item) => item.status === "done");
  const lanes = [...new Set([...open, ...finished].map((item) => item.lane))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // Only waiting tickets move, and only among the waiting tickets of their lane.
  const moves = (item: Item) => {
    const queue = open.filter((other) => other.lane === item.lane && other.status === "queued" && !other.parked);
    const index = queue.findIndex((other) => other.id === item.id);
    if (item.parked || index === -1) return { canMoveUp: false, canMoveDown: false, draggable: false };
    return { canMoveUp: index > 0, canMoveDown: index < queue.length - 1, draggable: queue.length > 1 };
  };
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const noteItem = noteFor === null ? undefined : state.items.find((item) => item.id === noteFor);
  const card = (item: Item) => <Ticket key={item.id} item={item} config={state.config} rpc={rpc} run={run} onShowNote={(shown) => setNoteFor(shown.id)} {...moves(item)} />;
  if (lanes.length === 0) {
    return <Empty>No tickets yet. Lanes fill from the swimlane schedule.</Empty>;
  }
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const notePanel = noteItem?.changeNote == null ? null : <ChangeNotePanel item={noteItem} onClose={() => setNoteFor(null)} anchor={anchor} />;
  return (
    <>
      <span ref={setAnchor} hidden />
      {notePanel}
      {/* Phones: one card per lane, tickets stacked in order. */}
      <div className="space-y-3 md:hidden">
        {lanes.map((lane) => (
          <div key={lane} className="space-y-2 rounded-lg border border-border p-3" data-testid="lane-card">
            <div className="text-sm font-medium">{lane}</div>
            {open.filter((item) => item.lane === lane).map(card)}
            {finished.some((item) => item.lane === lane) ? <div className="pt-1 text-xs font-medium text-muted-foreground">Done</div> : null}
            {finished.filter((item) => item.lane === lane).map(card)}
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full min-w-[760px] table-fixed border-collapse text-left align-top">
          <thead className="bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="w-24 px-3 py-2 font-medium">Track</th>
              <th className="px-3 py-2 font-medium">Next up</th>
              <th className="px-3 py-2 font-medium">In Progress</th>
              <th className="px-3 py-2 font-medium">Done</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane) => {
              const inLane = open.filter((item) => item.lane === lane);
              // "In Progress" is the ticket in flight; a lane with only waiting tickets has none.
              const head = inLane.find((item) => item.status !== "queued");
              return (
                <tr key={lane} className="border-t border-border align-top" data-testid="lane">
                  <td className="px-3 py-3 text-sm font-medium">{lane}</td>
                  <td className="space-y-2 px-3 py-3">{inLane.filter((item) => item !== head).map(card)}</td>
                  <td className="px-3 py-3" data-testid="in-progress-column">{head === undefined ? null : card(head)}</td>
                  <td className="space-y-2 px-3 py-3" data-testid="done-column">{finished.filter((item) => item.lane === lane).map(card)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// -------------------------------------------------------------------- roles

function Roles({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const [catalog, setCatalog] = useState<Catalog>({ providers: [], models: [] });
  const projectId = state.projectId;
  useEffect(() => {
    if (projectId === null) return;
    rpc.call("catalog", { projectId }).then(setCatalog, () => undefined);
  }, [rpc, projectId]);
  if (projectId === null) return null;
  const save = (config: Config) => run(rpc.call("saveConfig", { projectId, config }));
  const setRole = (id: string, patch: Partial<Role>) =>
    save({ ...state.config, roles: { ...state.config.roles, [id]: { ...state.config.roles[id]!, ...patch } } });
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead className="bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Thinking</th>
              <th className="px-3 py-2 font-medium">If its limit runs out</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(state.config.roles).map(([id, role]) => {
              const models = catalog.models.filter((model) => role.providerId === "" || model.providerId === role.providerId);
              const reasoning = models.find((model) => model.id === role.model)?.reasoning ?? [];
              // Keep a saved value selectable even when the catalog does not list it.
              const withCurrent = (values: string[], current: string) =>
                current === "" || values.includes(current) ? values : [current, ...values];
              return (
                <tr key={id} className="border-t border-border" data-testid="role">
                  <td className="px-3 py-2">
                    <div className="font-medium">{role.label}</div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className={cn(selectClass, "w-56")}
                      aria-label={`${role.label} model`}
                      value={role.model === "" ? "" : `${role.providerId}|${role.model}`}
                      onChange={(e) => {
                        const [providerId = "", model = ""] = e.target.value.split("|");
                        setRole(id, { providerId, model, reasoningLevel: "" });
                      }}
                    >
                      <option value="">Project default</option>
                      {role.model !== "" && !catalog.models.some((m) => m.providerId === role.providerId && m.id === role.model) ? (
                        <option value={`${role.providerId}|${role.model}`}>{role.model}</option>
                      ) : null}
                      {catalog.providers.map((provider) => (
                        <optgroup key={provider.id} label={provider.name}>
                          {catalog.models
                            .filter((m) => m.providerId === provider.id)
                            .map((m) => (
                              <option key={m.id} value={`${provider.id}|${m.id}`}>
                                {m.name}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select className={cn(selectClass, "w-24")} aria-label={`${role.label} thinking`} value={role.reasoningLevel} onChange={(e) => setRole(id, { reasoningLevel: e.target.value })}>
                      <option value="">Default</option>
                      {withCurrent(reasoning, role.reasoningLevel).map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className={cn(selectClass, "w-56")}
                      aria-label={`${role.label} fallback`}
                      value={role.fallbackModel === "" ? "" : `${role.fallbackProviderId || role.providerId}|${role.fallbackModel}`}
                      onChange={(e) => {
                        const [providerId = "", model = ""] = e.target.value.split("|");
                        setRole(id, {
                          fallbackProviderId: model === "" || providerId === role.providerId ? "" : providerId,
                          fallbackModel: model,
                          fallbackReasoningLevel: "",
                        });
                      }}
                    >
                      <option value="">Ask me</option>
                      {role.fallbackModel !== "" &&
                      !catalog.models.some((m) => m.providerId === (role.fallbackProviderId || role.providerId) && m.id === role.fallbackModel) ? (
                        <option value={`${role.fallbackProviderId || role.providerId}|${role.fallbackModel}`}>
                          {role.fallbackModel}
                        </option>
                      ) : null}
                      {catalog.providers.map((provider) => (
                        <optgroup key={provider.id} label={provider.name}>
                          {catalog.models
                            .filter((m) => m.providerId === provider.id && !(provider.id === role.providerId && m.id === role.model))
                            .map((m) => (
                              <option key={m.id} value={`${provider.id}|${m.id}`}>
                                {m.name}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- agents

function Agents({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const navigate = useBbNavigate();
  const projectId = state.projectId;
  if (projectId === null) return null;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {Object.entries(state.config.agents).map(([agentId, agent]) => {
        const live = state.agents.find((candidate) => candidate.agentId === agentId);
        const threadId = live?.threadId ?? null;
        const memory = state.memoryFiles.find((file) => file.agentId === agentId);
        return (
          <li key={agentId} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm" data-testid="agent">
            <div className="min-w-40 flex-1">
              <div className="font-medium">{agent.label}</div>
              <div className="text-xs text-muted-foreground">
                {threadId === null
                  ? "Not started"
                  : live?.rotating === true
                    ? "Writing its handoff; a fresh thread starts when it finishes"
                    : `Running since ${new Date(live?.startedAt ?? 0).toLocaleDateString()}`}
              </div>
            </div>
            {memory === undefined ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigate.experimental_openFilePreview({ target: { kind: "host", hostId: memory.hostId, path: memory.path }, location: null })}
              >
                Memory
              </Button>
            )}
            {threadId === null ? (
              <Button size="sm" onClick={() => run(rpc.call("startAgent", { projectId, agentId }))}>
                Start
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => openThreadOrAgent(navigate, threadId)}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Fresh thread: have it write its memory, then replace it"
                  disabled={live?.rotating === true}
                  onClick={() => run(rpc.call("rotateAgent", { projectId, agentId }))}
                >
                  Fresh thread
                </Button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// --------------------------------------------------------------------- page

/** The frame every Factory page shares: a title, the page's own controls, and what went wrong if anything did. */
function Page({ title, width, error, aside, children }: { title: string; width: string; error: string | null; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto box-border w-full space-y-5 px-4 pb-10 pt-4 md:px-6 md:pt-6", width)}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex-1 text-xl font-semibold tracking-tight">{title}</h1>
          {aside}
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

function ProjectPicker({ state, selectProject }: { state: FactoryState; selectProject: (id: string) => void }) {
  if (state.projects.length < 2) return null;
  return (
    <select aria-label="Project" className={selectClass} value={state.projectId ?? ""} onChange={(e) => selectProject(e.target.value)}>
      {state.projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}

const Loading = ({ error }: { error: string | null }) => <div className="p-5 text-sm text-muted-foreground">{error ?? "Loading the factory…"}</div>;

/**
 * The inbox panel's width, dragged from its left edge and remembered. Arrow
 * keys move the edge too, and a double-click puts it back.
 */
function usePanelWidth() {
  const [width, setWidth] = useState(() => {
    const saved = typeof localStorage === "undefined" ? NaN : Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : PANEL_DEFAULT;
  });
  const clamp = (next: number, panel: HTMLElement | null) => {
    const room = panel?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.round(Math.max(PANEL_MIN, Math.min(next, room - LIST_MIN)));
  };
  const save = (next: number) => {
    setWidth(next);
    localStorage.setItem(PANEL_WIDTH_KEY, String(next));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const panel = handle.parentElement;
    const startX = event.clientX;
    const startWidth = panel?.getBoundingClientRect().width ?? width;
    handle.setPointerCapture(event.pointerId);
    const body = document.body.style;
    const before = { cursor: body.cursor, userSelect: body.userSelect };
    body.cursor = "col-resize";
    body.userSelect = "none";
    let latest = startWidth;
    const move = (moved: PointerEvent) => {
      latest = clamp(startWidth + (startX - moved.clientX), panel);
      setWidth(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      body.cursor = before.cursor;
      body.userSelect = before.userSelect;
      save(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (delta === 0) return;
    event.preventDefault();
    save(clamp(width + delta, event.currentTarget.parentElement));
  };
  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      data-testid="inbox-panel-resize"
      className="group absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-col-resize touch-none outline-none lg:block"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => save(clamp(PANEL_DEFAULT, null))}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
  return { width, handle };
}

function InboxPage() {
  const { rpc, state, error, run } = useFactory();
  const panel = usePanelWidth();
  // Which entry is open is remembered for this page alone, so the panel is
  // as they left it when they come back from a thread or another page.
  const [openId, setOpen] = useState<string | null>(() => (typeof localStorage === "undefined" ? null : localStorage.getItem(OPEN_KEY)));
  const setOpenId = useCallback((id: string | null) => {
    if (id === null) localStorage.removeItem(OPEN_KEY);
    else localStorage.setItem(OPEN_KEY, id);
    setOpen(id);
  }, []);
  // The inbox in reading order, as last drawn: when the open entry is dealt
  // with, the panel moves to the one after it instead of closing.
  const order = useRef<string[]>([]);
  const appPanel = experimental_useAppPanel();
  const pluginId = experimental_usePluginId();
  const ids = state === null ? null : COLUMNS.flatMap((column) => state.inbox.filter((entry) => column.kinds.includes(entry.kind)).map((entry) => entry.id));
  useEffect(() => {
    if (ids === null) return;
    if (openId !== null && !ids.includes(openId)) {
      const was = order.current.indexOf(openId);
      const after = was === -1 ? [] : [...order.current.slice(was + 1), ...order.current.slice(0, was).reverse()];
      setOpenId(after.find((id) => ids.includes(id)) ?? null);
      // They dealt with it: the files they had open beside it (a before/after
      // image, a plan) close, tabs and all, and so does the panel. A terminal
      // such as Run stays open (founder, 25 Nov 2026).
      const tabs = appPanel.getTabs();
      // A check image opens in the factory's own viewer, a plugin tab.
      const files = tabs.tabs.filter((tab) => tab.detail.kind === "file" || (tab.detail.kind === "plugin" && tab.detail.pluginId === pluginId));
      for (const tab of files) appPanel.closeTab(tab.key);
      const rest = appPanel.getTabs();
      if (files.length > 0 && rest.open && !rest.tabs.some((tab) => tab.detail.kind === "terminal")) appPanel.close();
    }
    order.current = ids;
  }, [ids?.join("|"), openId, setOpenId, appPanel, pluginId]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpenId]);
  if (state === null) return <Loading error={error} />;
  const itemOf = (entry: InboxEntry) => state.items.find((candidate) => candidate.id === entry.itemId);
  // An entry that was answered, approved or dismissed is gone, and its panel with it.
  const open = state.inbox.find((entry) => entry.id === openId) ?? null;
  const openItem = open === null ? undefined : itemOf(open);
  const openSteps = open === null ? 0 : stepCount(open);
  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className={cn("min-w-0 flex-1", open !== null && "hidden lg:block")}>
        <Page title="Inbox" width={open === null ? "max-w-5xl" : "max-w-xl"} error={error} aside={<span className="text-sm text-muted-foreground">{state.inbox.length === 0 ? "Nothing needs you" : `${state.inbox.length} waiting`}</span>}>
          <div className={cn("grid gap-6", open === null && "lg:grid-cols-2")}>
            {COLUMNS.map((column) => {
              const entries = state.inbox.filter((entry) => column.kinds.includes(entry.kind));
              return (
                <section key={column.id} className="space-y-2" data-testid={`inbox-column-${column.id}`}>
                  <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {column.title}
                    {entries.length === 0 ? null : <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-secondary-foreground">{entries.length}</span>}
                  </h2>
                  {entries.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-sm text-muted-foreground">{column.empty}</p>
                  ) : (
                    <ul className="space-y-2">
                      {entries.map((entry) => (
                        <InboxTile
                          key={entry.id}
                          entry={entry}
                          ticket={itemOf(entry)?.key ?? null}
                          title={itemOf(entry)?.title ?? null}
                          active={entry.id === openId}
                          onOpen={() => setOpenId(entry.id === openId ? null : entry.id)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </Page>
      </div>
      {open === null ? null : (
        <aside
          className="relative flex h-full min-h-0 w-full flex-col border-l border-border bg-background lg:w-[var(--panel-width)] lg:shrink-0"
          style={{ "--panel-width": `${panel.width}px` } as CSSProperties}
          data-testid="inbox-panel"
        >
          {panel.handle}
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono font-medium text-foreground">{openItem?.key ?? open.from}</span>
                <span>{KIND_LABEL[open.kind]}</span>
                {openSteps === 0 ? null : <span>{openSteps} steps</span>}
                <span>{ago(open.createdAt)}</span>
              </p>
              {openItem === undefined ? null : <h2 className="text-base font-semibold leading-snug">{openItem.title}</h2>}
            </div>
            <button type="button" aria-label="Close" className="rounded px-1.5 text-lg leading-none text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => setOpenId(null)}>
              ×
            </button>
          </div>
          <InboxCard key={open.id} entry={open} rpc={rpc} run={run} />
        </aside>
      )}
    </div>
  );
}

function SwimlanesPage() {
  const { rpc, state, error, run, selectProject } = useFactory();
  if (state === null) return <Loading error={error} />;
  return (
    <Page title="Swimlanes" width="max-w-6xl" error={error} aside={<ProjectPicker state={state} selectProject={selectProject} />}>
      {state.projectId === null ? <Empty>Add a project to bb to start a factory.</Empty> : <Swimlanes state={state} rpc={rpc} run={run} />}
    </Page>
  );
}

function OtherSettings({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const [chime, setChime] = useState(chimeOn);
  const [ticketUrl, setTicketUrl] = useState(state.config.ticketUrl);
  const { projectId } = state;
  const saveUrl = () => {
    if (projectId === null || ticketUrl.trim() === state.config.ticketUrl) return;
    run(rpc.call("saveConfig", { projectId, config: { ...state.config, ticketUrl: ticketUrl.trim() } }));
  };
  return (
    <div className="space-y-4 rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={chime}
            onChange={(event) => {
              localStorage.setItem(CHIME_KEY, event.target.checked ? "on" : "off");
              setChime(event.target.checked);
            }}
          />
          Chime when something arrives in the inbox
        </label>
        <button type="button" className="text-xs text-muted-foreground underline" onClick={playChime}>
          Hear it
        </button>
      </div>
      <label className="block space-y-1">
        <span>Link for a ticket</span>
        <input
          className="block w-full max-w-xl rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none focus-visible:border-ring"
          value={ticketUrl}
          placeholder="https://linear.app/your-team/issue/{key}"
          data-testid="ticket-url"
          onChange={(event) => setTicketUrl(event.target.value)}
          onBlur={saveUrl}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveUrl();
          }}
        />
        <span className="block text-xs text-muted-foreground">Where the arrow on a ticket goes. {"{key}"} becomes the ticket's number.</span>
      </label>
    </div>
  );
}

function SettingsPage() {
  const { rpc, state, error, run, selectProject } = useFactory();
  if (state === null) return <Loading error={error} />;
  return (
    <Page title="Factory settings" width="max-w-5xl" error={error} aside={<ProjectPicker state={state} selectProject={selectProject} />}>
      {state.projectId === null ? (
        <Empty>Add a project to bb to start a factory.</Empty>
      ) : (
        <>
          <Section title="Agents">
            <Agents state={state} rpc={rpc} run={run} />
          </Section>
          <Section title="Who plays each role">
            <Roles state={state} rpc={rpc} run={run} />
          </Section>
          <Section title="Other settings">
            <OtherSettings state={state} rpc={rpc} run={run} />
          </Section>
        </>
      )}
    </Page>
  );
}

/** Rail badge: how many things are waiting on the founder. */
// ------------------------------------------------------------------ agents
// The standing agents get their own place in the rail (founder, 22 November):
// a list of agents beside it, and the chosen agent's conversation, so they can
// go between the inbox, the swimlanes and the agents without the thread list.

const AGENT_ORDER = ["orchestrator", "watch", "deploy", "integrator", "harness-improver", "cleaner"];
const AGENT_KEY = "solo-factor.agents.open";

function useAgents() {
  const { rpc, state, error, run } = useFactory();
  const { threads } = experimental_useSidebarThreads();
  const agents = useMemo(() => {
    if (state === null) return [];
    // Their own order first (dragged in the Agents list), then the default order.
    const rank = (id: string) => {
      const mine = state.config.agentOrder.indexOf(id);
      return mine !== -1 ? mine : 100 + (AGENT_ORDER.indexOf(id) + 1 || 99);
    };
    const ids = Object.keys(state.config.agents).sort((a, b) => rank(a) - rank(b));
    return ids.map((agentId) => {
      const threadId = state.agents.find((agent) => agent.agentId === agentId)?.threadId ?? null;
      const thread: PluginSidebarThread | undefined = threadId === null ? undefined : threads.find((candidate) => candidate.id === threadId);
      return { agentId, label: state.config.agents[agentId]!.label, threadId, thread };
    });
  }, [state, threads]);
  return { rpc, state, error, run, agents };
}

function selectedAgent(subPath: string, agentIds: string[]): string | undefined {
  const fromPath = decodeURIComponent(subPath.split("/")[0] ?? "");
  if (agentIds.includes(fromPath)) return fromPath;
  const remembered = typeof localStorage === "undefined" ? null : localStorage.getItem(AGENT_KEY);
  if (remembered !== null && agentIds.includes(remembered)) return remembered;
  return agentIds[0];
}

function AgentsSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const { agents, state, rpc, run } = useAgents();
  const current = selectedAgent(subPath, agents.map((agent) => agent.agentId));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Drop one agent before another; the order is saved with the factory, so
  // every device shows it.
  const reorder = (moved: string, before: string) => {
    if (state === null || state.projectId === null || moved === before) return;
    const ids = agents.map((agent) => agent.agentId).filter((id) => id !== moved);
    ids.splice(ids.indexOf(before), 0, moved);
    run(rpc.call("saveConfig", { projectId: state.projectId, config: { ...state.config, agentOrder: ids } }));
  };
  return (
    <nav className="flex flex-col gap-0.5 p-2" aria-label="Agents" data-testid="agents-sidebar">
      {agents.map((agent) => {
        const active = agent.agentId === current;
        const unread = agent.thread?.isUnread === true && !active;
        const status = agent.thread?.status;
        return (
          <button
            key={agent.agentId}
            type="button"
            draggable
            data-testid="agent-row"
            aria-current={active ? "page" : undefined}
            onDragStart={(event) => {
              event.dataTransfer.setData("text/factory-agent", agent.agentId);
              event.dataTransfer.effectAllowed = "move";
              setDragging(agent.agentId);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              setOver(agent.agentId);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const moved = event.dataTransfer.getData("text/factory-agent") || dragging;
              setDragging(null);
              setOver(null);
              if (moved) reorder(moved, agent.agentId);
            }}
            className={cn(
              "flex h-8 cursor-grab items-center gap-2 rounded-md border-l-2 px-2 text-left text-sm hover:bg-state-hover",
              active ? "border-foreground bg-state-selected font-medium text-foreground" : "border-transparent text-muted-foreground",
              unread && "font-semibold text-foreground",
              dragging === agent.agentId && "opacity-50",
              over === agent.agentId && dragging !== agent.agentId && "shadow-[inset_0_2px_0_0_currentColor]",
            )}
            onClick={() => {
              localStorage.setItem(AGENT_KEY, agent.agentId);
              navigate.toPluginPanel("factory-agents", { subPath: agent.agentId });
            }}
          >
            <span className="min-w-0 flex-1 truncate">{agent.label}</span>
            {status === "active" ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-label="Working" /> : null}
            {status === "error" ? <span className="size-2 shrink-0 rounded-full bg-destructive" aria-label="Stopped on an error" /> : null}
            {unread ? <span className="size-2 shrink-0 rounded-full bg-foreground" aria-label="Unread" /> : null}
          </button>
        );
      })}
    </nav>
  );
}

function AgentsPage({ subPath }: PluginNavPanelProps) {
  const sdk = useSdk();
  const { rpc, state, error, run, agents } = useAgents();
  const agentId = selectedAgent(subPath, agents.map((agent) => agent.agentId));
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  // Reading the conversation here counts as reading it, as opening the thread would.
  const unread = agent?.thread?.isUnread === true;
  useEffect(() => {
    if (agent?.threadId == null || !unread) return;
    void sdk.threads.markRead({ threadId: agent.threadId }).catch(() => undefined);
  }, [sdk, agent?.threadId, unread]);
  useEffect(() => {
    if (agentId !== undefined) localStorage.setItem(AGENT_KEY, agentId);
  }, [agentId]);
  if (state === null) return <Loading error={error} />;
  if (agent === undefined) return <Empty>No standing agents in this project.</Empty>;
  if (agent.threadId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p>{agent.label} has not started yet.</p>
        <Button size="sm" onClick={() => run(rpc.call("startAgent", { projectId: state.projectId!, agentId: agent.agentId }))}>
          Start {agent.label}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <AgentSwitcher agents={agents} current={agent.agentId} />
      <ThreadChat key={agent.threadId} threadId={agent.threadId} variant="full" permissionPolicy="editable" className="min-h-0 flex-1" />
    </div>
  );
}

/** On a phone the agent list is in the drawer, so the page carries its own row of agents. */
function AgentSwitcher({ agents, current }: { agents: ReturnType<typeof useAgents>["agents"]; current: string }) {
  const navigate = useBbNavigate();
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5 [scrollbar-width:none] md:hidden" data-testid="agent-switcher">
      {agents.map((agent) => {
        const active = agent.agentId === current;
        const unread = agent.thread?.isUnread === true && !active;
        return (
          <button
            key={agent.agentId}
            type="button"
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm",
              active ? "border-foreground text-foreground" : "border-border text-muted-foreground",
              unread && "font-semibold text-foreground",
            )}
            onClick={() => {
              localStorage.setItem(AGENT_KEY, agent.agentId);
              navigate.toPluginPanel("factory-agents", { subPath: agent.agentId });
            }}
          >
            {agent.label}
            {agent.thread?.status === "active" ? <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-label="Working" /> : null}
            {unread ? <span className="size-1.5 rounded-full bg-foreground" aria-label="Unread" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function useAgentsBadge() {
  const { agents } = useAgents();
  const unread = agents.filter((agent) => agent.thread?.isUnread === true).length;
  if (unread > 0) return { count: unread, label: `${unread} agent${unread === 1 ? "" : "s"} with unread messages` };
  // A green dot while an agent works (founder, 25 Nov 2026); WORKING_DOT_CSS colours it.
  const working = agents.filter((agent) => agent.thread?.status === "active").length;
  return working === 0 ? null : { label: `${working} agent${working === 1 ? "" : "s"} working` };
}

/** A green dot on Swimlanes while tickets are moving through their stages. */
function useSwimlanesBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [moving, setMoving] = useState(0);
  const refetch = useCallback(() => {
    rpc.call("state", { projectId: typeof localStorage === "undefined" ? null : localStorage.getItem(PROJECT_KEY) }).then(
      (state) => setMoving(state.items.filter((item) => item.status === "running").length),
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  return moving === 0 ? null : { label: `${moving} ticket${moving === 1 ? "" : "s"} moving` };
}

/**
 * Which threads are standing agents', kept current for links that open a
 * thread: a link to an agent's thread opens the Agents page on that agent
 * instead (founder, 22 November 2026). It used to watch the route and
 * redirect, which trapped them on Agents when Home reopened an agent's thread
 * (23 November); now only the Factory's own links decide.
 */
const agentThreads = new Map<string, string>();
function AgentThreadIndex() {
  const rpc = useRpc<typeof rpcContract>();
  const refetch = useCallback(() => {
    rpc.call("state", { projectId: null }).then(
      (state) => {
        agentThreads.clear();
        for (const agent of state.agents) if (agent.threadId !== null) agentThreads.set(agent.threadId, agent.agentId);
      },
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  return null;
}

function openThreadOrAgent(navigate: ReturnType<typeof useBbNavigate>, threadId: string) {
  const agentId = agentThreads.get(threadId);
  if (agentId !== undefined) navigate.toPluginPanel("factory-agents", { subPath: agentId });
  else navigate.toThread(threadId);
}

function useInboxBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  const refetch = useCallback(() => {
    rpc.call("state", { projectId: null }).then(
      (state) => setCount(state.inbox.length),
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  return count === 0 ? null : { count, label: `${count} waiting on you`, tone: "warning" as const };
}

/**
 * bb clips every mention pill to one line. A Reply pill names the question it
 * answers, so ours wrap instead and show the whole question (founder, 24 Nov 2026).
 */
const REPLY_PILL_CSS = `
/* bb draws badge dots in grey or amber only; working and moving are green. */
button[aria-label^="Swimlanes,"][aria-label$=" moving"] [data-nav-rail-badge] span,
button[aria-label^="Swimlanes,"][aria-label$=" moving"] [data-nav-rail-badge]:empty,
button[aria-label^="Agents,"][aria-label$=" working"] [data-nav-rail-badge] span,
button[aria-label^="Agents,"][aria-label$=" working"] [data-nav-rail-badge]:empty { background: #10b981 !important; }
.prompt-mention-pill[data-prompt-mention-resource*='"pluginId":"solo-factor"'] { border-radius: 0.5rem; white-space: normal; }
.prompt-mention-pill[data-prompt-mention-resource*='"pluginId":"solo-factor"'] .truncate { overflow: visible; text-overflow: clip; white-space: normal; }
`;
function ReplyPillStyle() {
  return <style data-solo-factor-reply-pill="">{REPLY_PILL_CSS}</style>;
}

/**
 * Check images open in bb's file panel with this viewer: it fits the panel's
 * width, then zooms in place (the + and − buttons, pinch or Ctrl/⌘-scroll
 * around the pointer, double-click) and pans by dragging. bb's own preview only
 * opens a lightbox that shrinks a tall sheet to fit (founder, 25 Nov 2026).
 */
const IMAGE_VIEWER_ID = "check-image";
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

function ImageViewer({ path, source }: PluginFileOpenerProps) {
  const sdk = useSdk();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(1);
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    const hostId = source.experimental_hostId;
    const read = hostId
      ? sdk.files.read({ hostId, rootPath: path.slice(0, path.lastIndexOf("/")) || "/", path })
      : Promise.reject(new Error("no host"));
    read.then(
      (file) => {
        if (cancelled) return;
        const bytes = file.contentEncoding === "utf8" ? new TextEncoder().encode(file.content) : Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
        const type = path.toLowerCase().endsWith(".png") ? "image/png" : path.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
        revoke = URL.createObjectURL(new Blob([bytes], { type }));
        setUrl(revoke);
      },
      () => setFailed(true),
    );
    return () => {
      cancelled = true;
      if (revoke !== null) URL.revokeObjectURL(revoke);
    };
  }, [path, sdk, source.experimental_hostId]);
  /** Zoom to `next`, keeping the point under (x, y) — panel coordinates — where it is. */
  const zoomTo = useCallback((next: number, x?: number, y?: number) => {
    const el = box.current;
    const clamped = Math.min(8, Math.max(1, next));
    if (el === null) return setScale(clamped);
    const px = x ?? el.clientWidth / 2;
    const py = y ?? el.clientHeight / 2;
    setScale((current) => {
      const ratio = clamped / current;
      const left = (el.scrollLeft + px) * ratio - px;
      const top = (el.scrollTop + py) * ratio - py;
      requestAnimationFrame(() => el.scrollTo({ left, top }));
      return clamped;
    });
  }, []);
  const step = (direction: 1 | -1) => {
    const next = direction > 0 ? ZOOM_STEPS.find((s) => s > scale + 0.01) ?? 8 : [...ZOOM_STEPS].reverse().find((s) => s < scale - 0.01) ?? 1;
    zoomTo(next);
  };
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    // Pinch on a trackpad arrives as a wheel event with ctrlKey.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      setScale((current) => {
        const next = Math.min(8, Math.max(1, current * Math.exp(-event.deltaY * 0.01)));
        const ratio = next / current;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const left = (el.scrollLeft + px) * ratio - px;
        const top = (el.scrollTop + py) * ratio - py;
        requestAnimationFrame(() => el.scrollTo({ left, top }));
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [url]);
  if (failed) return <div className="p-4 text-sm text-muted-foreground">This image could not be opened.</div>;
  if (url === null) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="check-image-viewer">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-background/90 p-1 shadow-sm">
        <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Zoom out" disabled={scale <= 1} onClick={() => step(-1)}>−</Button>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground" data-testid="check-image-zoom">{Math.round(scale * 100)}%</span>
        <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Zoom in" disabled={scale >= 8} onClick={() => step(1)}>+</Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label="Fit to width" disabled={scale === 1} onClick={() => zoomTo(1)}>Fit</Button>
      </div>
      <div
        ref={box}
        className={cn("min-h-0 flex-1 overflow-auto", scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
        data-testid="check-image-scroll"
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          zoomTo(scale < 2 ? 2.5 : 1, event.clientX - rect.left, event.clientY - rect.top);
        }}
        onPointerDown={(event) => {
          if (scale <= 1 || event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start === null) return;
          event.currentTarget.scrollTo({ left: start.left - (event.clientX - start.x), top: start.top - (event.clientY - start.y) });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img src={url} alt="" draggable={false} className="block h-auto max-w-none select-none" style={{ width: `${scale * 100}%` }} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({ id: IMAGE_VIEWER_ID, title: "Zoomable image", extensions: [], component: ImageViewer });
  app.slots.experimental_appOverlay({ id: "reply-pill-style", component: ReplyPillStyle });
  app.slots.experimental_appOverlay({ id: "inbox-chime", component: InboxChime });
  app.slots.experimental_appOverlay({ id: "run-watch", component: RunWatch });
  app.slots.experimental_appOverlay({ id: "draft-handoff", component: DraftHandoff });
  app.slots.experimental_appOverlay({ id: "founder-send", component: FounderSendHost });
  app.slots.experimental_appOverlay({ id: "agent-thread-index", component: AgentThreadIndex });
  app.composer.customize({ id: "inbox", scopes: ["thread"], banners: [{ id: "waiting", chrome: "bare", component: InboxBanner }] });
  app.contentScripts.register({
    id: "run-marks",
    mount(context) {
      const setter = context.experimental_setThreadRowStatus;
      if (setter === undefined) return;
      setRowStatus = setter;
      syncMarks();
      return () => {
        if (setRowStatus !== setter) return;
        for (const threadId of marked) setter(threadId, null);
        marked.clear();
        setRowStatus = null;
      };
    },
  });
  app.slots.navPanel({ id: "factory", title: "Inbox", icon: "Mail", path: "factory", component: InboxPage, experimental_useBadge: useInboxBadge });
  app.slots.navPanel({ id: "factory-lanes", title: "Swimlanes", icon: "Workflow", path: "factory-lanes", component: SwimlanesPage, experimental_useBadge: useSwimlanesBadge });
  app.slots.navPanel({ id: "factory-agents", title: "Agents", icon: "Bot", path: "factory-agents", component: AgentsPage, experimental_sidebar: AgentsSidebar, experimental_useBadge: useAgentsBadge });
  app.slots.navPanel({ id: "factory-settings", title: "Factory settings", icon: "SlidersHorizontal", path: "factory-settings", component: SettingsPage });
});
