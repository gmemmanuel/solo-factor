// The project's machine-readable profile: `factory.config.json` in the
// repository root. FACTORY.md says the same things for agents to read; this
// file says them for the scripts, so a rule a script enforces has one value.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_FILE = 'factory.config.json';

export const DEFAULTS = {
  baseBranch: 'main',
  // Repo-relative, absolute, or ~-prefixed (plans may live in another repository).
  plansDir: 'docs/plans',
  // What a ticket key looks like in branch names, plan names and commit subjects.
  keyPattern: '[A-Za-z][A-Za-z0-9]*-[0-9]+',
  ci: { check: 'ci', minutes: 60 },
  merge: { method: 'squash', turnMinutes: 30, waitMinutes: 240 },
  tracker: {
    kind: 'none', // 'linear' | 'none'
    url: '', // link template with {key}
    team: '', // Linear team key, such as APP
    openStates: [], // Linear state names the schedule covers; empty means every started or unstarted state
    labels: { smallBug: 'Small bug', planWritten: 'Plan written', planReviewed: 'Plan reviewed', later: 'Later' },
  },
  lanes: { max: 4 },
  // Things only one branch may use at a time, by name: a dev deploy slot, a device, a staging database.
  turns: { minutes: 45, waitMinutes: 90 },
  // Path fragments too widely shared to mean two tickets collide (lockfiles, generated files).
  sequence: { ignore: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'LEARNINGS.md'] },
  bb: { project: '' },
};

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** The checkout this command runs in (a worktree counts as its own root). */
export function repoRoot(start = process.cwd()) {
  try {
    return git(start, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`${start} is not inside a git repository.`);
  }
}

/** The main checkout that every worktree shares: where bb knows the project. */
export function mainCheckout(root) {
  try {
    return path.dirname(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch {
    return root;
  }
}

function merge(base, extra) {
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = base && typeof base[key] === 'object' && !Array.isArray(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

export function loadConfig(root = repoRoot()) {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return structuredClone(DEFAULTS);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${error.message}`);
  }
  return merge(structuredClone(DEFAULTS), parsed);
}

export function plansDir(root, config) {
  const dir = config.plansDir.startsWith('~') ? path.join(os.homedir(), config.plansDir.slice(1)) : config.plansDir;
  return path.isAbsolute(dir) ? dir : path.join(root, dir);
}

export function keyRegex(config, flags = 'i') {
  return new RegExp(`(?<![A-Za-z0-9])(${config.keyPattern})(?![0-9])`, flags);
}

/** A stable per-repository directory outside every worktree, for state all of them share. */
export function sharedDir(root, name, env = process.env) {
  if (env.FACTORY_STATE_DIR) return path.join(env.FACTORY_STATE_DIR, name);
  const slug = mainCheckout(root).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-80);
  return path.join(os.homedir(), '.local', 'share', 'factory', slug, name);
}
