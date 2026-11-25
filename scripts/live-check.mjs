#!/usr/bin/env node
// Live check: runs the factory against a real, throwaway bb server.
//
// It starts bb on its own ports with its own data folder (your real bb is not
// touched), installs this plugin plus bb's "echo" example provider (a fake
// model that costs nothing), creates a scratch git project, and walks tickets
// through the pipeline, asserting what bb actually did.
//
//   node scripts/live-check.mjs            run, print PASS/FAIL, tear down
//   node scripts/live-check.mjs --keep     leave the server up at :38990 to look at
//
// The echo model cannot call tools, so the script plays the agent's part by
// running `bb solo-factor done` / `ask` with that thread's identity. Everything
// else (threads, worktrees, events, messages, the inbox) is real.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const work = join(root, ".context", "live");
const dataDir = join(work, "data");
const repoDir = join(work, "repo");
const echoDir = join(work, "echo-provider");
const PORT = 38990;
const DAEMON_PORT = 38991;
const bbBin = join(root, "node_modules", ".bin", "bb");
const bbAppBin = join(root, "node_modules", ".bin", "bb-app");
const bbVersion = JSON.parse(readFileSync(join(root, "node_modules", "bb-app", "package.json"), "utf8")).version;
const sdkVersion = JSON.parse(
  readFileSync(join(root, "node_modules", "@get-bb", "plugin-sdk", "package.json"), "utf8"),
).version;

