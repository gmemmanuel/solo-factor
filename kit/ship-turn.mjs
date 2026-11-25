#!/usr/bin/env node
// Taking turns to land on the base branch. Branches that sync with the base
// and run CI side by side go stale the moment the first one merges: each then
// needs another sync and another CI run. Holding one turn from "merge base" to
// "merged" means every CI run tests the tree that actually lands, and the
// branch merges itself when that run is green.
//
//   node scripts/factory/ship-turn.mjs take             wait for, then hold, the turn
//   node scripts/factory/ship-turn.mjs renew            extend it (land renews on its own)
//   node scripts/factory/ship-turn.mjs land --pr 123    wait for exact-head CI, merge, release
//   node scripts/factory/ship-turn.mjs land --pr 123 --no-merge   only wait for CI
//   node scripts/factory/ship-turn.mjs release          give the turn back without merging
//   node scripts/factory/ship-turn.mjs status           who holds it
//
// Exit codes: 0 done (land: merged), 1 CI failed or timed out (turn released)
// or a usage/GitHub error, 4 land refused because the branch is not what would
// merge (turn kept; fix and rerun), 75 no turn within the wait limit.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, repoRoot, sharedDir } from './config.mjs';
import { currentBranch, describe, numberFlag, readTurn, release, renew, sleep, takeOrWait } from './turn.mjs';

const TURN = 'ship';
const POLL_SECONDS = 20;
const API = process.env.FACTORY_GITHUB_API || 'https://api.github.com';
export const NOT_LANDABLE = 4;

export function holdsTurn(dir, holder, now) {
  const turn = readTurn(dir, TURN);
  return Boolean(turn && turn.holder === holder && turn.expiresAt > now);
}

/**
 * Whether this branch is exactly what a merge would put on the base branch.
 * Returns a reason to stop, or null. CI evidence only counts for a head that
 * already contains the current base, on a turn nobody else can merge inside.
 */
export function landBlocker({ holdsTurn: holds, pr, localHead, branch, baseIsAncestor, base = 'main', merge = true }) {
  if (merge && !holds) return 'This worktree does not hold the ship turn. Run `ship-turn.mjs take`, merge the base branch again, then land.';
  if (!pr || pr.state !== 'open') return `PR is ${pr?.merged ? 'already merged' : pr?.state ?? 'missing'}; nothing to land.`;
  if (pr.draft) return 'PR is a draft; mark it ready first.';
  if (pr.base?.ref !== base) return `PR targets ${pr.base?.ref}, not ${base}.`;
  if (pr.head?.ref !== branch) return `PR head branch ${pr.head?.ref} is not this worktree's branch ${branch}.`;
  if (pr.head?.sha !== localHead) return `PR head ${pr.head?.sha} is not local HEAD ${localHead}; push before landing.`;
  if (merge && !baseIsAncestor) return `origin/${base} has commits this branch lacks. Merge it again (still holding the turn), push, and rerun land.`;
  return null;
}

/** The newest check run with the required name on a commit, or null. */
export function latestCheck(checkRuns, name) {
  const runs = (checkRuns ?? []).filter((run) => run.name === name);
  return runs.sort((a, b) => b.id - a.id)[0] ?? null;
}

/** 'passed' | 'failed' | 'waiting' for one poll of the exact-head check. */
export function ciState(check) {
  if (!check || check.status !== 'completed') return 'waiting';
  return check.conclusion === 'success' ? 'passed' : 'failed';
}

