#!/usr/bin/env node
// Screenshots of the real pages with a believable project in them, for the
// marketplace listing and the docs. The pages are the plugin's own; the
// tickets are sample data (the same story as docs/index.html).
//
//   node scripts/live-check.mjs --keep     # leaves a throwaway bb at :38990
//   node scripts/demo-shots.mjs            # reseeds it and writes docs/assets/screen-inbox.png and screen-swimlanes.png
//   kill -- -<pid printed by the live check>
//
// Like the live check, this never touches your real bb and uses the free echo model.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, ".context", "live");
const PORT = 38990;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_CLI"].includes(key))),
  BB_SERVER_URL: `http://127.0.0.1:${PORT}`,
  BB_DATA_DIR: join(work, "data"),
  BB_HOST_DAEMON_PORT: "38991",
};
const bbBin = join(root, "node_modules", ".bin", "bb");
const bb = (args, extra = {}) => execFileSync(bbBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...extra }, cwd: join(work, "repo") }).trim();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = read(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the factory.");
    await sleep(400);
  }
}

const project = JSON.parse(bb(["project", "list", "--json"])).find((entry) => ["Live check", "acme-store"].includes(entry.name))?.id;
if (!project) throw new Error("No kept live-check server found. Run: node scripts/live-check.mjs --keep");
bb(["project", "update", project, "--name", "acme-store"]);
const fx = (args, as) => bb(["solo-factor", ...args, "--project", project], as ? { BB_THREAD_ID: as, BB_PROJECT_ID: project } : {});
const status = () => JSON.parse(fx(["status", "--json"]));
const ticket = (key) => status().items.find((item) => item.key === key && !["cancelled", "archived"].includes(item.status));

// Clear what the live check left behind. Cancelling a ticket can free a small
// bug that was riding with it, so repeat until nothing is left.
function clear() {
  for (let pass = 0; pass < 6; pass += 1) {
    const left = status().items.filter((item) => !["cancelled", "archived"].includes(item.status));
    if (left.length === 0) break;
    for (const item of left) { try { fx([item.status === "done" ? "archive" : "cancel", item.key]); } catch { /* gone */ } }
  }
  // An agent's own question can only be closed by that agent; answering it clears it too.
  for (const entry of status().inbox) { try { fx(["close", entry.id]); } catch { try { fx(["answer", entry.id, "Yes."]); } catch { /* already closed */ } } }
}
clear();