// Run from inside a bb thread, the caller's BB_THREAD_ID (and friends) would
// make the scratch server's CLI calls claim a sender thread it has never seen.
const callerEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_CLI"].includes(key)),
);
const env = {
  ...callerEnv,
  BB_SERVER_URL: `http://127.0.0.1:${PORT}`,
  BB_DATA_DIR: dataDir,
  BB_HOST_DAEMON_PORT: String(DAEMON_PORT),
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sh = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const bb = (args, extraEnv = {}) => sh(bbBin, args, { env: { ...env, ...extraEnv }, cwd: repoDir }).trim();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === "" ? "" : `\n      ${detail}`}`);
}

/** Poll until `read()` returns something truthy, or give up. */
async function until(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(400);
  }
}

let project = "";
const status = () => JSON.parse(bb(["solo-factor", "status", "--project", project, "--json"]));
const ticket = (key) => status().items.find((item) => item.key === key);
const threads = () => JSON.parse(bb(["thread", "list", "--project", project, "--json"]));
const as = (threadId) => ({ BB_THREAD_ID: threadId, BB_PROJECT_ID: project });
const lastMessage = (threadId) => bb(["thread", "log", threadId]);
/** The newest message sent into a thread that contains `text`, as bb recorded it. */
const requestWith = (threadId, text) =>
  [JSON.parse(bb(["thread", "log", threadId, "--json", "--limit", "1000"]))]
    .map((log) => (Array.isArray(log) ? log : log.events ?? log.items ?? []))[0]
    .filter((event) => event.type === "client/turn/requested" && JSON.stringify(event.data.input).includes(text))
    .at(-1)?.data ?? null;

function prepareEchoProvider() {
  if (existsSync(join(echoDir, "node_modules"))) return;
  rmSync(echoDir, { recursive: true, force: true });
  const clone = join(work, "bb-src");
  if (!existsSync(clone)) {
    sh("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", `desktop-v${bbVersion}`, "https://github.com/get-bb/bb.git", clone]);
    sh("git", ["sparse-checkout", "set", "examples/plugins/echo-provider"], { cwd: clone });
  }
  cpSync(join(clone, "examples", "plugins", "echo-provider"), echoDir, { recursive: true });
  for (const file of readdirSync(echoDir)) {
    if (file.endsWith(".test.ts") || file === "vitest.config.ts") rmSync(join(echoDir, file));
  }
  const manifestPath = join(echoDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies["@get-bb/plugin-sdk"] = sdkVersion;
  manifest.devDependencies = { "@types/node": "^22.0.0" };
  delete manifest.scripts;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: echoDir });
}

/** A Chromium to drive the page with: Playwright's cached one, else Chrome. */
function findBrowser() {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const cached = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort()
        .reverse()
        .flatMap((name) => readdirSync(join(cache, name)).map((dir) => join(cache, name, dir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")))
    : [];
  return [...cached, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => existsSync(path)) ?? null;
}

/** A plain RGB PNG, so a check can carry a real image without a renderer. */
function makePng(width, height, colorAt) {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = colorAt(x, y); rows.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3); }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const runTerminals = (threadId) =>
  JSON.parse(bb(["terminal", "list", "--thread", threadId, "--json"])).sessions.filter((session) => session.title === "Run" && session.status === "running");

async function runButtonChecks(entry, otherThread = null) {
  const executablePath = findBrowser();
  if (executablePath === null) {
    check("the inbox Run button starts the project's Run command", false, "No Chromium found. Run: npx playwright install chromium");
    return;
  }
  // A new bb opens on its first-run setup guide, which would cover the page.
  bb(["settings", "general", "onboardingCompletedAt", String(Date.now())]);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const consoleNotes = [];
    page.on("console", (message) => {
      if (message.text().includes("[factory]") || message.type() === "error") consoleNotes.push(message.text().slice(0, 300));
    });
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory`);
    // The inbox shows small cards; a card opens a pop-up with the whole entry.
    const openTile = async (key) => {
      await page.locator('[data-testid="inbox-tile"]').first().waitFor({ timeout: 30_000 });
      await page.keyboard.press("Escape");
      const tile = page.locator('[data-testid="inbox-tile"]').filter({ hasText: key });
      await tile.waitFor({ timeout: 30_000 });
      await tile.click();
      await page.locator('[data-testid="inbox-panel"] [data-testid="inbox-entry"]').waitFor({ timeout: 15_000 });
    };
    const tiles = page.locator('[data-testid="inbox-tile"]');
    await tiles.first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(work, "page-inbox.png") });
    check(
      "the inbox is two columns of small cards, Decisions and Founder QA, with no actions on them",
      (await page.locator('[data-testid="inbox-column-qa"] [data-testid="inbox-tile"]').count()) === 1 &&
        (await page.locator('[data-testid="inbox-column-decisions"] [data-testid="inbox-tile"]').count()) === 1 &&
        (await page.getByRole("button", { name: "Approve and ship" }).count()) === 0,
    );
    await openTile("LIVE-1");
    const image = page.locator('[data-testid="check-screenshots"] img').first();
    const imageShown = await image.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const loaded = imageShown && (await image.evaluate((img) => img.complete && img.naturalWidth === 320).catch(() => false));
    check("a check shows its before/after screenshot above the steps", loaded === true);
    await page.screenshot({ path: join(work, "page-inbox-open.png") });
    // A green dot on Swimlanes while a ticket is moving: queue one in its own lane, then take it out.
    bb(["solo-factor", "enqueue", "LIVE-9", "Moving ticket", "--lane", "Dots", "--pipeline", "reviewed", "--project", project]);
    // The echo agent ends its turn at once, so the ticket moves only briefly: read the dot when it shows.
    const sawMoving = await page.waitForFunction(() => (document.querySelector('[data-testid="sidebar-navigation-rail"] button[aria-label^="Swimlanes"]')?.getAttribute("aria-label") ?? "").endsWith(" moving"), null, { timeout: 15_000, polling: 100 }).then(() => true, () => false);
    const lanesDot = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="sidebar-navigation-rail"] button[aria-label^="Swimlanes"]');
      const dot = button?.querySelector("[data-nav-rail-badge] span") ?? button?.querySelector("[data-nav-rail-badge]");
      return { label: button?.getAttribute("aria-label") ?? "", color: dot ? getComputedStyle(dot).backgroundColor : null };
    });
    const movingNow = sawMoving ? 1 : 0;
    check("Swimlanes shows a green dot while a ticket is moving", movingNow > 0 && lanesDot.label.endsWith(" moving") && lanesDot.color === "rgb(16, 185, 129)", JSON.stringify({ movingNow, ...lanesDot }));
    bb(["solo-factor", "cancel", "LIVE-9", "--project", project]);
    // The reply row reads + | Send back | Dismiss; Run and Open thread sit at the panel's bottom right.
    const panel = page.locator('[data-testid="inbox-panel"]');
    const box = async (selector) => panel.locator(selector).first().boundingBox();
    const rowOf = async () => {
      const plus = await box('[data-testid="inbox-attach"]');
      const sendBack = await panel.getByRole("button", { name: "Send back" }).boundingBox();
      const dismiss = await box('[data-testid="inbox-dismiss"]');
      const ok = plus.x < sendBack.x && sendBack.x < dismiss.x && Math.abs(plus.y + plus.height / 2 - (dismiss.y + dismiss.height / 2)) < 4;
      return ok ? { ok, plus, sendBack, dismiss } : null;
    };
    const row = (await until(rowOf, 5_000)) ?? { ok: false, ...(await rowOf().catch(() => ({}))) };
    const panelBox = await panel.boundingBox();
    const runBox = await box('[data-testid="inbox-run"]');
    const threadBox = await box('[data-testid="inbox-open-thread"]');
    check(
      "in the panel, + sits left of Send and Dismiss right of it, on one row",
      row.ok,
      JSON.stringify(row),
    );
    check(
      "Run and Open thread are pinned to the panel's bottom right",
      runBox.x < threadBox.x && panelBox.x + panelBox.width - (threadBox.x + threadBox.width) < 32 && panelBox.y + panelBox.height - (threadBox.y + threadBox.height) < 32,
      JSON.stringify({ panelBox, runBox, threadBox }),
    );
    // The panel's left edge drags, and the width it is left at is kept.
    const edge = await box('[data-testid="inbox-panel-resize"]');
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 - 100, edge.y + 200, { steps: 5 });
    await page.mouse.move(edge.x + edge.width / 2 - 200, edge.y + 200, { steps: 5 });
    await page.mouse.up();
    const wider = (await panel.boundingBox()).width;
    await page.reload();
    await panel.locator('[data-testid="inbox-entry"]').waitFor({ timeout: 30_000 });
    const keptWidth = (await panel.boundingBox()).width;
    check("dragging the panel's edge resizes it, and the width survives a reload", Math.abs(wider - panelBox.width - 200) < 6 && Math.abs(keptWidth - wider) < 2, `${panelBox.width} → ${wider} → ${keptWidth}`);
    await page.screenshot({ path: join(work, "page-inbox-resized.png") });
    // A click opens it in bb's file preview beside the inbox, not inline.
    const imagesBefore = await page.locator("img").count();
    await page.locator('[data-testid="check-screenshot"]').first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(work, "page-inbox-preview.png") });
    const viewerImage = page.locator('[data-testid="check-image-viewer"] img').first();
    const previewed = await viewerImage.waitFor({ timeout: 15_000 }).then(() => viewerImage.evaluate((img) => img.complete && img.naturalWidth === 320), () => false);
    check("clicking the image opens it in the panel's image viewer", previewed === true);
    const widthBefore = (await viewerImage.boundingBox())?.width ?? 0;
    await page.locator('[data-testid="check-image-viewer"] button[aria-label="Zoom in"]').click().catch(() => undefined);
    await page.waitForTimeout(500);
    const widthAfter = (await viewerImage.boundingBox())?.width ?? 0;
    const zoomLabel = await page.locator('[data-testid="check-image-zoom"]').innerText().catch(() => "");
    await page.screenshot({ path: join(work, "page-inbox-zoomed.png") });
    check("+ zooms the image in place in the panel", widthAfter > widthBefore * 1.4 && zoomLabel === "150%", `${widthBefore} → ${widthAfter}, ${zoomLabel}`);
    await page.locator('[data-testid="check-image-viewer"] button[aria-label="Fit to width"]').click().catch(() => undefined);
    await page.waitForTimeout(300);
    check("Fit returns it to the panel's width", Math.abs(((await viewerImage.boundingBox())?.width ?? 0) - widthBefore) < 2);
    const button = page.locator('[data-testid="inbox-run"]').first();
    await button.waitFor({ timeout: 30_000 });
    // A Run already up in another ticket's workspace is stopped first: one app at a time.
    if (otherThread !== null) bb(["terminal", "create", "--thread", otherThread, "--title", "Run", "--command", "sleep 600"]);
    const decoyUp = otherThread !== null && (await until(() => (runTerminals(otherThread).length > 0 ? true : null))) === true;
    await button.click();
    const started = await until(() => runTerminals(entry.threadId)[0] ?? null);
    check("the inbox Run button starts a Run terminal in the ticket's workspace", started !== null);
    const ran = started === null ? null : await until(() => (bb(["terminal", "output", started.id]).includes("factory-run-42") ? true : null));
    check("it runs the command from the project's settings file", ran === true);
    const otherStopped = decoyUp ? await until(() => (runTerminals(otherThread).length === 0 ? true : null)) : null;
    check("Run stops a Run already up in another ticket's workspace", otherStopped === true, decoyUp ? "still running" : "no other workspace to test with");
    const mark = page.getByLabel("Run is up in this workspace").first();
    const marked = await mark.waitFor({ state: "attached", timeout: 15_000 }).then(() => true, () => false);
    check("the sidebar marks a workspace whose Run is up", marked);
    await page.screenshot({ path: join(work, "run-button.png") });

    // While it is up the same button stops it.
    const stopLabel = await button.filter({ hasText: "Stop" }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("the Run button reads Stop while that workspace is running", stopLabel);
    await button.click();
    const stopped = await until(() => (runTerminals(entry.threadId).length === 0 ? true : null));
    check("pressing Stop ends the Run command", stopped === true);
    const cleared = await mark.waitFor({ state: "detached", timeout: 15_000 }).then(() => true, () => false);
    check("the mark clears when Run stops", cleared);
    const runLabel = await button.filter({ hasText: "Run" }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("the button reads Run again", runLabel);

    // --- the other two pages
    // Shipping takes two presses.
    const approve = page.locator('[data-testid="inbox-approve"]');
    await approve.click();
    const asksAgain = (await approve.innerText()).includes("Press again") && Boolean(status().inbox.find((e) => e.id === entry.id));
    check("one press on Approve and ship releases nothing; it asks for a second", asksAgain);
    await page.keyboard.press("Escape");
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-lanes`);
    const lanes = await page.locator('[data-testid="lane"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    await page.screenshot({ path: join(work, "page-lanes.png") });
    check("swimlanes have their own page", lanes && (await page.locator('[data-testid="inbox-entry"]').count()) === 0);
    const headers = (await page.locator("thead th").allInnerTexts()).map((text) => text.trim());
    check("swimlane columns read Track, Next up, In Progress, Done", headers.join("|") === "Track|Next up|In Progress|Done", headers.join("|"));
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-settings`);
    const url = page.locator('[data-testid="ticket-url"]');
    await url.waitFor({ timeout: 30_000 });
    await url.fill("https://tracker.example/issue/{key}");
    await url.press("Enter");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(work, "page-settings.png") });
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-lanes`);
    const arrow = await page.locator('[data-testid="ticket-link"]:visible').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("settings has its own page, and a ticket link set there puts an arrow on each ticket", arrow);
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory`);
    await openTile("LIVE-1");

    // --- the reply box on that entry
    // The check waiting on the founder, wherever its group puts it on the page.
    const gateCard = () => page.locator('[data-testid="inbox-entry"]');
    const reply = gateCard().locator('[data-testid="inbox-reply"]');
    const oneLine = (await reply.boundingBox()).height;
    await reply.fill("The name is right.\nThe spacing under it is too tight.\nSee the picture.\nFourth line.");
    const grew = await until(async () => ((await reply.boundingBox()).height > oneLine * 2 ? true : null), 5_000);
    check("the reply box grows as the founder types more lines", grew === true);
    writeFileSync(join(work, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    await gateCard().locator('[data-testid="inbox-attach-input"]').setInputFiles(join(work, "shot.png"));
    const attached = await page.locator('[data-testid="inbox-attachments"]').getByText("shot.png").waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("a picture can be attached to the reply", attached);
    await page.reload();
    await openTile("LIVE-1");
    const kept = await until(async () => ((await gateCard().locator('[data-testid="inbox-reply"]').inputValue().catch(() => "")).includes("spacing under it") ? true : null), 20_000);
    const keptFile = (await page.locator('[data-testid="inbox-attachments"]').getByText("shot.png").count()) > 0;
    check("the draft and its attachment survive leaving the page", kept === true && keptFile);
    await page.locator('[data-testid="inbox-panel"] [data-testid="inbox-open-thread"]').click();
    const composer = page.getByText("The spacing under it is too tight.").first();
    const carried = await composer.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    check("opening the thread brings the draft into its composer", carried && page.url().includes(entry.threadId), page.url());
    const banner = await page.locator('[data-testid="inbox-banner"]').getByText("Try it before it ships").first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("the thread shows what the founder was asked, above its composer", banner);
    await page.screenshot({ path: join(work, "draft-in-thread.png") });
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory`);
    await openTile("LIVE-1");
    const again = gateCard().locator('[data-testid="inbox-reply"]');
    await again.waitFor({ timeout: 30_000 });
    check("the draft has moved, not been copied: the inbox box is empty again", (await again.inputValue()) === "");

    // Answering from the inbox sends the words and the picture to the thread.
    // Done on the stalled entry, so the ticket under test stays where it is.
    const stalled = status().inbox.find((e) => e.kind === "stalled");
    // With the check's image open beside the inbox, answering an entry closes the image's tab and the panel.
    await openTile("LIVE-1");
    await page.locator('[data-testid="check-screenshot"]').first().click().catch(() => undefined);
    const imageOpen = await page.locator('[data-testid="check-image-viewer"]').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await openTile("LIVE-3");
    const card = page.locator('[data-testid="inbox-entry"]').filter({ hasText: stalled.question });
    await card.locator('[data-testid="inbox-reply"]').fill("Carry on from the last step.");
    await card.locator('[data-testid="inbox-attach-input"]').setInputFiles(join(work, "shot.png"));
    await card.locator('[data-testid="inbox-attachments"]').getByText("shot.png").waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(work, "reply-box.png") });
    await card.getByRole("button", { name: "Send", exact: true }).click();
    const delivered = await until(() => (lastMessage(stalled.threadId).includes("Carry on from the last step.") ? true : null));
    await page.waitForTimeout(1500);
    const viewerGone = (await page.locator('[data-testid="check-image-viewer"]').count()) === 0;
    const tabGone = (await page.getByText(/before-after-\d+/).count()) === 0;
    await page.screenshot({ path: join(work, "page-inbox-after-answer.png") });
    check("answering an entry closes the open image's tab and the side panel", imageOpen && viewerGone && tabGone, `open ${imageOpen}, viewer gone ${viewerGone}, tab gone ${tabGone}`);
    // Dealing with one entry moves the panel to the next; it does not close.
    const moved = await page.locator('[data-testid="inbox-panel"]').getByText("First in lane").first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("after an answer is sent the panel shows the next entry", moved);
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-lanes`);
    const elsewhere = (await page.locator('[data-testid="inbox-panel"]').count()) === 0;
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory`);
    const back = await page.locator('[data-testid="inbox-panel"]').getByText("First in lane").first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("the panel is still open on returning to the inbox, and is not shown on other pages", elsewhere && back);
    const request = requestWith(stalled.threadId, "Carry on from the last step.");
    const shown = (request?.input ?? []).filter((part) => part.type === "text" && part.visibility !== "agent-only").map((part) => part.text).join(" ");
    const hidden = (request?.input ?? []).filter((part) => part.visibility === "agent-only").map((part) => part.text ?? "").join(" ");
    check(
      "an inbox answer is sent as the founder's own message, with the factory's context hidden from him",
      request !== null && (request.originPluginId ?? null) === null && request.senderThreadId === null && shown.includes("Carry on from the last step.") && !shown.includes("The founder was asked") && hidden.includes("The founder was asked"),
      `${consoleNotes.slice(-6).join(" | ")} ${JSON.stringify(request).slice(0, 400)}`,
    );
    await page.goto(`http://127.0.0.1:${PORT}/threads/${stalled.threadId}`).catch(() => {});
    const sentReply = page.getByText("Carry on from the last step.").first();
    await sentReply.waitFor({ timeout: 15_000 }).catch(() => {});
    await sentReply.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: join(work, "founder-reply-in-thread.png") });
    await page.goBack().catch(() => {});
    check("an answer with a picture attached reaches the thread", delivered === true && !status().inbox.some((e) => e.id === stalled.id), bb(["thread", "log", stalled.threadId]).slice(-600));
  } finally {
    await browser.close();
  }
}

