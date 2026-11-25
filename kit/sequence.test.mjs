import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS } from './config.mjs';
import { board as linearBoard, linear, resolveKey, setLabels } from './linear.mjs';
import { boardDigest, buildBoard, carryForward, overlaps, renderTable, stepOf, toSync, validate } from './sequence.mjs';

const labels = DEFAULTS.tracker.labels;
const plan = (key, surfaces, extra = {}) => ({ key, title: `${key} title`, file: `/plans/${key} - x.md`, surfaces, tier: 1, builder: 'fullstack', reviewed: true, ...extra });

function boardOf(plans, { tracker = null, factory = [], branches = {} } = {}) {
  return buildBoard({ plans, tracker, factory, branches, labels });
}
const schedule = (board, lanes, extra = {}) => ({ board_sha256: boardDigest(board), lanes, ...extra });

test("a ticket's step comes from evidence, in a fixed order", () => {
  assert.equal(stepOf({ plan: null }), 'plan');
  assert.equal(stepOf({ plan: 'p' }), 'review');
  assert.equal(stepOf({ plan: 'p', reviewed: true }), 'build');
  assert.equal(stepOf({ plan: null, smallBug: true }), 'small-bug');
  assert.equal(stepOf({ plan: 'p', reviewed: true, later: true }), 'later');
  assert.equal(stepOf({ plan: 'p', later: true, inFlight: true }), 'in-flight');
});

test('without a tracker, open work is every plan the factory has not finished', () => {
  const board = boardOf([plan('APP-1', ['a.ts']), plan('APP-2', ['b.ts']), plan('APP-3', ['c.ts'], { reviewed: false })], {
    factory: [{ key: 'APP-1', status: 'done', title: 'x' }, { key: 'APP-2', status: 'running', title: 'x', pipeline: 'reviewed' }, { key: 'APP-9', status: 'queued', title: 'Typo', pipeline: 'small-bug' }],
  });
  assert.deepEqual(board.tickets.map((t) => [t.key, t.step]), [['APP-2', 'in-flight'], ['APP-3', 'review'], ['APP-9', 'small-bug']]);
});

test('with a tracker, the tracker decides what is open, and its labels decide review and parking', () => {
  const tracker = [
    { key: 'APP-1', title: 'One', stateType: 'unstarted', labels: [labels.planReviewed], blockedBy: [] },
    { key: 'APP-2', title: 'Two', stateType: 'unstarted', labels: [], blockedBy: ['APP-1', 'APP-77'] },
    { key: 'APP-3', title: 'Three', stateType: 'unstarted', labels: [labels.later, labels.planReviewed], blockedBy: [] },
    { key: 'APP-4', title: 'Four', stateType: 'started', labels: [], blockedBy: [] },
    { key: 'APP-5', title: 'Five', stateType: 'unstarted', labels: [labels.smallBug], blockedBy: [] },
  ];
  const board = boardOf([plan('APP-1', ['a.ts'], { reviewed: false }), plan('APP-2', ['b.ts']), plan('APP-3', ['c.ts']), plan('APP-8', ['z.ts'])], { tracker });
  assert.deepEqual(board.tickets.map((t) => [t.key, t.step]), [['APP-1', 'build'], ['APP-2', 'review'], ['APP-3', 'later'], ['APP-4', 'in-flight'], ['APP-5', 'small-bug']]);
  // A blocker that is not open no longer blocks; a closed plan with no open ticket is not work.
  assert.deepEqual(board.tickets[1].blockedBy, ['APP-1']);
});

test("a ticket's surface is what its plan declares plus what its branch already changed", () => {
  const board = boardOf([plan('APP-1', ['a.ts']), plan('APP-2', null)], { factory: [], branches: { 'APP-1': ['a.ts', 'extra.ts'] } });
  assert.deepEqual(board.tickets[0].files, ['a.ts', 'extra.ts']);
  assert.equal(board.tickets[1].surfaceMeasured, false);
  assert.deepEqual(overlaps(boardOf([plan('APP-1', ['a.ts', 'package-lock.json']), plan('APP-2', ['a.ts', 'package-lock.json'])]), ['package-lock.json']), [{ a: 'APP-1', b: 'APP-2', files: ['a.ts'] }]);
});