// A before/after image for the founder's check: two order summaries.
function findBrowser() {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const cached = existsSync(cache)
    ? readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()
        .flatMap((name) => readdirSync(join(cache, name)).map((dir) => join(cache, name, dir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")))
    : [];
  return [...cached, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => existsSync(path)) ?? null;
}
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: findBrowser() });
const out = join(root, "docs", "assets");
mkdirSync(out, { recursive: true });
const beforeAfter = join(work, "demo-before-after.png");
{
  const page = await browser.newPage({ viewport: { width: 640, height: 300 }, deviceScaleFactor: 2 });
  const receipt = (label, rows, note) => `<div class="p"><small>${label}</small>${rows.map(([a, b, cls]) => `<div class="r ${cls ?? ""}"><span>${a}</span><span>${b}</span></div>`).join("")}${note ? `<div class="n">${note}</div>` : ""}</div>`;
  await page.setContent(`<style>body{margin:0;padding:22px;display:grid;grid-template-columns:1fr 1fr;gap:22px;background:#eceae6;font:15px -apple-system,Helvetica,sans-serif;color:#1a1a1a}
    .p{background:#faf9f7;border-radius:16px;padding:18px;position:relative;height:220px}small{font:600 11px ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#77726b}
    .r{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e3ded7}.bad span:last-child{color:#b42318;font-weight:600}.good span:last-child{color:#2e7d32;font-weight:600}.t{font-weight:700}
    .n{margin-top:10px;background:#fff3cd;border-radius:8px;padding:6px 10px;font-size:13px}</style>
    ${receipt("BEFORE", [["Subtotal", "$81.00"], ["SPRING10", "-$8.10"], ["SPRING10", "-$8.10", "bad"], ["Total", "$64.80", "t bad"]])}
    ${receipt("AFTER", [["Subtotal", "$81.00"], ["SPRING10", "-$8.10"], ["Total", "$72.90", "t good"]], "Coupon already applied")}`);
  await page.screenshot({ path: beforeAfter });
  await page.close();
}

// The story: one ticket waiting for the founder to try it, one merged, three
// queued behind them, and one decision. The echo model cannot report, so a
// ticket left "running" stalls within seconds: every ticket here is driven to
// a state that holds still.
const drive = async (key, stage, args) => fx(["done", "--outcome", "complete", ...args], await until(() => ticket(key)?.threads[stage]));
fx(["enqueue", "APP-212", "Coupon applies twice", "--lane", "Checkout", "--pipeline", "reviewed", "--tier", "1", "--brief", "Editing a cart after applying a coupon discounts the order again."]);
await drive("APP-212", "build", ["--summary", "A coupon now applies once however often the cart is re-priced. Branch app-212-coupon-applies-twice; 6 tests added.",
  "--founder-check", "Before: editing a cart after applying a coupon discounted the order twice. Now: the coupon applies once and the summary says so. Sign in as 212@t.qa / pw, add two items, apply SPRING10, go back and change a quantity: the total shows one discount and the note \"Coupon already applied\".",
  "--screenshot", beforeAfter]);
await drive("APP-212", "code-review", ["--summary", "Reviewed the complete branch at its head; one fix landed (a second caller of applyCoupon).",
  "--before", "Editing a cart after applying a coupon discounted the order again. One customer paid $64.80 on an $81 order.",
  "--after", "A coupon applies once, however many times the cart is re-priced, and the order summary says it is already applied.",
  "--why", "The Observer saw it happen to a real customer yesterday."]);
await until(() => status().inbox.find((entry) => entry.kind === "check"));

fx(["enqueue", "APP-209", "Typo-tolerant search", "--lane", "Search", "--pipeline", "reviewed", "--tier", "2"]);
await drive("APP-209", "build", ["--summary", "Search now matches one-letter typos. Branch app-209-typo-tolerant-search.", "--no-founder-check", "No screen changes; results only."]);
await drive("APP-209", "code-review", ["--summary", "Reviewed; nothing to fix.",
  "--before", "Searching \"runing shoes\" found nothing.", "--after", "A one-letter typo still finds the product: \"runing shoes\" returns running shoes.", "--why", "A third of failed searches last week were single typos."]);
await drive("APP-209", "ship", ["--summary", "Merged."]);
await until(() => ticket("APP-209")?.status === "done");

// Queued work that waits for the ticket at the founder's gate, so nothing starts and stalls.
const queued = (key, title, pipeline, tier) => ({ key, title, pipeline, tier, waitingOn: ["APP-212"] });
bb(["solo-factor", "sync", JSON.stringify({ lanes: [
  { name: "Checkout", items: [{ key: "APP-212", title: "Coupon applies twice", pipeline: "reviewed" }, queued("APP-216", "Gift cards at checkout", "planned", 2)] },
  { name: "Search", items: [queued("APP-214", "Recent searches", "planned", 1), queued("APP-218", "Search by SKU", "reviewed", 1)] },
  { name: "Maintenance", items: [queued("APP-211", "Analytics SDK update", "reviewed", 1)] },
] }), "--project", project]);
for (const entry of status().inbox) if (entry.kind !== "check") { try { fx(["close", entry.id]); } catch { /* closed */ } }

fx(["agent", "start", "architect"]);
const architect = await until(() => JSON.parse(bb(["thread", "list", "--project", project, "--json"])).find((thread) => thread.title === "Architect")?.id);
fx(["ask", "One customer was undercharged $16.20 by the coupon bug. What happens to orders like hers?",
  "--context", "Three orders were discounted twice before the fix, $41 in total. The fix ships today; this is only about the orders already placed.",
  "--option", "Leave them. They keep the discount and hear nothing.",
  "--option", "Email an apology and charge the difference.",
  "--recommend", "Leave them. Charging people for our bug costs more than $41."], architect);
await until(() => status().inbox.find((entry) => entry.kind === "question"));

const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
const open = async (path) => { await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/${path}`); await page.waitForLoadState("networkidle").catch(() => {}); await sleep(1500); };
await open("factory");
await page.locator('[data-testid^="inbox-tile"]').filter({ hasText: "Coupon applies twice" }).first().click().catch(() => {});
await sleep(1500);
await page.screenshot({ path: join(out, "screen-inbox.png") });
await open("factory-lanes");
await page.screenshot({ path: join(out, "screen-swimlanes.png") });
// The Agents page is not captured: the echo model repeats its prompt, which is not what an agent says.
await browser.close();
writeFileSync(join(work, "demo-seeded"), new Date().toISOString());
console.log("Wrote docs/assets/screen-inbox.png and screen-swimlanes.png");