/** The founder uses bb on his phone too: every Factory surface at phone width. */
async function phoneChecks(architectId) {
  const executablePath = findBrowser();
  if (executablePath === null) {
    check("the Factory pages fit a phone", false, "No Chromium found. Run: npx playwright install chromium");
    return;
  }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const fits = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-lanes`);
    await page.locator('[data-testid="change-note"]:visible').first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(work, "phone-lanes.png") });
    check("swimlanes fit a phone, with What changed on the merged card", await fits());
    await page.locator('[data-testid="change-note"]:visible').first().click();
    const panel = page.locator('[data-testid="change-note-panel"]');
    await panel.waitFor({ timeout: 10_000 });
    // The panel places itself below the page header after it mounts.
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(work, "phone-change-note.png") });
    const box = await panel.boundingBox();
    check("What changed opens a panel that fills a phone screen and shows before, after and why", box !== null && box.width >= 380 && (await panel.innerText()).includes("It says Welcome back."));
    await page.keyboard.press("Escape");
    // On a desktop window the panel starts below bb's page header; nothing covers its title.
    const desk = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await desk.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-lanes`);
    await desk.locator('[data-testid="change-note"]:visible').first().click({ timeout: 30_000 });
    await desk.locator('[data-testid="change-note-panel"]').waitFor({ timeout: 10_000 });
    await desk.waitForTimeout(500);
    await desk.screenshot({ path: join(work, "desktop-change-note.png") });
    const clear = await desk.evaluate(() => {
      const panel = document.querySelector('[data-testid="change-note-panel"]');
      const title = panel?.querySelector("p.text-base");
      if (!panel || !title) return false;
      const r = title.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 5, r.top + 2);
      return panel.getBoundingClientRect().top > 0 && hit !== null && panel.contains(hit);
    });
    check("on a desktop, What changed opens below bb's page header with nothing over its title", clear);
    // An agent's thread page is reachable and Home is never redirected to Agents
    // (a route-watching redirect once trapped him there).
    await desk.goto(`http://127.0.0.1:${PORT}/threads/${architectId}`);
    await desk.waitForTimeout(2500);
    await desk.goto(`http://127.0.0.1:${PORT}/`);
    await desk.waitForTimeout(2500);
    check("Home stays Home after visiting an agent's thread", !desk.url().includes("factory-agents"), desk.url());
    // The Factory's own link to an agent opens the Agents page with that agent marked.
    await desk.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-agents/architect`);
    const marked = await desk.locator('[data-testid="agents-sidebar"] [aria-current="page"]').first().innerText({ timeout: 20_000 }).catch(() => "");
    await desk.screenshot({ path: join(work, "desktop-agent-thread.png") });
    check("the Agents page marks the open agent in its sidebar", marked.includes("Architect"), marked);
    // He drags an agent to a new place in the list; the order is saved with the factory.
    const rows = desk.locator('[data-testid="agents-sidebar"] [data-testid="agent-row"]');
    const firstBefore = (await rows.first().innerText()).trim();
    const lastName = (await rows.last().innerText()).trim();
    await rows.last().dragTo(rows.first());
    const reordered = await until(async () => ((await rows.first().innerText()).trim() === lastName ? true : null), 10_000);
    const saved = status().items !== undefined ? JSON.parse(bb(["solo-factor", "config", "--project", project])).agentOrder : [];
    check("dragging an agent in the Agents list reorders it and saves the order", reordered === true && Array.isArray(saved) && saved.length > 0, `${firstBefore} -> ${(await rows.first().innerText()).trim()} | ${JSON.stringify(saved)}`);
    await desk.close();
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(work, "phone-inbox.png") });
    check("the inbox fits a phone", await fits());
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-agents/architect`);
    const chat = await page.locator('[data-follow-up-composer], textarea, [contenteditable="true"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    await page.screenshot({ path: join(work, "phone-agents.png") });
    check("the Agents page shows the agent's conversation with a composer on a phone", chat && (await fits()));
    check("on a phone the Agents page has its own row of agents to switch between", (await page.locator('[data-testid="agent-switcher"] button').count()) >= 4);
    // A banner above the thread's composer starts as one line.
    bb(["solo-factor", "ask", "Open the thread and answer the questions there.", "--todo", "--context", "A long explanation. ".repeat(40)], as(architectId));
    // An agent's question still titles its inbox tile (it has no ticket title).
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory`);
    const agentTile = page.locator('[data-testid="inbox-tile-question"]').filter({ hasText: "Open the thread and answer the questions there." }).first();
    check("an agent's inbox tile shows its question as the title", await agentTile.waitFor({ timeout: 15_000 }).then(() => true, () => false));
    await page.goto(`http://127.0.0.1:${PORT}/threads/${architectId}`);
    const banner = page.locator('[data-testid="inbox-banner"]');
    const shown = await banner.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    await page.screenshot({ path: join(work, "phone-banner.png") });
    const height = shown ? ((await banner.boundingBox())?.height ?? 999) : 999;
    check("an inbox banner in a thread starts as one short line on a phone", shown && height < 80, `height ${height}`);
    await page.locator('[data-testid="inbox-banner-toggle"]').first().click();
    const opened = await banner.innerText();
    await page.screenshot({ path: join(work, "phone-banner-open.png") });
    check("tapping the banner shows the whole entry", opened.includes("A long explanation."));
    // The banner shows above the composer on the Agents page too.
    await page.goto(`http://127.0.0.1:${PORT}/plugins/solo-factor/factory-agents/architect`);
    const bannerOnAgents = await page.locator('[data-testid="inbox-banner"]').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    await page.screenshot({ path: join(work, "phone-agents-banner.png") });
    check("on a phone the Agents page shows the agent's banner above the composer", bannerOnAgents);
    // Reply on the banner puts that question's pill into the composer.
    await page.locator('[data-testid="inbox-banner-reply"]').first().click().catch(() => undefined);
    await page.waitForTimeout(1500);
    const composerText = await page.locator('[data-follow-up-composer]').first().innerText().catch(() => "");
    await page.screenshot({ path: join(work, "phone-banner-reply.png") });
    await page.locator("[data-follow-up-composer] .ProseMirror").first().click();
    await page.keyboard.type(" B");
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(work, "phone-banner-reply-typing.png") });
    const boxFits = await page.locator("[data-follow-up-composer] .ProseMirror").first().evaluate((el) => el.scrollHeight <= el.clientHeight + 2);
    check("once he types, the message box grows to show the whole Reply pill", boxFits);
    const pillClipped = await page.locator('[data-follow-up-composer] .prompt-mention-pill .truncate').first().evaluate((el) => el.scrollWidth > el.clientWidth + 1).catch(() => true);
    check("the Reply pill shows the whole question, not cut off", !pillClipped);
    check("Reply on a banner question puts its reply pill, with the whole question, in the composer", composerText.includes("Reply: Open the thread and answer the questions there."), composerText.slice(0, 200));
    // Picking an option on a banner question puts the pill and that option in the composer.
    bb(["solo-factor", "ask", "Ship the greeting as is?", "--option", "Ship it now.", "--option", "Hold it for copy review."], as(architectId));
    await page.goto(`http://127.0.0.1:${PORT}/threads/${architectId}`);
    const decision = page.locator('[data-testid="inbox-banner"] li').filter({ hasText: "Ship the greeting as is?" }).first();
    await decision.waitFor({ timeout: 20_000 }).catch(() => undefined);
    const options = decision.locator('[data-testid="inbox-banner-option"]');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await options.nth(1).isVisible().catch(() => false))) await decision.locator('[data-testid="inbox-banner-toggle"]').click().catch(() => undefined);
      await options.nth(1).waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
      await options.nth(1).click().catch(() => undefined);
      const landed = await page.waitForFunction(() => document.querySelector("[data-follow-up-composer]")?.textContent?.includes("B. Hold it for copy review."), null, { timeout: 5_000 }).then(() => true, () => false);
      if (landed) break;
    }
    await page.waitForTimeout(1500);
    const optionText = await page.locator('[data-follow-up-composer]').first().innerText().catch(() => "");
    await page.screenshot({ path: join(work, "banner-option.png") });
    check("picking B on a banner question puts its pill and the option in the composer", optionText.includes("Reply: Ship the greeting as is?") && optionText.includes("B. Hold it for copy review."), optionText.slice(0, 200));
    // A standing agent's question stays open when he writes about something
    // else in its thread; the agent closes it once it is settled.
    bb(["thread", "tell", architectId, "Something else entirely.", "--mode", "auto"]);
    await sleep(3000);
    const stillOpen = status().inbox.find((e) => e.question.startsWith("Open the thread"));
    check("his unrelated message in an agent's thread leaves its question open", Boolean(stillOpen));
    if (stillOpen) bb(["solo-factor", "close", stillOpen.id], as(architectId));
    const cleared = await until(() => (status().inbox.some((e) => e.question.startsWith("Open the thread")) ? null : true));
    check("the agent closes its own question once settled", cleared === true);
  } finally {
    await browser.close();
  }
}

