import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { heldBy, readTurn, release, renew, tryTake } from './turn.mjs';
import { ciState, holdsTurn, landBlocker, latestCheck, repoSlug } from './ship-turn.mjs';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-turn-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const A = { holder: '/ws/a', branch: 'app-1-a' };
const B = { holder: '/ws/b', branch: 'app-2-b' };
const MIN = 60_000;

test('a held turn blocks another worktree and names the holder', () => {
  const { dir, done } = fixture();
  try {
    assert.equal(tryTake({ dir, names: ['api', 'worker'], ...A, now: 0 }).ok, true);
    const blocked = tryTake({ dir, names: ['api'], ...B, now: MIN });
    assert.equal(blocked.ok, false);
    assert.deepEqual(blocked.blockers.map((b) => [b.name, b.branch]), [['api', 'app-1-a']]);
  } finally { done(); }
});

test('taking is all or nothing, so two branches cannot each hold half', () => {
  const { dir, done } = fixture();
  try {
    tryTake({ dir, names: ['worker'], ...A, now: 0 });
    assert.equal(tryTake({ dir, names: ['api', 'worker'], ...B, now: MIN }).ok, false);
    assert.equal(readTurn(dir, 'api'), null);
    assert.equal(tryTake({ dir, names: ['api'], ...A, now: 2 * MIN }).ok, true);
  } finally { done(); }
});

test('a different turn is free while another is held', () => {
  const { dir, done } = fixture();
  try {
    tryTake({ dir, names: ['api'], ...A, now: 0 });
    assert.equal(tryTake({ dir, names: ['worker'], ...B, now: MIN }).ok, true);
  } finally { done(); }
});

test('an unreleased turn expires and can then be taken', () => {
  const { dir, done } = fixture();
  try {
    tryTake({ dir, names: ['api'], ...A, now: 0, turnMinutes: 45 });
    assert.equal(tryTake({ dir, names: ['api'], ...B, now: 44 * MIN }).ok, false);
    assert.equal(tryTake({ dir, names: ['api'], ...B, now: 46 * MIN }).ok, true);
    assert.equal(readTurn(dir, 'api').holder, B.holder);
  } finally { done(); }
});

test('renew extends only what this worktree still holds and keeps its start time', () => {
  const { dir, done } = fixture();
  try {
    tryTake({ dir, names: ['api'], ...A, now: 0, turnMinutes: 45 });
    renew({ dir, ...A, now: 30 * MIN, turnMinutes: 45 });
    const turn = readTurn(dir, 'api');
    assert.equal(turn.takenAt, 0);
    assert.equal(turn.expiresAt, 75 * MIN);
    assert.deepEqual(renew({ dir, ...B, now: 30 * MIN }).names, []);
  } finally { done(); }
});

test("release gives back only this worktree's turns", () => {
  const { dir, done } = fixture();
  try {
    tryTake({ dir, names: ['api'], ...A, now: 0 });
    tryTake({ dir, names: ['worker'], ...B, now: 0 });
    assert.deepEqual(release({ dir, holder: A.holder, names: [] }), ['api']);
    assert.deepEqual(release({ dir, holder: A.holder, names: ['worker'] }), []);
    assert.deepEqual(heldBy(dir, B.holder, MIN), ['worker']);
  } finally { done(); }
});

const PR = { state: 'open', draft: false, base: { ref: 'main' }, head: { ref: 'app-1-a', sha: 'abc' } };
const READY = { holdsTurn: true, pr: PR, localHead: 'abc', branch: 'app-1-a', baseIsAncestor: true };

test('only one worktree holds the ship turn, and it frees itself when abandoned', () => {
  const { dir, done } = fixture();
  try {
    tryTake({ dir, names: ['ship'], ...A, now: 0, turnMinutes: 30 });
    assert.equal(holdsTurn(dir, A.holder, MIN), true);
    assert.equal(holdsTurn(dir, B.holder, MIN), false);
    assert.equal(holdsTurn(dir, A.holder, 31 * MIN), false);
  } finally { done(); }
});

test('a branch that holds the turn, matches its PR and contains the base may land', () => {
  assert.equal(landBlocker(READY), null);
});

test('landing is refused without the turn, when the base moved, or when the PR is not this exact head', () => {
  assert.match(landBlocker({ ...READY, holdsTurn: false }), /does not hold the ship turn/);
  assert.match(landBlocker({ ...READY, baseIsAncestor: false }), /has commits this branch lacks/);
  assert.match(landBlocker({ ...READY, localHead: 'def' }), /is not local HEAD/);
  assert.match(landBlocker({ ...READY, branch: 'other' }), /is not this worktree's branch/);
});

test('landing is refused for a merged, draft or wrong-base PR', () => {
  assert.match(landBlocker({ ...READY, pr: { ...PR, state: 'closed', merged: true } }), /already merged/);
  assert.match(landBlocker({ ...READY, pr: { ...PR, draft: true } }), /draft/);
  assert.match(landBlocker({ ...READY, pr: { ...PR, base: { ref: 'release' } } }), /targets release/);
  assert.equal(landBlocker({ ...READY, base: 'develop', pr: { ...PR, base: { ref: 'develop' } } }), null);
});

test('waiting for CI without merging needs neither the turn nor a current base', () => {
  assert.equal(landBlocker({ ...READY, holdsTurn: false, baseIsAncestor: false, merge: false }), null);
});

test('only the newest run of the required check counts, and it must finish green', () => {
  const runs = [
    { id: 1, name: 'ci', status: 'completed', conclusion: 'failure' },
    { id: 3, name: 'lint', status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'ci', status: 'completed', conclusion: 'success' },
  ];
  assert.equal(latestCheck(runs, 'ci').id, 2);
  assert.equal(ciState(latestCheck(runs, 'ci')), 'passed');
  assert.equal(ciState(latestCheck(runs, 'lint')), 'failed');
  assert.equal(ciState(latestCheck(runs, 'absent')), 'waiting');
  assert.equal(ciState({ status: 'in_progress' }), 'waiting');
});

test('the repository is read from a GitHub remote in either form', () => {
  assert.equal(repoSlug('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(repoSlug('https://github.com/acme/app'), 'acme/app');
  assert.equal(repoSlug('https://gitlab.com/acme/app.git'), null);
});
