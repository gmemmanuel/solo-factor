#!/usr/bin/env node
// Every plan declares the files it will touch, in a `## Surfaces` section.
//
// Without a declaration, the only way to learn a plan's surface is to pattern
// match the whole document, which cannot tell "will edit" from "cited as
// evidence" and so both over- and under-reports. The scheduler reads this
// section to decide which tickets can be built side by side; a missing or
// mistyped surface sends two branches into the same files.
//
//   node scripts/factory/plan-surfaces.mjs <plan.md> [more.md ...]
//   node scripts/factory/plan-surfaces.mjs --branch      this branch's plan
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { repoRoot } from './config.mjs';

// A repo-relative path with a file extension. The lookbehind keeps
// `tools/x/docs/Y.md` from also matching as `docs/Y.md`.
const PATH_RE = /(?<![A-Za-z0-9_.\/\[\]@-])(?:[A-Za-z0-9_.\[\]@-]+\/)*[A-Za-z0-9_.\[\]@-]+\.[A-Za-z0-9]{1,8}\b/g;

function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s*${heading}\\s*$`, 'i').test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** The files a plan says it will create, modify or delete; null when it has no Surfaces section. */
export function surfacesOf(body, root) {
  const text = section(body, 'Surfaces');
  if (text === null) return null;
  const found = new Set();
  for (const line of text.split('\n')) {
    // Only list items declare a surface; the section's own guidance prose does not.
    if (!/^\s*[-*]\s/.test(line)) continue;
    for (const match of line.match(PATH_RE) ?? []) {
      // A slash-free match is only a surface when that root file exists or is
      // marked new: prose such as "Decision log.md" would otherwise count.
      if (match.includes('/') || /\(new\)/i.test(line) || (root && existsSync(path.join(root, match)))) found.add(match);
    }
  }
  return [...found].sort();
}

/** The implementer tier (1 to 3) a plan declares, or null. An unfilled template line (`Tier 1 | Tier 2 | …`) declares nothing. */
export function tierOf(body) {
  const match = /^\*\*Implementer tier:\*\*\s*\[?\s*Tier\s*([123])\b(?!\s*\|)/im.exec(body);
  return match ? Number(match[1]) : null;
}

/** 'ui' | 'fullstack' | null, from the plan's Builder line. */
export function builderOf(body) {
  const match = /^\*\*Builder:\*\*\s*\[?\s*(UI|Full-stack)\b(?!\s*\|)/im.exec(body);
  return match ? (match[1].toLowerCase() === 'ui' ? 'ui' : 'fullstack') : null;
}

/** Whether an independent plan review has been recorded in the plan. */
export function planReviewed(body) {
  return /^## Plan review\b/m.test(body);
}

export function checkPlan(file, root) {
  if (!existsSync(file)) return { ok: false, message: `${file}: file not found` };
  const name = path.basename(file);
  const declared = surfacesOf(readFileSync(file, 'utf8'), root);
  if (declared === null) return { ok: false, message: `${name}: no "## Surfaces" section. List every file this plan will create, modify or delete, one per line.` };
  if (declared.length === 0) return { ok: false, message: `${name}: "## Surfaces" declares no repo-relative file paths.` };
  // A new file may introduce one directory. Deeper missing paths are far more likely to be typos.
  const suspect = declared.filter((file_) => {
    if (existsSync(path.join(root, file_))) return false;
    const parent = path.dirname(file_);
    return !existsSync(path.join(root, parent)) && !existsSync(path.join(root, path.dirname(parent)));
  });
  if (suspect.length > 0) return { ok: false, message: `${name}: declared path(s) whose directory does not exist; check for typos: ${suspect.join(', ')}` };
  return { ok: true, message: `${name} declares ${declared.length} file(s).`, declared };
}

function main() {
  const args = process.argv.slice(2);
  const root = repoRoot();
  let targets = args.filter((arg) => !arg.startsWith('--'));
  if (args.includes('--branch')) {
    const resolved = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-doc.mjs')], { encoding: 'utf8', cwd: root });
    // Exit 3 is a small bug: its ticket is its plan, so there is nothing to check.
    if (resolved.status === 3) targets = [];
    else if (resolved.status !== 0) {
      process.stderr.write(resolved.stderr);
      process.exit(1);
    } else targets = [resolved.stdout.trim()];
  }
  if (targets.length === 0) {
    console.log('plan-surfaces: nothing to check.');
    return;
  }
  const results = targets.map((target) => checkPlan(target, root));
  for (const result of results) (result.ok ? console.log : console.error)(`plan-surfaces: ${result.message}`);
  if (results.some((result) => !result.ok)) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