async function main() {
  mkdirSync(work, { recursive: true });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# factory live check\n");
  // The Run command the inbox Run button starts. The shell does the sum, so
  // the marker only appears in the output if the command really ran.
  mkdirSync(join(repoDir, ".conductor"), { recursive: true });
  writeFileSync(join(repoDir, ".conductor", "settings.toml"), '[scripts.run.run]\ncommand = "echo factory-run-$((40+2)); sleep 600"\ndefault = true\n');
  sh("git", ["add", "."], { cwd: repoDir });
  sh("git", ["-c", "user.email=live@example.com", "-c", "user.name=Live", "commit", "-qm", "init"], { cwd: repoDir });

  console.log(`Preparing echo provider for bb ${bbVersion}…`);
  prepareEchoProvider();
  sh(bbBin, ["plugin", "build"], { cwd: root, env });

  // A server left over from an earlier `--keep` run would answer on the same
  // port with stale data, and the checks would pass against the wrong thing.
  const inUse = await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false);
  if (inUse) {
    throw new Error(`Port ${PORT} is already in use. Stop the earlier live-check server first (lsof -ti tcp:${PORT} | xargs ps -o pgid= | xargs -I{} kill -- -{}).`);
  }
  console.log("Starting a throwaway bb server…");
  const server = spawn(
    bbAppBin,
    ["--data-dir", dataDir, "--server-port", String(PORT), "--host-daemon-port", String(DAEMON_PORT), "--no-in-app-updates", "--bundled"],
    { env, stdio: "ignore", detached: true },
  );
  const stop = () => {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  };
  try {
    const up = await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${PORT}/`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    if (!up) throw new Error("bb server did not start");
    await until(() => {
      try {
        bb(["project", "list"]);
        return true;
      } catch {
        return false;
      }
    });

    bb(["plugin", "install", root, "--yes"]);
    bb(["plugin", "install", echoDir, "--yes"]);
    const loaded = bb(["plugin", "list"]);
    check("plugin loads on a real bb server", /solo-factor@\S+\s+running/.test(loaded), loaded.slice(0, 400));

    project = JSON.parse(bb(["project", "create", "--name", "Live check", "--root", repoDir, "--json"])).id;
    for (const role of ["architect", "plan-review", "build", "code-review", "ship", "mechanic"]) {
      bb(["solo-factor", "role", role, "--provider", "echo-agent", "--model", "echo-1", "--reasoning", "low", "--project", project]);
    }

    // --- standing agent
    bb(["solo-factor", "agent", "start", "architect", "--project", project]);
    const architect = await until(() => threads().find((t) => t.title === "Architect"));
    check("architect starts unpinned: standing agents live on the Agents page", Boolean(architect) && architect.pinnedAt == null);
    const mainEnv = await until(() => threads().find((t) => t.title === "Architect")?.environmentId);
    const environments = bb(["environment", "list", "--project", project]);
    check(
      "architect runs in the main checkout, not a worktree",
      new RegExp(`${mainEnv}\\s+\\S+\\s+project-checkout`).test(environments),
      environments,
    );

    // --- lanes
    bb(["solo-factor", "enqueue", "LIVE-1", "First in lane", "--lane", "Checkout", "--pipeline", "reviewed", "--project", project], as(architect.id));
    bb(["solo-factor", "enqueue", "LIVE-2", "Second in lane", "--lane", "Checkout", "--pipeline", "reviewed", "--project", project]);
    bb(["solo-factor", "enqueue", "LIVE-3", "Other lane", "--lane", "Plan", "--pipeline", "small-bug", "--project", project]);
    check("first ticket in a lane starts", ticket("LIVE-1").status === "running" || ticket("LIVE-1").status === "stalled");
    check("second ticket in the same lane waits", ticket("LIVE-2").status === "queued");
    check("a ticket in another lane starts in parallel", ticket("LIVE-3").status !== "queued");

    const build = ticket("LIVE-1").threads.build;
    const buildThread = await until(() => threads().find((t) => t.id === build && t.environmentId));
    check("the ticket runs on the configured model", buildThread?.providerId === "echo-agent");
    check(
      "the ticket gets its own worktree",
      new RegExp(`${buildThread?.environmentId}\\s+\\S+\\s+git-worktree`).test(bb(["environment", "list", "--project", project])),
    );

    const named = await until(() => (JSON.parse(bb(["environment", "list", "--json"])).find((e) => e.id === buildThread?.environmentId)?.name === "LIVE-1" ? true : null), 15_000);
    check("the thread is titled with its role and the workspace with its ticket", buildThread?.title === "Execution" && named === true, `${buildThread?.title}`);

    // --- stall detection (the echo model never reports)
    const stalled = await until(() => (ticket("LIVE-1").status === "stalled" ? true : null), 30_000);
    check("a thread that stops without reporting is nudged, then escalated", stalled === true);
    check("the stall is in the founder inbox", status().inbox.some((e) => e.kind === "stalled" && e.from.includes("LIVE-1")));
    check("the nudge was delivered to the thread", lastMessage(build).includes("You stopped without reporting"));

    // --- handoff to an independent review in the same worktree
    bb(["solo-factor", "done", "--outcome", "complete", "--summary", "Built on its branch; tests pass."], as(build));
    const review = await until(() => ticket("LIVE-1").threads["code-review"]);
    const reviewThread = await until(() => threads().find((t) => t.id === review && t.environmentId));
    check("review starts in a new thread", review && review !== build);
    check("review shares the builder's worktree", reviewThread?.environmentId === buildThread?.environmentId);
    check("review receives the builder's handoff", lastMessage(review).includes("Built on its branch; tests pass."));
    check("reporting a stage clears its stall from the inbox", !status().inbox.some((e) => e.threadId === build));

    // --- a stage's question goes to the ticket's issue owner, who takes it to the founder
    bb(
      ["solo-factor", "ask", "Should rest days count as missed?", "--context", "Today they count as rest.", "--option", "Count as rest", "--option", "Count as missed", "--recommend", "Count as missed."],
      as(review),
    );
    const owner = await until(() => threads().find((t) => t.title === "Issue owner"));
    check("a stage's question starts the ticket's issue owner and goes there first", Boolean(owner) && status().inbox.every((e) => e.kind !== "question"));
    check("the owner works in the ticket's own workspace", (await until(() => threads().find((t) => t.id === owner.id)?.environmentId)) === buildThread?.environmentId);
    check("the ticket shows as with its issue owner", ticket("LIVE-1").status === "with-owner");
    const toOwner = await until(() => (lastMessage(owner.id).includes("Should rest days count as missed?") ? true : null));
    check("the owner receives the stage's question", toOwner === true);
    bb(
      ["solo-factor", "ask", "Should a rest day count as missed?", "--context", "Today it counts as rest.", "--option", "Count as rest", "--option", "Count as missed", "--recommend", "Count as missed."],
      as(owner.id),
    );
    const question = status().inbox.find((e) => e.kind === "question");
    check("the owner's question lands in the inbox, in the owner's thread", question?.from === "Issue owner · LIVE-1" && question.threadId === owner.id && question.options.length === 2);
    check("the ticket shows as waiting on the founder", ticket("LIVE-1").status === "needs-founder");
    // The founder answers by typing in the owner's thread, not in the inbox.
    bb(["thread", "tell", owner.id, "Count as missed.", "--mode", "auto"]);
    const cleared1 = await until(() => (status().inbox.some((e) => e.kind === "question") ? null : true));
    check("typing the answer in the thread clears the inbox entry", cleared1 === true);
    check("the ticket then waits on its owner to pass the answer on", ticket("LIVE-1").status === "with-owner");
    bb(["solo-factor", "note", "Founder: a rest day counts as missed."], as(owner.id));
    bb(["solo-factor", "message", "LIVE-1:code-review", "Count as missed."], as(owner.id));
    const answered = await until(() => (lastMessage(review).includes("Count as missed.") ? true : null));
    const after = ticket("LIVE-1").status;
    // The echo model answers at once and never reports, so by now it may have been reminded and flagged.
    check("the owner's reply reaches the stage that asked, and the ticket is back with that stage", answered === true && (after === "running" || after === "stalled"), `answered=${answered} status=${after}`);

    // --- a small bug gets no workspace: it rides with the next planned ticket in its lane
    const before = threads().length;
    bb(["solo-factor", "enqueue", "LIVE-4", "Typo on the greeting", "--lane", "Checkout", "--pipeline", "small-bug", "--project", project]);
    check("a small bug rides with the next ticket in its lane", ticket("LIVE-2").riders?.[0]?.key === "LIVE-4" && !ticket("LIVE-4") && threads().length === before);

    // --- review returns changes; author fixes; ticket moves past the review
    // The last review must say what changed; without it nothing is recorded.
    let refused = "";
    try {
      bb(["solo-factor", "done", "--outcome", "changes_requested", "--summary", "Rename the helper."], as(review));
    } catch (error) {
      refused = String(error.stderr ?? error.message);
    }
    check("the last review is refused without a change note", refused.includes("change_note") && !lastMessage(build).includes("Rename the helper."));
    bb(["solo-factor", "done", "--outcome", "changes_requested", "--summary", "Rename the helper.", "--before", "The greeting said Hello.", "--after", "It says Welcome back.", "--why", "The founder asked for a warmer greeting."], as(review));
    check("the change note is kept on the ticket", ticket("LIVE-1").changeNote?.after === "It says Welcome back.");
    const findings = await until(() => (lastMessage(build).includes("Rename the helper.") ? true : null));
    check("review findings go to the builder's existing thread", findings === true);
    // A before/after render, as the reviewer's preview harness writes one: left half grey, right half green.
    const shot = join(work, "before-after.png");
    writeFileSync(shot, makePng(320, 160, (x) => (x < 160 ? [200, 200, 200] : [40, 160, 90])));
    bb(["solo-factor", "done", "--outcome", "complete", "--summary", "Helper renamed.", "--founder-check", "Open the greeting screen as demo@example.com and see the new name.", "--screenshot", shot], as(build));
    const gate = await until(() => status().inbox.find((e) => e.kind === "check"));
    check("a visible change waits for the founder to try it before ship", Boolean(gate) && !ticket("LIVE-1").threads.ship);
    check("his check lives in the owner's thread", gate.threadId === owner.id);

    // --- the founder presses Run on that inbox entry, in a real browser
    // A thread of its own in another workspace, to hold a Run that is already up.
    const elsewhere = JSON.parse(bb(["thread", "spawn", "--project", project, "--new-environment", "worktree", "--provider", "echo-agent", "--model", "echo-1", "--prompt", "Side work.", "--json"]));
    const elsewhereId = elsewhere.id ?? elsewhere.thread?.id ?? null;
    await runButtonChecks(gate, elsewhereId);

    bb(["solo-factor", "approve", gate.id]);
    const ship = await until(() => ticket("LIVE-1").threads.ship);
    check("after fixes the ticket goes to ship without a second review", Boolean(ship));

    // --- agent-to-agent messaging
    bb(["solo-factor", "message", "architect", "Units differ between plan and code."], as(ship));
    const relayed = await until(() => (lastMessage(architect.id).includes("Units differ between plan and code.") ? true : null));
    check("a worker can message the architect", relayed === true);

    // --- finishing frees the lane
    bb(["solo-factor", "done", "--outcome", "complete", "--summary", "Merged."], as(ship));
    check("the ticket finishes after its last stage", ticket("LIVE-1").status === "done");
    await phoneChecks(architect.id);
    check("a finished ticket's threads are left for the founder to archive", threads().some((t) => t.id === build));

    // --- follow-up work under a new ticket continues in the same workspace
    bb(["solo-factor", "follow-up", "LIVE-9", "Round two", "--handoff", "Rename it back."], as(owner.id));
    const followUp = await until(() => ticket("LIVE-9")?.threads.build);
    const followThread = await until(() => threads().find((t) => t.id === followUp && t.environmentId));
    check("a follow-up ticket takes over the shipped ticket's workspace", followThread?.environmentId === buildThread?.environmentId && ticket("LIVE-1").status === "archived");
    const workspaces = () => JSON.parse(bb(["environment", "list", "--json"]));
    const renamed = await until(() => (workspaces().find((e) => e.id === buildThread?.environmentId)?.name === "LIVE-9" ? true : null), 8_000);
    check("the workspace takes the new ticket's name", renamed === true, JSON.stringify(workspaces().map((e) => [e.id, e.name])) + ` want ${buildThread?.environmentId}`);
    bb(["solo-factor", "cancel", "LIVE-9", "--project", project]);
    // LIVE-2 was held up behind it only for the length of this check.
    bb(["solo-factor", "done", "--outcome", "complete", "--summary", "Built."], as(ticket("LIVE-3").threads.fix));
    // The Done card's Archive button, through the same engine rule as the CLI.
    const live3Threads = Object.values(ticket("LIVE-3").threads);
    bb(["solo-factor", "archive", "LIVE-3", "--project", project]);
    const cleared = await until(() => (status().items.find((i) => i.key === "LIVE-3")?.status === "archived" ? true : null));
    check("archiving its workspace clears a finished ticket from the board", cleared === true);
    const gone = await until(() => (live3Threads.every((id) => !threads().some((t) => t.id === id)) ? true : null));
    check("archiving from the board archives the ticket's threads in bb", gone === true);
    check("archiving a ticket leaves the standing agents alone", threads().some((t) => t.id === architect.id));
    const next = await until(() => (ticket("LIVE-2").status !== "queued" ? true : null));
    check("the next ticket in the lane starts", next === true);
    const told = await until(() => (lastMessage(ticket("LIVE-2").threads.build ?? "").includes("LIVE-4: Typo on the greeting") ? true : null));
    check("its builder is told about the small bug riding with it", told === true);

    // --- the scripts in kit/, against this real server
    const kit = (script, args = [], options = {}) => {
      try {
        return { code: 0, out: sh(process.execPath, [join(root, "kit", script), ...args], { cwd: repoDir, env: { ...env, BB_BIN: bbBin, FACTORY_BB_PROJECT: project, FACTORY_STATE_DIR: join(work, "state") }, ...options }).trim() };
      } catch (error) {
        return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() };
      }
    };
    rmSync(join(work, "state"), { recursive: true, force: true });
    mkdirSync(join(repoDir, "docs", "plans"), { recursive: true });
    const planText = (title, extra) => `# ${title}\n\n## Surfaces\n\n- \`src/cart.ts\` (new)\n\n**Implementer tier:** Tier 2 - one open cell\n**Builder:** UI - a screen\n${extra}`;
    writeFileSync(join(repoDir, "docs", "plans", "LIVE-20 - Coupons.md"), planText("Coupons", "\n## Plan review - today - reviewer\n"));
    writeFileSync(join(repoDir, "docs", "plans", "LIVE-21 - Gift cards.md"), planText("Gift cards", ""));
    const collected = kit("sequence.mjs", ["collect"]);
    const digest = /board_sha256: ([0-9a-f]{64})/.exec(collected.out)?.[1];
    check("the scheduler reads the board from plans and the real factory, and finds the shared file", collected.code === 0 && /LIVE-20 \/ LIVE-21: src\/cart\.ts/.test(collected.out), collected.out.slice(-600));
    const boardNow = JSON.parse(readFileSync(join(work, "state", "sequence", "board.json"), "utf8")).tickets;
    const rest = boardNow.filter((t) => !["LIVE-20", "LIVE-21"].includes(t.key) && t.step !== "plan");
    const order = { "in-flight": 0, later: 2 };
    rest.sort((a, b) => (order[a.step] ?? 1) - (order[b.step] ?? 1));
    const lanes = [...(rest.length ? [{ name: "Existing", tickets: rest.map((t) => t.key) }] : []), { name: "Coupons", tickets: ["LIVE-20"] }, { name: "Gifts", tickets: ["LIVE-21"] }];
    const schedulePath = join(work, "state", "sequence", "schedule.json");
    writeFileSync(schedulePath, JSON.stringify({ board_sha256: "stale", lanes }));
    check("it refuses a schedule made against an older board", /Stale schedule/.test(kit("sequence.mjs", ["publish"]).out));
    writeFileSync(schedulePath, JSON.stringify({ board_sha256: digest, lanes: lanes.slice(0, -1) }));
    check("it refuses a schedule that leaves a planned ticket out", /LIVE-21 \(review\) has no lane/.test(kit("sequence.mjs", ["publish"]).out));
    writeFileSync(schedulePath, JSON.stringify({ board_sha256: digest, lanes }));
    const published = kit("sequence.mjs", ["publish"]);
    check("an accepted schedule reaches the factory's lanes", published.code === 0 && ticket("LIVE-20")?.lane === "Coupons" && ticket("LIVE-21")?.lane === "Gifts", published.out.slice(-600));
    check("a reviewed plan starts at build on its plan's tier and builder; an unreviewed one starts at plan review", ticket("LIVE-20")?.pipeline === "reviewed" && ticket("LIVE-20")?.tier === 2 && ticket("LIVE-20")?.builder === "ui" && ticket("LIVE-21")?.pipeline === "planned");
    check("the later of two tickets sharing a file waits for the first", JSON.stringify(ticket("LIVE-21")?.waitingOn) === '["LIVE-20"]' && ticket("LIVE-21")?.status === "queued", JSON.stringify(ticket("LIVE-21")));
    sh("git", ["checkout", "-q", "-b", "live-4-typo"], { cwd: repoDir });
    const small = kit("plan-doc.mjs");
    sh("git", ["checkout", "-q", "-b", "live-20-coupons"], { cwd: repoDir });
    const planned = kit("plan-doc.mjs");
    sh("git", ["checkout", "-q", "main"], { cwd: repoDir });
    check("a branch for a small bug riding with a ticket resolves as a small bug, from the factory's own record", small.code === 3 && small.out === "SMALL_BUG: LIVE-4", `${small.code} ${small.out}`);
    check("a branch for a planned ticket resolves to its plan", planned.code === 0 && planned.out.endsWith("LIVE-20 - Coupons.md"), `${planned.code} ${planned.out}`);
    bb(["solo-factor", "cancel", "LIVE-20", "--project", project]);
    bb(["solo-factor", "cancel", "LIVE-21", "--project", project]);
  } finally {
    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} live checks passed.`);
    if (keep) {
      console.log(`Server left running: http://127.0.0.1:${PORT}/plugins/solo-factor/factory  (stop with: kill -- -${server.pid})`);
      server.unref();
    } else {
      stop();
    }
    process.exitCode = failed === 0 && results.length > 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