test('independent tickets run side by side; tickets sharing a file in different lanes wait in order', () => {
  const board = boardOf([plan('APP-1', ['a.ts']), plan('APP-2', ['b.ts']), plan('APP-3', ['a.ts'])]);
  const result = validate({ board, schedule: schedule(board, [{ name: 'Cart', tickets: ['APP-1'] }, { name: 'Search', tickets: ['APP-2', 'APP-3'] }]) });
  const waits = Object.fromEntries(result.lanes.flatMap((lane) => lane.tickets.map((t) => [t.key, t.waitingOn])));
  assert.deepEqual(waits, { 'APP-1': [], 'APP-2': [], 'APP-3': ['APP-1'] });
});

test('a judged overlap needs files, a reason and evidence, and then nobody waits', () => {
  const board = boardOf([plan('APP-1', ['strings.ts']), plan('APP-2', ['strings.ts'])]);
  const lanes = [{ name: 'A', tickets: ['APP-1'] }, { name: 'B', tickets: ['APP-2'] }];
  const judged = { a: 'APP-1', b: 'APP-2', files: ['strings.ts'], reason: 'Each adds its own keys.', evidence: 'Both plans, Touch list' };
  assert.deepEqual(validate({ board, schedule: schedule(board, lanes, { coordinate: [judged] }) }).lanes[1].tickets[0].waitingOn, []);
  assert.throws(() => validate({ board, schedule: schedule(board, lanes, { coordinate: [{ ...judged, evidence: '' }] }) }), /needs a, b, files, reason and evidence/);
  const moved = boardOf([plan('APP-1', ['strings.ts']), plan('APP-2', ['other.ts'])]);
  assert.throws(() => validate({ board: moved, schedule: schedule(moved, lanes, { coordinate: [judged] }) }), /no longer share a file/);
});

