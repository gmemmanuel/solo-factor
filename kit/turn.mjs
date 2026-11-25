#!/usr/bin/env node
// Taking turns on something only one branch may use at a time: a dev deploy
// slot, a staging database, a test device. Branches build in parallel and hold
// a turn only while they use the shared thing.
//
// A turn is one small file per name, in a directory shared by every worktree
// of this repository on this machine. It names the worktree holding it and
// expires on its own, so a session that ends without releasing cannot block
// the others for long.
//
//   node scripts/factory/turn.mjs take api worker     wait for, then hold, both
//   node scripts/factory/turn.mjs renew               extend every turn this worktree holds
//   node scripts/factory/turn.mjs release [name ...]  give back (all, when none named)
//   node scripts/factory/turn.mjs status              who holds what
//
// Exit codes: 0 done, 2 usage, 75 no turn within the wait limit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, repoRoot, sharedDir } from './config.mjs';

const POLL_SECONDS = 20;
const TURN_NAME = /^[a-z0-9][a-z0-9_.-]*$/;

function turnPath(dir, name) {
  return path.join(dir, `${name}.json`);
}

export function readTurn(dir, name) {
  try {
    const turn = JSON.parse(readFileSync(turnPath(dir, name), 'utf8'));
    return turn && typeof turn.holder === 'string' && Number.isFinite(turn.expiresAt) ? turn : null;
  } catch {
    return null;
  }
}

function writeTurn(dir, name, turn, exclusive) {
  writeFileSync(turnPath(dir, name), `${JSON.stringify(turn)}\n`, { flag: exclusive ? 'wx' : 'w' });
}

/**
 * Take every named turn or none. Returns the blocking turns when any is held
 * by another worktree and still live; a partial hold would let two branches
 * each keep one thing the other needs.
 */
export function tryTake({ dir, names, holder, branch, now, turnMinutes = 45 }) {
  mkdirSync(dir, { recursive: true });
  const wanted = [...new Set(names)].sort();
  const blockers = [];
  for (const name of wanted) {
    const turn = readTurn(dir, name);
    if (turn && turn.holder !== holder && turn.expiresAt > now) blockers.push({ name, ...turn });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  const expiresAt = now + turnMinutes * 60_000;
  const newlyTaken = [];
  for (const name of wanted) {
    const existing = readTurn(dir, name);
    const turn = { holder, branch, takenAt: existing?.holder === holder ? existing.takenAt : now, expiresAt };
    if (existing?.holder === holder) {
      writeTurn(dir, name, turn, false);
      continue;
    }
    // Expired or unreadable: clear it, then create exclusively so two worktrees
    // racing for the same free turn cannot both win.
    rmSync(turnPath(dir, name), { force: true });
    try {
      writeTurn(dir, name, turn, true);
      newlyTaken.push(name);
    } catch {
      for (const taken of newlyTaken) rmSync(turnPath(dir, taken), { force: true });
      const winner = readTurn(dir, name);
      return { ok: false, blockers: winner ? [{ name, ...winner }] : [] };
    }
  }
  return { ok: true, names: wanted, expiresAt };
}

export function heldBy(dir, holder, now) {
  let files = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((file) => file.slice(0, -'.json'.length))
    .filter((name) => {
      const turn = readTurn(dir, name);
      return turn && turn.holder === holder && turn.expiresAt > now;
    });
}

export function renew({ dir, holder, branch, now, turnMinutes = 45 }) {
  const names = heldBy(dir, holder, now);
  if (names.length === 0) return { ok: true, names: [] };
  return tryTake({ dir, names, holder, branch, now, turnMinutes });
}

export function release({ dir, holder, names }) {
  const wanted = names.length > 0 ? names : heldBy(dir, holder, 0);
  const released = [];
  for (const name of wanted) {
    const turn = readTurn(dir, name);
    if (turn && turn.holder === holder) {
      rmSync(turnPath(dir, name), { force: true });
      released.push(name);
    }
  }
  return released;
}

export function describe(blocker, now) {
  const minutes = Math.max(1, Math.round((blocker.expiresAt - now) / 60_000));
  const what = blocker.name ? `${blocker.name}: ` : '';
  return `${what}held by ${blocker.branch || 'unknown branch'} (${blocker.holder}); frees itself in ${minutes} min unless renewed`;
}

export function currentBranch(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Pulls `--flag <positive number>` out of args, in place. */
export function numberFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  args.splice(index, 2);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} needs a positive number.`);
    process.exit(2);
  }
  return value;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for, then hold, the named turns. Exits 75 when the wait runs out. */
export async function takeOrWait({ dir, names, holder, branch, turnMinutes, waitMinutes, label }) {
  const deadline = Date.now() + waitMinutes * 60_000;
  let announced = '';
  for (;;) {
    const now = Date.now();
    const result = tryTake({ dir, names, holder, branch, now, turnMinutes });
    if (result.ok) return result;
    const message = result.blockers.map((blocker) => describe(blocker, now)).join('\n  ');
    if (message !== announced) {
      console.error(`Waiting for ${label}:\n  ${message}`);
      announced = message;
    }
    if (now >= deadline) {
      console.error(`No turn after ${waitMinutes} min. Do not go around the holder; report this wait instead.`);
      process.exit(75);
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const root = repoRoot();
  const config = loadConfig(root);
  const holder = root;
  const branch = currentBranch(root);
  const dir = sharedDir(root, 'turns');
  const turnMinutes = numberFlag(rest, '--minutes', config.turns.minutes);
  const waitMinutes = numberFlag(rest, '--wait-minutes', config.turns.waitMinutes);
  const names = rest;
  if (names.some((name) => !TURN_NAME.test(name))) {
    console.error('Turn names are lower-case slugs, such as api or staging-db.');
    process.exit(2);
  }

  if (command === 'status') {
    const now = Date.now();
    let any = false;
    for (const file of (() => { try { return readdirSync(dir); } catch { return []; } })()) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -'.json'.length);
      const turn = readTurn(dir, name);
      if (!turn || turn.expiresAt <= now) continue;
      any = true;
      console.log(describe({ name, ...turn }, now));
    }
    if (!any) console.log('No turns are held.');
    return;
  }
  if (command === 'release') {
    const released = release({ dir, holder, names });
    console.log(released.length > 0 ? `Released: ${released.join(', ')}.` : 'This worktree held no turn.');
    return;
  }
  if (command === 'renew') {
    const result = renew({ dir, holder, branch, now: Date.now(), turnMinutes });
    if (result.names?.length > 0) console.log(`Renewed: ${result.names.join(', ')}.`);
    return;
  }
  if (command === 'take') {
    if (names.length === 0) {
      console.error('take needs at least one name.');
      process.exit(2);
    }
    const result = await takeOrWait({ dir, names, holder, branch, turnMinutes, waitMinutes, label: 'a turn' });
    console.log(`Holding ${result.names.join(', ')} for ${turnMinutes} min. Renew while you use it; release when you are done.`);
    return;
  }
  console.error('usage: turn.mjs take <name...> [--minutes N] [--wait-minutes N] | renew | release [name...] | status');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
