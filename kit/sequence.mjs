#!/usr/bin/env node
// Swimlanes: which tickets can be built side by side, and which must wait.
//
// The split of work is deliberate. Scripts collect the evidence (open tickets,
// each plan's declared files, what in-flight branches really changed, the
// tracker's blockers) and enforce the rules. The Architect makes the
// judgments a script cannot: whether two tickets that touch the same file
// really collide, and which lane a new ticket belongs in. The judgments live
// in a schedule file the Architect writes; this script refuses a schedule that
// is stale, incomplete or contradicts the evidence, and only a schedule it
// accepts reaches the factory.
//
//   node scripts/factory/sequence.mjs collect     gather the board, print overlaps and blockers
//   node scripts/factory/sequence.mjs validate    check the schedule against the board
//   node scripts/factory/sequence.mjs show        print the lanes as a table
//   node scripts/factory/sequence.mjs publish     validate, then sync the factory's lanes
//   node scripts/factory/sequence.mjs refresh     no judgment: carry the last schedule forward
//   node scripts/factory/sequence.mjs reconcile [--apply]   make tracker labels match the plans
//
// Exit codes: 0 done, 1 the schedule or the evidence is wrong, 3 (refresh) a
// ticket has no lane yet or the carried schedule no longer fits: the Architect
// must place it.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { keyRegex, loadConfig, mainCheckout, plansDir, repoRoot, sharedDir } from './config.mjs';
import { board as linearBoard, resolveKey, setLabels } from './linear.mjs';
import { bbProject, factoryItems, planFiles } from './plan-doc.mjs';
import { builderOf, planReviewed, surfacesOf, tierOf } from './plan-surfaces.mjs';

const CLOSED = new Set(['done', 'archived', 'cancelled']);
const PIPELINE_BY_STEP = { review: 'planned', build: 'reviewed', 'small-bug': 'small-bug', later: 'planned' };