test('a tracker blocker orders a lane and makes another lane wait', () => {
  const tracker = [
    { key: 'APP-1', title: 'a', stateType: 'unstarted', labels: [labels.planReviewed], blockedBy: [] },
    { key: 'APP-2', title: 'b', stateType: 'unstarted', labels: [labels.planReviewed], blockedBy: ['APP-1'] },
  ];
  const board = boardOf([plan('APP-1', ['a.ts']), plan('APP-2', ['b.ts'])], { tracker });
  assert.throws(() => validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-2', 'APP-1'] }]) }), /blocked by APP-1 but sits ahead/);
  assert.deepEqual(validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-1'] }, { name: 'B', tickets: ['APP-2'] }]) }).lanes[1].tickets[0].waitingOn, ['APP-1']);
});

test('a schedule is refused when stale, incomplete, duplicated, over the lane limit, or reshuffled', () => {
  const board = boardOf([plan('APP-1', ['a.ts']), plan('APP-2', ['b.ts']), plan('APP-3', ['c.ts'])]);
  const all = [{ name: 'A', tickets: ['APP-1'] }, { name: 'B', tickets: ['APP-2'] }, { name: 'C', tickets: ['APP-3'] }];
  assert.throws(() => validate({ board, schedule: { board_sha256: 'old', lanes: all } }), /Stale schedule/);
  assert.throws(() => validate({ board, schedule: schedule(board, all.slice(0, 2)) }), /APP-3 \(build\) has no lane/);
  assert.throws(() => validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-1', 'APP-2', 'APP-3', 'APP-1'] }]) }), /more than one lane/);
  assert.throws(() => validate({ board, schedule: schedule(board, all), maxLanes: 2 }), /limit is 2/);
  const previous = { lanes: [{ name: 'A', tickets: ['APP-1', 'APP-2'] }] };
  assert.throws(() => validate({ board, schedule: schedule(board, all), previous }), /APP-2 moved from lane "A" to "B"/);
  assert.equal(validate({ board, schedule: schedule(board, all, { moved: ['APP-2'] }), previous }).lanes.length, 3);
});

test('work in flight leads its lane, parked work trails it, and unplanned work has no lane', () => {
  const board = boardOf([plan('APP-1', ['a.ts']), plan('APP-2', ['b.ts']), plan('APP-3', ['c.ts'])], {
    factory: [{ key: 'APP-2', status: 'running', title: 'x' }, { key: 'APP-3', status: 'queued', title: 'x', parked: true }],
  });
  assert.throws(() => validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-1', 'APP-2', 'APP-3'] }]) }), /Work in flight leads its lane/);
  assert.throws(() => validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-2', 'APP-3', 'APP-1'] }]) }), /parked ticket sits ahead/);
  const tracked = boardOf([plan('APP-1', ['a.ts'])], { tracker: [{ key: 'APP-1', title: 'a', stateType: 'unstarted', labels: [], blockedBy: [] }, { key: 'APP-4', title: 'unplanned', stateType: 'unstarted', labels: [], blockedBy: [] }] });
  assert.throws(() => validate({ board: tracked, schedule: schedule(tracked, [{ name: 'A', tickets: ['APP-1', 'APP-4'] }]) }), /APP-4 has no plan yet/);
  const result = validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-2', 'APP-1', 'APP-3'] }]) });
  assert.match(renderTable(result), /\| A \| APP-2 in-flight — /);
});

test('a reviewed surface can replace a missing one but never hide what a branch changed', () => {
  const board = boardOf([plan('APP-1', null), plan('APP-2', ['a.ts'])], { branches: { 'APP-1': ['a.ts'] } });
  const lanes = [{ name: 'A', tickets: ['APP-1'] }, { name: 'B', tickets: ['APP-2'] }];
  assert.deepEqual(validate({ board, schedule: schedule(board, lanes) }).unmeasured, ['APP-1']);
  assert.throws(() => validate({ board, schedule: schedule(board, lanes, { surface_reviews: { 'APP-1': { files: ['z.ts'], evidence: 'read it' } } }) }), /cannot leave out files its branch has already changed/);
  assert.deepEqual(validate({ board, schedule: schedule(board, lanes, { surface_reviews: { 'APP-1': { files: ['a.ts', 'z.ts'], evidence: 'read it' } } }) }).unmeasured, []);
});

test('what reaches the factory: where each ticket starts, its tier and builder, who it waits for; never work in flight', () => {
  const board = boardOf([plan('APP-1', ['a.ts'], { reviewed: false, tier: 2, builder: 'ui' }), plan('APP-2', ['a.ts']), plan('APP-3', ['c.ts'])], {
    factory: [{ key: 'APP-3', status: 'running', title: 'x' }, { key: 'APP-5', status: 'queued', title: 'Typo', pipeline: 'small-bug' }],
  });
  const result = validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-3', 'APP-1'] }, { name: 'B', tickets: ['APP-2', 'APP-5'] }]) });
  const { lanes, leftOut } = toSync(result, { ticketUrl: 'https://t.example/{key}' });
  assert.deepEqual(leftOut, ['APP-3: in flight']);
  assert.deepEqual(lanes[0].items.map((i) => [i.key, i.pipeline, i.tier, i.builder, i.waitingOn]), [['APP-1', 'planned', 2, 'ui', ['APP-2']]]);
  assert.deepEqual(lanes[1].items.map((i) => [i.key, i.pipeline]), [['APP-2', 'reviewed'], ['APP-5', 'small-bug']]);
  assert.match(lanes[1].items[0].brief, /Plan: \/plans\/APP-2 - x\.md\nhttps:\/\/t\.example\/APP-2/);
});

test('a ticket queued by hand with no plan file keeps its lane and pipeline instead of being dropped', () => {
  const board = boardOf([plan('APP-1', ['a.ts'])], { factory: [{ key: 'APP-7', status: 'queued', title: 'Planned elsewhere', pipeline: 'reviewed' }] });
  assert.equal(board.tickets[1].step, 'queued');
  assert.throws(() => validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-1'] }]) }), /APP-7 \(queued\) has no lane/);
  const result = validate({ board, schedule: schedule(board, [{ name: 'A', tickets: ['APP-1', 'APP-7'] }]) });
  assert.deepEqual(toSync(result).lanes[0].items.map((i) => [i.key, i.pipeline]), [['APP-1', 'reviewed'], ['APP-7', 'reviewed']]);
});

test('a light refresh carries lanes forward, drops what left, and never places a new ticket', () => {
  const board = boardOf([plan('APP-2', ['b.ts']), plan('APP-3', ['c.ts']), plan('APP-4', ['d.ts'])], { factory: [{ key: 'APP-3', status: 'running', title: 'x' }] });
  const previous = { lanes: [{ name: 'A', tickets: ['APP-1'] }, { name: 'B', tickets: ['APP-2', 'APP-3'] }], coordinate: [{ a: 'APP-1', b: 'APP-2', files: ['x'], reason: 'r', evidence: 'e' }] };
  const { schedule: carried, unplaced } = carryForward({ board, previous });
  assert.deepEqual(carried.lanes, [{ name: 'B', tickets: ['APP-3', 'APP-2'] }]);
  assert.deepEqual(carried.coordinate, []);
  assert.deepEqual(unplaced, ['APP-4']);
});

const fakeFetch = (replies) => {
  const calls = [];
  const impl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const reply = replies.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  };
  return { impl, calls };
};

test('the Linear key comes from the environment or the configured command, never from a file in the repository', () => {
  assert.equal(resolveKey({}, { LINEAR_API_KEY: ' k1 ' }), 'k1');
  assert.equal(resolveKey({ tracker: { keyCommand: 'printf k2' } }, {}), 'k2');
  assert.throws(() => resolveKey({ tracker: {} }, {}), /No Linear API key/);
});

test('a Linear error is an error, and the board pages to the end with only open blockers', async () => {
  const failing = fakeFetch([{ errors: [{ message: 'nope' }] }]);
  await assert.rejects(linear('{ x }', undefined, { key: 'k', fetchImpl: failing.impl }), /Linear rejected the request: nope/);
  const node = (identifier, relations = []) => ({ identifier, title: identifier, url: '', priority: 1, state: { name: 'Todo', type: 'unstarted' }, labels: { nodes: [{ name: 'Small bug' }] }, inverseRelations: { nodes: relations } });
  const paged = fakeFetch([
    { data: { issues: { nodes: [node('APP-1')], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } },
    { data: { issues: { nodes: [node('APP-2', [{ type: 'blocks', issue: { identifier: 'APP-1', state: { type: 'unstarted' } } }, { type: 'blocks', issue: { identifier: 'APP-0', state: { type: 'completed' } } }, { type: 'related', issue: { identifier: 'APP-5', state: { type: 'started' } } }])], pageInfo: { hasNextPage: false } } } },
  ]);
  const issues = await linearBoard({ team: 'APP' }, { key: 'k', fetchImpl: paged.impl });
  assert.deepEqual(issues.map((i) => [i.key, i.blockedBy, i.labels]), [['APP-1', [], ['Small bug']], ['APP-2', ['APP-1'], ['Small bug']]]);
  assert.equal(paged.calls[1].variables.after, 'c1');
});

test('changing labels keeps every other label and reads the ticket back', async () => {
  const issue = (names) => ({ data: { issue: { id: 'i1', identifier: 'APP-1', title: 't', state: { name: 'Todo', type: 'unstarted' }, team: { id: 't1', key: 'APP' }, labels: { nodes: names.map((name) => ({ id: `id-${name}`, name })) } } } });
  const fake = fakeFetch([
    issue(['Bug', 'Plan written']),
    { data: { issueLabels: { nodes: [{ id: 'id-Plan reviewed', name: 'Plan reviewed', team: { id: 't1' } }] } } },
    { data: { issueUpdate: { success: true } } },
    issue(['Bug', 'Plan reviewed']),
  ]);
  const after = await setLabels('APP-1', { add: ['Plan reviewed'], remove: ['Plan written'] }, { key: 'k', fetchImpl: fake.impl });
  assert.deepEqual(after, ['Bug', 'Plan reviewed']);
  assert.deepEqual(fake.calls[2].variables.input.labelIds.sort(), ['id-Bug', 'id-Plan reviewed']);
});