/** owner/name from a GitHub remote URL, or null. */
export function repoSlug(remoteUrl) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl ?? '');
  return match ? `${match[1]}/${match[2]}` : null;
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('GH_TOKEN is not set and `gh auth token` returned no token.');
  return result.stdout.trim();
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function land({ root, repo, dir, holder, branch, base, checkName, method, pr: prNumber, turnMinutes, ciMinutes, merge }) {
  const github = async (httpMethod, apiPath, body) => {
    const response = await fetch(`${API}/repos/${repo}/${apiPath}`, {
      method: httpMethod,
      headers: { Authorization: `token ${token()}`, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${httpMethod} ${apiPath} failed: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const containsBase = () => {
    git(root, ['fetch', '--quiet', 'origin', base]);
    try {
      git(root, ['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  };
  const give = () => release({ dir, holder, names: [TURN] });
  const check = async () => {
    const pr = await github('GET', `pulls/${prNumber}`);
    const blocker = landBlocker({
      merge, base, holdsTurn: holdsTurn(dir, holder, Date.now()), pr, branch,
      localHead: git(root, ['rev-parse', 'HEAD']), baseIsAncestor: containsBase(),
    });
    return { pr, blocker };
  };

  let { pr, blocker } = await check();
  if (blocker) {
    console.error(blocker);
    return NOT_LANDABLE;
  }
  const head = pr.head.sha;
  const deadline = Date.now() + ciMinutes * 60_000;
  let announced = '';
  for (;;) {
    renew({ dir, holder, branch, now: Date.now(), turnMinutes });
    const runs = await github('GET', `commits/${head}/check-runs?filter=latest&per_page=100`);
    const ci = latestCheck(runs.check_runs, checkName);
    const state = ciState(ci);
    if (state === 'passed') {
      console.log(`${checkName} passed for exact head ${head}: ${ci.details_url}`);
      break;
    }
    if (state === 'failed') {
      give();
      console.error(`${checkName} concluded ${ci.conclusion} for exact head ${head}: ${ci.details_url}\nShip turn released so the next branch can land. Fix the failure, then take the turn again.`);
      return 1;
    }
    const message = ci ? `${checkName} is ${ci.status} for exact head ${head}` : `${checkName} is not present yet for exact head ${head}`;
    if (message !== announced) {
      console.log(`${message}; waiting...`);
      announced = message;
    }
    if (Date.now() >= deadline) {
      give();
      console.error(`${checkName} did not finish within ${ciMinutes} min. The PR is open but not merged, and the ship turn is released.`);
      return 1;
    }
    await sleep(POLL_SECONDS * 1000);
  }

  if (!merge) {
    console.log(`PR #${prNumber} is green and left open, unmerged, as requested.`);
    return 0;
  }
  // The turn keeps other ship runs out; this catches a merge made by hand meanwhile.
  ({ pr, blocker } = await check());
  if (blocker) {
    console.error(blocker);
    return NOT_LANDABLE;
  }
  const merged = await github('PUT', `pulls/${prNumber}/merge`, { merge_method: method, sha: head });
  give();
  console.log(`Merged PR #${prNumber} to ${base} as ${merged.sha}. Ship turn released.`);
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const root = repoRoot();
  const config = loadConfig(root);
  const holder = root;
  const branch = currentBranch(root);
  // Its own directory, so a builder releasing its dev turns can never drop the ship turn.
  const dir = sharedDir(root, 'ship-turn');
  const turnMinutes = numberFlag(rest, '--minutes', config.merge.turnMinutes);
  const waitMinutes = numberFlag(rest, '--wait-minutes', config.merge.waitMinutes);
  const ciMinutes = numberFlag(rest, '--ci-minutes', config.ci.minutes);
  const pr = numberFlag(rest, '--pr', 0);
  const merge = !rest.includes('--no-merge');

  if (command === 'status') {
    const now = Date.now();
    const turn = readTurn(dir, TURN);
    console.log(turn && turn.expiresAt > now ? `Ship turn ${describe(turn, now)}` : 'The ship turn is free.');
    return;
  }
  if (command === 'release') {
    const released = release({ dir, holder, names: [TURN] });
    console.log(released.length > 0 ? 'Released the ship turn.' : 'This worktree did not hold the ship turn.');
    return;
  }
  if (command === 'renew') {
    const held = holdsTurn(dir, holder, Date.now());
    if (held) renew({ dir, holder, branch, now: Date.now(), turnMinutes });
    console.log(held ? `Renewed the ship turn for ${turnMinutes} min.` : 'This worktree does not hold the ship turn.');
    return;
  }
  if (command === 'take') {
    await takeOrWait({ dir, names: [TURN], holder, branch, turnMinutes, waitMinutes, label: 'the ship turn' });
    console.log(`Holding the ship turn (${turnMinutes} min; land renews it). Merge origin/${config.baseBranch} now. Give it back with: ship-turn.mjs release`);
    return;
  }
  if (command === 'land') {
    if (!Number.isInteger(pr) || pr <= 0) {
      console.error('land needs --pr <number>.');
      process.exit(2);
    }
    const repo = process.env.FACTORY_GITHUB_REPO || repoSlug(git(root, ['remote', 'get-url', 'origin']));
    if (!repo) throw new Error('origin is not a GitHub remote; set FACTORY_GITHUB_REPO=owner/name.');
    process.exit(await land({
      root, repo, dir, holder, branch, base: config.baseBranch, checkName: config.ci.check,
      method: config.merge.method, pr, turnMinutes, ciMinutes, merge,
    }));
  }
  console.error('usage: ship-turn.mjs take [--wait-minutes N] | renew | land --pr <number> [--no-merge] [--ci-minutes N] | release | status');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
