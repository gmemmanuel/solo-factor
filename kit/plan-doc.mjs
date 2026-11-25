#!/usr/bin/env node
// The one way a pipeline stage finds its branch's plan. Stages branch on the
// exit code and never guess:
//
//   0  prints the plan's path
//   3  prints `SMALL_BUG: <KEY>` per ticket: a small bug's ticket is its plan
//   1  anything else, with the reason. A missing plan is never small-bug evidence.
//
//   node scripts/factory/plan-doc.mjs             resolve this branch's plan
//   node scripts/factory/plan-doc.mjs --plan-dir  print where plans live
//
// A plan is `<KEY> - short title.md` in the plans directory, or any plan there
// carrying the standalone line  Branch: `<exact branch>`  (for work without a
// ticket). Small-bug status is read from the factory's own record of the
// ticket, then from the tracker's label. If neither can be read, the status is
// unverified, which is exit 1, not exit 3.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { keyRegex, loadConfig, mainCheckout, plansDir, repoRoot } from './config.mjs';
import { issueLabels, resolveKey } from './linear.mjs';

export function planFiles(dir) {
  try {
    return readdirSync(dir).filter((file) => file.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/** Plans named for a ticket key: `KEY - title.md`. */
export function plansForKey(dir, key) {
  const prefix = `${key.toUpperCase()} - `;
  return planFiles(dir).filter((file) => file.toUpperCase().startsWith(prefix)).map((file) => path.join(dir, file));
}

/** Plans that declare this exact branch on a standalone `Branch:` line. */
export function plansForBranch(dir, branch) {
  const marker = `Branch: \`${branch}\``;
  return planFiles(dir)
    .map((file) => path.join(dir, file))
    .filter((file) => readFileSync(file, 'utf8').split(/\r?\n/).some((line) => line.trim() === marker));
}

/**
 * What the evidence says about a branch. Pure: `smallBug(key)` answers
 * 'yes' | 'no' | 'unknown'.
 */
export async function resolve({ dir, branch, keyPattern, commitSubjects = [], smallBug }) {
  const fail = (message) => ({ code: 1, lines: [], error: message });
  if (!existsSync(dir)) return fail(`Plan directory not found: ${dir}. Create it, or fix plansDir in factory.config.json.`);
  const byBranch = plansForBranch(dir, branch);
  if (byBranch.length > 1) return fail(`Several plans declare branch '${branch}':\n  ${byBranch.join('\n  ')}`);

  const keyMatch = keyPattern.exec(branch);
  if (keyMatch) {
    const key = keyMatch[1].toUpperCase();
    const byKey = [...new Set([...plansForKey(dir, key), ...byBranch])];
    if (byKey.length === 1) return { code: 0, lines: [byKey[0]] };
    if (byKey.length > 1) return fail(`Several plans found for ${key}:\n  ${byKey.join('\n  ')}`);
    const status = await smallBug(key);
    if (status === 'yes') return { code: 3, lines: [`SMALL_BUG: ${key}`] };
    return fail(
      `No plan found for ${key}. Expected: ${path.join(dir, `${key} - *.md`)}\n`
      + (status === 'unknown'
        ? `Could not read whether ${key} is a small bug, so that is unverified, not absent. Fix access and rerun before concluding anything.`
        : `${key} is not a small bug, so the fast path does not apply.`),
    );
  }

  if (byBranch.length === 1) return { code: 0, lines: [byBranch[0]] };

  // Disjoint small bugs may share a branch with no key in its name. Commit
  // subjects only nominate candidates; each must still be verified.
  const global = new RegExp(keyPattern.source, 'gi');
  const keys = [...new Set(commitSubjects.flatMap((subject) => [...subject.matchAll(global)].map((match) => match[1].toUpperCase())))].sort();
  if (keys.length > 0) {
    if (commitSubjects.some((subject) => !keyPattern.test(subject))) return fail('This branch has commits without ticket keys; cannot account for all of its work.');
    for (const key of keys) {
      if (plansForKey(dir, key).length > 0) return fail(`${key} has a plan; it belongs on its own full-pipeline branch.`);
      const status = await smallBug(key);
      if (status !== 'yes') return fail(status === 'unknown' ? `Could not read whether ${key} is a small bug; unverified, not absent.` : `${key} is not a small bug; the batch fast path does not apply.`);
    }
    return { code: 3, lines: keys.map((key) => `SMALL_BUG: ${key}`) };
  }
  return fail(
    `No plan is linked to branch '${branch}'.\n`
    + `For planned work, add this exact line to its plan: Branch: \`${branch}\`\n`
    + 'A missing ticket key or plan is not small-bug evidence.',
  );
}

function bbBin() {
  const local = path.join(os.homedir(), '.bb', 'bin', 'bb');
  return process.env.BB_BIN || (existsSync(local) ? local : 'bb');
}

/** The bb project whose source is this repository's main checkout, or ''. */
export function bbProject(root, config) {
  if (process.env.FACTORY_BB_PROJECT || config.bb.project) return process.env.FACTORY_BB_PROJECT || config.bb.project;
  if (process.env.BB_PROJECT_ID) return process.env.BB_PROJECT_ID;
  const listed = spawnSync(bbBin(), ['project', 'list', '--json'], { encoding: 'utf8' });
  if (listed.status !== 0) return '';
  try {
    const checkout = mainCheckout(root);
    return JSON.parse(listed.stdout).find((project) => JSON.stringify(project).includes(`"${checkout}"`))?.id ?? '';
  } catch {
    return '';
  }
}

/** The factory's tickets for this project, or null when bb cannot be asked. */
export function factoryItems(root, config) {
  const project = bbProject(root, config);
  const args = ['factory', 'status', '--json', ...(project ? ['--project', project] : [])];
  const result = spawnSync(bbBin(), args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout).items ?? null;
  } catch {
    return null;
  }
}

/** 'yes' | 'no' | 'unknown', from the factory's record and then the tracker's label. */
export async function smallBugStatus(key, { root, config }) {
  let known = false;
  const items = factoryItems(root, config);
  if (items) {
    const live = items.filter((item) => !['cancelled', 'archived'].includes(item.status));
    if (live.some((item) => item.key.toUpperCase() === key && item.pipeline === 'small-bug')) return 'yes';
    if (live.some((item) => (item.riders ?? []).some((rider) => rider.key.toUpperCase() === key))) return 'yes';
    if (live.some((item) => item.key.toUpperCase() === key)) return 'no';
    known = config.tracker.kind !== 'linear';
  }
  if (config.tracker.kind === 'linear') {
    try {
      const labels = await issueLabels(key, { key: resolveKey(config) });
      return labels.includes(config.tracker.labels.smallBug) ? 'yes' : 'no';
    } catch {
      return 'unknown';
    }
  }
  return known ? 'no' : 'unknown';
}

async function main() {
  const mode = process.argv[2] ?? 'resolve';
  const root = repoRoot();
  const config = loadConfig(root);
  const dir = plansDir(root, config);
  if (mode === '--plan-dir') {
    console.log(dir);
    return 0;
  }
  if (mode !== 'resolve') {
    console.error('usage: plan-doc.mjs [--plan-dir]');
    return 2;
  }
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const branch = git(['branch', '--show-current']);
  let commitSubjects = [];
  try {
    commitSubjects = git(['log', '--no-merges', '--format=%s', `origin/${config.baseBranch}..HEAD`]).split('\n').filter(Boolean);
  } catch {
    // No base branch to compare with: no batch evidence.
  }
  const result = await resolve({ dir, branch, keyPattern: keyRegex(config), commitSubjects, smallBug: (key) => smallBugStatus(key, { root, config }) });
  for (const line of result.lines) console.log(line);
  if (result.error) console.error(`ERROR: ${result.error}`);
  return result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