function require_(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- evidence

/**
 * One ticket's next step, from evidence only:
 *   in-flight  the factory is working it, or the tracker says it has started
 *   later      parked by the founder
 *   small-bug  its ticket is its plan
 *   build      a plan exists and an independent review of it is recorded
 *   review     a plan exists
 *   queued     no plan file found, but the factory already has it queued (by
 *              hand, or planned elsewhere): it keeps its place and its pipeline
 *   plan       no plan yet (never sent to the factory by a schedule)
 */
export function stepOf({ plan, reviewed, smallBug, later, inFlight, queued }) {
  if (inFlight) return 'in-flight';
  if (later) return 'later';
  if (smallBug) return 'small-bug';
  if (plan) return reviewed ? 'build' : 'review';
  return queued ? 'queued' : 'plan';
}

/**
 * Merge the three sources into one board. Pure.
 *   plans    [{ key, title, file, surfaces|null, tier, builder, reviewed }]
 *   tracker  [{ key, title, url, priority, stateType, labels, blockedBy }] or null (no tracker)
 *   factory  the factory's items, or null (bb not reachable)
 *   branches { KEY: [files the branch really changed] }
 */
export function buildBoard({ plans, tracker, factory, branches = {}, labels }) {
  const byKey = new Map();
  const entry = (key) => {
    const upper = key.toUpperCase();
    if (!byKey.has(upper)) byKey.set(upper, { key: upper, title: upper, url: '', priority: 0, labels: [], blockedBy: [], plan: null, surfaces: null, tier: null, builder: null, reviewed: false, factoryStatus: null, pipeline: null, smallBug: false, later: false, started: false });
    return byKey.get(upper);
  };
  const live = (factory ?? []).filter((item) => item.status !== 'cancelled');
  const finished = new Set(live.filter((item) => CLOSED.has(item.status)).map((item) => item.key.toUpperCase()));

  if (tracker) {
    // With a tracker, the tracker decides which tickets are open.
    for (const issue of tracker) Object.assign(entry(issue.key), { title: issue.title, url: issue.url ?? '', priority: issue.priority ?? 0, labels: issue.labels ?? [], blockedBy: (issue.blockedBy ?? []).map((key) => key.toUpperCase()), started: issue.stateType === 'started' });
  }
  for (const plan of plans) {
    // Without one, a plan that the factory has not finished is open work.
    if (!tracker && finished.has(plan.key.toUpperCase())) continue;
    if (tracker && !byKey.has(plan.key.toUpperCase())) continue;
    const ticket = entry(plan.key);
    Object.assign(ticket, { plan: plan.file, surfaces: plan.surfaces, tier: plan.tier, builder: plan.builder, reviewed: plan.reviewed });
    if (ticket.title === ticket.key && plan.title) ticket.title = plan.title;
  }
  for (const item of live) {
    const upper = item.key.toUpperCase();
    if (CLOSED.has(item.status)) continue;
    if (tracker && !byKey.has(upper)) continue;
    const ticket = entry(upper);
    if (ticket.title === ticket.key) ticket.title = item.title;
    Object.assign(ticket, { factoryStatus: item.status, pipeline: item.pipeline ?? null, smallBug: item.pipeline === 'small-bug', later: item.parked === true, tier: ticket.tier ?? item.tier ?? null, builder: ticket.builder ?? item.builder ?? null });
  }

  const tickets = [...byKey.values()].map((ticket) => {
    const smallBug = ticket.smallBug || ticket.labels.includes(labels.smallBug);
    const inFlight = (ticket.factoryStatus !== null && ticket.factoryStatus !== 'queued') || ticket.started;
    const later = (ticket.later || ticket.labels.includes(labels.later)) && !inFlight;
    const reviewed = tracker ? ticket.labels.includes(labels.planReviewed) : ticket.reviewed;
    const actual = branches[ticket.key] ?? [];
    const declared = ticket.surfaces;
    return {
      key: ticket.key,
      title: ticket.title,
      url: ticket.url,
      priority: ticket.priority,
      step: stepOf({ plan: ticket.plan, reviewed, smallBug, later, inFlight, queued: ticket.factoryStatus === 'queued' }),
      pipeline: ticket.pipeline,
      tier: ticket.tier,
      builder: ticket.builder,
      plan: ticket.plan,
      blockedBy: ticket.blockedBy.filter((key) => byKey.has(key)).sort(),
      // What it will touch: what its plan declares plus what its branch already changed.
      files: [...new Set([...(declared ?? []), ...actual])].sort(),
      actualFiles: [...actual].sort(),
      // A surface is measured when a plan declared it. A small bug's brief or an unplanned ticket is not.
      surfaceMeasured: declared !== null && declared.length > 0,
    };
  });
  tickets.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  return { tickets };
}

export function boardDigest(board) {
  return createHash('sha256').update(JSON.stringify(board.tickets)).digest('hex');
}

/** Pairs of tickets that declare or have changed the same file, minus files too widely shared to mean anything. */
export function overlaps(board, ignore = []) {
  const ignored = (file) => ignore.some((fragment) => file === fragment || file.endsWith(`/${fragment}`));
  const pairs = [];
  for (let a = 0; a < board.tickets.length; a += 1) {
    for (let b = a + 1; b < board.tickets.length; b += 1) {
      const left = board.tickets[a];
      const right = board.tickets[b];
      const rightFiles = new Set(right.files);
      const files = left.files.filter((file) => rightFiles.has(file) && !ignored(file));
      if (files.length > 0) pairs.push({ a: left.key, b: right.key, files });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------- the rules

/**
 * Check a schedule against the board and work out who waits for whom. Throws
 * with every problem found; returns the lanes ready to publish.
 *
 *   schedule { board_sha256, lanes: [{ name, tickets: [KEY…] }],
 *              coordinate: [{ a, b, files, reason, evidence }],
 *              surface_reviews: { KEY: { files, evidence } } }
 *   previous the last published schedule, or null
 */
export function validate({ board, schedule, previous = null, maxLanes = 4, ignore = [], digest = boardDigest(board) }) {
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  require_(schedule && Array.isArray(schedule.lanes), 'The schedule needs a "lanes" list.');
  require_(schedule.board_sha256 === digest, 'Stale schedule: the board changed since these judgments were made. Run collect, review what changed, and set board_sha256 to the new value.');

  // A reviewed surface replaces a declared one, but can never hide what a branch already changed.
  const tickets = new Map(board.tickets.map((ticket) => [ticket.key, { ...ticket }]));
  for (const [key, review] of Object.entries(schedule.surface_reviews ?? {})) {
    const ticket = tickets.get(key);
    check(ticket && Array.isArray(review.files) && review.files.length > 0 && review.evidence, `surface_reviews.${key}: needs a ticket on the board, files and evidence.`);
    if (!ticket || !Array.isArray(review.files)) continue;
    check(ticket.actualFiles.every((file) => review.files.includes(file)), `surface_reviews.${key}: cannot leave out files its branch has already changed.`);
    ticket.files = [...new Set(review.files)].sort();
    ticket.surfaceMeasured = true;
  }

  // Every ticket with something to schedule is in exactly one lane.
  const schedulable = [...tickets.values()].filter((ticket) => ticket.step !== 'plan');
  const place = new Map();
  schedule.lanes.forEach((lane, laneIndex) => {
    check(typeof lane.name === 'string' && lane.name.trim() !== '', `Lane ${laneIndex + 1} needs a name.`);
    check(Array.isArray(lane.tickets) && lane.tickets.length > 0, `Lane "${lane.name}" has no tickets; remove it.`);
    (lane.tickets ?? []).forEach((key, position) => {
      check(tickets.has(key), `${key} (lane "${lane.name}") is not on the board. Remove it.`);
      check(!place.has(key), `${key} is in more than one lane.`);
      place.set(key, { lane: lane.name, laneIndex, position });
    });
  });
  check(new Set(schedule.lanes.map((lane) => lane.name)).size === schedule.lanes.length, 'Two lanes share a name.');
  for (const ticket of schedulable) check(place.has(ticket.key), `${ticket.key} (${ticket.step}) has no lane.`);
  for (const key of place.keys()) check(tickets.get(key)?.step !== 'plan', `${key} has no plan yet; a ticket enters a lane once it is planned.`);

  // More lanes than the limit is allowed only while that many are already in flight.
  const inFlightLanes = schedule.lanes.filter((lane) => (lane.tickets ?? []).some((key) => tickets.get(key)?.step === 'in-flight')).length;
  check(schedule.lanes.length <= Math.max(maxLanes, inFlightLanes), `${schedule.lanes.length} lanes, but the limit is ${maxLanes}. Queue new work behind the lane it is closest to.`);

  // A ticket never changes lanes: lanes are sticky so running work is not reshuffled around new work.
  if (previous) {
    const before = new Map(previous.lanes.flatMap((lane) => lane.tickets.map((key) => [key, lane.name])));
    const moves = new Set(schedule.moved ?? []);
    for (const [key, where] of place) {
      const was = before.get(key);
      check(!was || was === where.lane || moves.has(key), `${key} moved from lane "${was}" to "${where.lane}". A ticket keeps its lane; list it under "moved" if the founder asked for this.`);
    }
  }

  // Within a lane: work in flight leads, parked work trails.
  for (const lane of schedule.lanes) {
    const steps = (lane.tickets ?? []).map((key) => tickets.get(key)?.step);
    const firstWaiting = steps.findIndex((step) => step !== 'in-flight');
    check(firstWaiting < 0 || !steps.slice(firstWaiting).includes('in-flight'), `Lane "${lane.name}": a ticket in flight sits behind one that has not started. Work in flight leads its lane.`);
    const firstLater = steps.indexOf('later');
    check(firstLater < 0 || steps.slice(firstLater).every((step) => step === 'later'), `Lane "${lane.name}": a parked ticket sits ahead of one that is not parked.`);
  }

  // A total order (slot in lane, then lane) decides who waits when two lanes meet. It cannot cycle.
  const rank = (key) => { const where = place.get(key); return where.position * 1000 + where.laneIndex; };
  const waits = new Map([...place.keys()].map((key) => [key, new Set()]));

  for (const ticket of schedulable) {
    if (!place.has(ticket.key)) continue;
    for (const blocker of ticket.blockedBy) {
      if (!place.has(blocker)) {
        // The blocker is open but not scheduled (it has no plan yet): nothing may start ahead of it.
        waits.get(ticket.key).add(blocker);
        continue;
      }
      const mine = place.get(ticket.key);
      const theirs = place.get(blocker);
      if (mine.lane === theirs.lane) check(theirs.position < mine.position, `${ticket.key} is blocked by ${blocker} but sits ahead of it in lane "${mine.lane}".`);
      else waits.get(ticket.key).add(blocker);
    }
  }

  const waived = new Map();
  for (const entry of schedule.coordinate ?? []) {
    check(entry.a && entry.b && Array.isArray(entry.files) && entry.files.length > 0 && entry.reason && entry.evidence, `coordinate ${entry.a ?? '?'}/${entry.b ?? '?'}: needs a, b, files, reason and evidence.`);
    waived.set([entry.a, entry.b].sort().join('|'), new Set(entry.files ?? []));
  }
  const scheduledBoard = { tickets: [...tickets.values()].filter((ticket) => place.has(ticket.key)) };
  const live = overlaps(scheduledBoard, ignore);
  const liveKeys = new Set(live.map((pair) => [pair.a, pair.b].sort().join('|')));
  for (const key of waived.keys()) check(liveKeys.has(key), `coordinate ${key.replace('|', '/')}: these tickets no longer share a file. Remove the entry.`);
  for (const pair of live) {
    if (place.get(pair.a).lane === place.get(pair.b).lane) continue;
    const judged = waived.get([pair.a, pair.b].sort().join('|'));
    const unjudged = pair.files.filter((file) => !judged?.has(file));
    if (unjudged.length === 0) continue;
    // Not judged independent: the later one waits for the earlier one to merge.
    const [first, second] = rank(pair.a) <= rank(pair.b) ? [pair.a, pair.b] : [pair.b, pair.a];
    waits.get(second).add(first);
  }

  if (problems.length > 0) throw new Error(`The schedule was refused:\n- ${problems.join('\n- ')}`);

  const unmeasured = scheduledBoard.tickets.filter((ticket) => !ticket.surfaceMeasured && ticket.step !== 'small-bug').map((ticket) => ticket.key);
  const lanes = schedule.lanes.map((lane) => ({
    name: lane.name,
    tickets: lane.tickets.map((key) => ({ ...tickets.get(key), waitingOn: [...waits.get(key)].sort() })),
  }));
  return { lanes, unmeasured };
}

/** What `bb solo-factor sync` takes. Work in flight is left out: the factory already has it and a sync never touches it. */
export function toSync(result, { ticketUrl = '' } = {}) {
  const leftOut = [];
  const lanes = result.lanes.map((lane) => ({
    name: lane.name,
    items: lane.tickets.flatMap((ticket) => {
      if (ticket.step === 'in-flight') {
        leftOut.push(`${ticket.key}: in flight`);
        return [];
      }
      const link = ticket.url || (ticketUrl ? ticketUrl.replace('{key}', ticket.key) : '');
      return [{
        key: ticket.key,
        title: ticket.title,
        // A ticket the factory already holds without a plan file keeps the pipeline it was queued on.
        pipeline: PIPELINE_BY_STEP[ticket.step] ?? ticket.pipeline ?? 'planned',
        ...(ticket.step === 'later' ? { parked: true } : {}),
        ...(Number.isInteger(ticket.tier) ? { tier: ticket.tier } : {}),
        ...(ticket.builder ? { builder: ticket.builder } : {}),
        ...(ticket.waitingOn.length > 0 ? { waitingOn: ticket.waitingOn } : {}),
        brief: [ticket.plan ? `Plan: ${ticket.plan}` : '', link].filter(Boolean).join('\n'),
      }];
    }),
  }));
  return { lanes, leftOut };
}

/**
 * Carry the last schedule onto a fresh board with no judgment: drop tickets
 * that left, drop lanes that emptied, lead each lane with what is in flight,
 * and drop overlap decisions whose pair no longer overlaps. Never places a
 * ticket: returns `unplaced` instead.
 */
export function carryForward({ board, previous, ignore = [] }) {
  const tickets = new Map(board.tickets.map((ticket) => [ticket.key, ticket]));
  const lanes = previous.lanes
    .map((lane) => {
      const kept = lane.tickets.filter((key) => tickets.has(key) && tickets.get(key).step !== 'plan');
      const order = (key) => ({ 'in-flight': 0, later: 2 })[tickets.get(key).step] ?? 1;
      return { name: lane.name, tickets: kept.map((key, index) => ({ key, index })).sort((a, b) => order(a.key) - order(b.key) || a.index - b.index).map((item) => item.key) };
    })
    .filter((lane) => lane.tickets.length > 0);
  const placed = new Set(lanes.flatMap((lane) => lane.tickets));
  const stillOverlap = new Set(overlaps(board, ignore).map((pair) => [pair.a, pair.b].sort().join('|')));
  return {
    schedule: {
      board_sha256: boardDigest(board),
      lanes,
      coordinate: (previous.coordinate ?? []).filter((entry) => placed.has(entry.a) && placed.has(entry.b) && stillOverlap.has([entry.a, entry.b].sort().join('|'))),
      surface_reviews: Object.fromEntries(Object.entries(previous.surface_reviews ?? {}).filter(([key]) => placed.has(key))),
    },
    unplaced: board.tickets.filter((ticket) => ticket.step !== 'plan' && !placed.has(ticket.key)).map((ticket) => ticket.key),
  };
}

export function renderTable(result) {
  const cell = (ticket) => `${ticket.key} ${ticket.step}${ticket.waitingOn.length > 0 ? ` (after ${ticket.waitingOn.join(', ')})` : ''} — ${ticket.title}`;
  const rows = result.lanes.map((lane) => `| ${lane.name} | ${cell(lane.tickets[0])} | ${lane.tickets.slice(1).map(cell).join('<br>') || ' '} |`);
  return ['| Lane | Right now | Next up |', '|---|---|---|', ...rows].join('\n');
}

// ---------------------------------------------------------------- the machine

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function readPlans(root, config) {
  const dir = plansDir(root, config);
  const pattern = keyRegex(config);
  const plans = [];
  for (const file of planFiles(dir)) {
    const match = pattern.exec(file);
    if (!match) continue;
    const full = path.join(dir, file);
    const body = readFileSync(full, 'utf8');
    plans.push({
      key: match[1].toUpperCase(),
      title: file.replace(/\.md$/, '').replace(new RegExp(`^${match[1]}\\s*-\\s*`, 'i'), ''),
      file: full,
      surfaces: surfacesOf(body, root),
      tier: tierOf(body),
      builder: builderOf(body),
      reviewed: planReviewed(body),
    });
  }
  return plans;
}

/** Files each ticket's branch has really changed against the base branch, by ticket key. */
function readBranches(root, config) {
  const pattern = keyRegex(config);
  const out = {};
  let refs = [];
  try {
    git(root, ['fetch', '--quiet', '--prune', 'origin']);
  } catch {
    // Offline: local branches still count.
  }
  try {
    refs = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']).split('\n').filter(Boolean);
  } catch {
    return out;
  }
  for (const ref of refs) {
    const match = pattern.exec(ref.replace(/^origin\//, ''));
    if (!match) continue;
    try {
      const files = git(root, ['diff', '--name-only', `origin/${config.baseBranch}...${ref}`]).split('\n').filter(Boolean);
      const key = match[1].toUpperCase();
      out[key] = [...new Set([...(out[key] ?? []), ...files])];
    } catch {
      // A ref that cannot be compared contributes nothing.
    }
  }
  return out;
}

async function collect(root, config) {
  const tracker = config.tracker.kind === 'linear'
    ? await linearBoard({ team: config.tracker.team, openStates: config.tracker.openStates }, { key: resolveKey(config) })
    : null;
  const factory = factoryItems(root, config);
  require_(tracker || factory, 'Neither a tracker nor the factory could be read (is the bb app open?). A board built from plans alone would bring shipped tickets back.');
  return buildBoard({ plans: readPlans(root, config), tracker, factory, branches: readBranches(root, config), labels: config.tracker.labels });
}

function stateFiles(root) {
  const dir = sharedDir(root, 'sequence');
  mkdirSync(dir, { recursive: true });
  return { dir, board: path.join(dir, 'board.json'), schedule: path.join(dir, 'schedule.json'), published: path.join(dir, 'published.json') };
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function publish(root, config, result) {
  const { lanes, leftOut } = toSync(result, { ticketUrl: config.tracker.url });
  const bin = process.env.BB_BIN || (existsSync(path.join(os.homedir(), '.bb', 'bin', 'bb')) ? path.join(os.homedir(), '.bb', 'bin', 'bb') : 'bb');
  const project = bbProject(root, config);
  const sent = spawnSync(bin, ['solo-factor', 'sync', JSON.stringify({ lanes }), ...(project ? ['--project', project] : [])], { encoding: 'utf8' });
  require_(sent.status === 0, `Could not update the factory (is the bb app open?): ${(sent.stderr || sent.stdout || '').trim()}`);
  console.log(sent.stdout.trim());
  for (const line of leftOut) console.log(`not sent — ${line}`);
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  const root = repoRoot();
  const config = loadConfig(root);
  const files = stateFiles(mainCheckout(root));
  const ignore = config.sequence.ignore;
  const checked = (board, schedule) => validate({ board, schedule, previous: readJson(files.published), maxLanes: config.lanes.max, ignore });

  if (command === 'collect') {
    const board = await collect(root, config);
    writeFileSync(files.board, `${JSON.stringify(board, null, 2)}\n`);
    console.log(`Board: ${board.tickets.length} open ticket(s). board_sha256: ${boardDigest(board)}`);
    for (const ticket of board.tickets) console.log(`  ${ticket.key}  ${ticket.step.padEnd(9)}  ${ticket.surfaceMeasured ? `${ticket.files.length} file(s)` : 'surface not declared'}${ticket.blockedBy.length ? `  blocked by ${ticket.blockedBy.join(', ')}` : ''}  — ${ticket.title}`);
    const shared = overlaps(board, ignore);
    console.log(shared.length ? '\nShared files to judge (same lane, a coordinate entry, or the later ticket waits):' : '\nNo two tickets share a file.');
    for (const pair of shared) console.log(`  ${pair.a} / ${pair.b}: ${pair.files.join(', ')}`);
    console.log(`\nBoard: ${files.board}\nWrite the schedule to: ${files.schedule}`);
    return 0;
  }
  if (command === 'reconcile') {
    require_(config.tracker.kind === 'linear', 'reconcile needs tracker.kind "linear".');
    const options = { key: resolveKey(config) };
    const board = await linearBoard({ team: config.tracker.team, openStates: config.tracker.openStates }, options);
    const planned = new Set(readPlans(root, config).map((plan) => plan.key));
    const { planWritten, planReviewed: reviewedLabel } = config.tracker.labels;
    let changes = 0;
    for (const issue of board) {
      const add = planned.has(issue.key) && !issue.labels.includes(planWritten) && !issue.labels.includes(reviewedLabel) ? [planWritten] : [];
      // Without a plan there is nothing written and nothing reviewed.
      const remove = planned.has(issue.key) ? [] : [planWritten, reviewedLabel].filter((label) => issue.labels.includes(label));
      if (add.length === 0 && remove.length === 0) continue;
      changes += 1;
      console.log(`${issue.key}: ${[...add.map((label) => `+${label}`), ...remove.map((label) => `-${label}`)].join(' ')}`);
      if (flags.includes('--apply')) await setLabels(issue.key, { add, remove }, options);
    }
    console.log(changes === 0 ? 'Tracker labels match the plans.' : flags.includes('--apply') ? `Corrected ${changes} ticket(s).` : `${changes} ticket(s) would change; rerun with --apply.`);
    return 0;
  }

  const board = command === 'refresh' ? await collect(root, config) : readJson(files.board);
  require_(board, 'No board yet. Run: sequence.mjs collect');

  if (command === 'refresh') {
    writeFileSync(files.board, `${JSON.stringify(board, null, 2)}\n`);
    const previous = readJson(files.published) ?? readJson(files.schedule);
    if (!previous) {
      console.error('No schedule to carry forward. The Architect must write the first one.');
      return 3;
    }
    const { schedule, unplaced } = carryForward({ board, previous, ignore });
    if (unplaced.length > 0) {
      console.error(`No lane yet for: ${unplaced.join(', ')}. The Architect must place ${unplaced.length === 1 ? 'it' : 'them'}.`);
      return 3;
    }
    let result;
    try {
      result = checked(board, schedule);
    } catch (error) {
      console.error(error.message);
      return 3;
    }
    writeFileSync(files.schedule, `${JSON.stringify(schedule, null, 2)}\n`);
    publish(root, config, result);
    writeFileSync(files.published, `${JSON.stringify(schedule, null, 2)}\n`);
    return 0;
  }

  const schedule = readJson(files.schedule);
  require_(schedule, `No schedule yet. Write one to ${files.schedule}`);
  const result = checked(board, schedule);
  if (command === 'validate' || command === 'show') {
    console.log(renderTable(result));
    if (result.unmeasured.length > 0) console.log(`\nSurface not declared, so not verified safe to build alongside others: ${result.unmeasured.join(', ')}`);
    return 0;
  }
  if (command === 'publish') {
    publish(root, config, result);
    writeFileSync(files.published, `${JSON.stringify(schedule, null, 2)}\n`);
    return 0;
  }
  console.error('usage: sequence.mjs collect | validate | show | publish | refresh | reconcile [--apply]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`sequence: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
