#!/usr/bin/env node
// Review completion is an artifact, not a chat verdict. A code review ends by
// appending one machine-readable line to the plan (or, for a small bug, to its
// ticket), bound to the exact commit it reviewed:
//
//   <!-- factory-review:v1 {"stage":"code_review","head":"<40-char sha>","disposition":"complete","agent":"…","recorded_at":"2026-01-31T12:00:00Z"} -->
//
// The ship stage refuses to open a pull request unless this script accepts
// that line for the commit it is about to ship. Nobody reconstructs a missing
// review from memory.
//
//   node scripts/factory/review-receipt.mjs --plan <path> --mode record --head <sha>
//   node scripts/factory/review-receipt.mjs --plan <path> --mode closeout --head <sha>
//   node scripts/factory/review-receipt.mjs --plan <path> --mode ship --head <sha>
//   …or --ticket <KEY> instead of --plan, for a small bug reviewed on request.
//
// record    the reviewer's check: the latest code_review receipt is well formed,
//           sits under a complete review section, and names exactly --head.
// ship      passes when a `complete` code review names exactly --head, or when a
//           `closeout` receipt at --head links a reviewed ancestor (the builder's
//           audit of what changed after review: a base-branch merge, conflict
//           fixes, the answer to a returned decision). A `blocked` review never ships.
//           Commits that touch only plan documents are not a change: recording
//           the review in a plan kept in the repository does not invalidate it.
// closeout  the shipper's check after writing that closeout receipt.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, plansDir, repoRoot } from './config.mjs';
import { issueComments, resolveKey } from './linear.mjs';

export const RECEIPT_TAG = 'factory-review:v1';
const MODES = new Set(['record', 'closeout', 'ship']);
const CODE_DISPOSITIONS = new Set(['complete', 'decision_required', 'blocked']);
const SHA = /^[0-9a-f]{40}$/;
export const REQUIRED_CODE_SECTIONS = ['### Verification', '### Issues found and fixed', '### Needs a decision'];
export const REQUIRED_CLOSEOUT_SECTIONS = ['### Changes since review', '### Verification'];

function fail(message) {
  throw new Error(message);
}

function validateCommon(receipt) {
  if (receipt.stage !== 'code_review' && receipt.stage !== 'closeout') fail(`Unknown review stage: ${String(receipt.stage)}`);
  if (!SHA.test(receipt.head ?? '')) fail(`${receipt.stage} receipt head must be a full lowercase commit SHA`);
  if (typeof receipt.agent !== 'string' || receipt.agent.trim() === '' || receipt.agent.length > 160 || receipt.agent.includes('--')) {
    fail(`${receipt.stage} receipt agent must be non-empty, at most 160 characters, and contain no --`);
  }
  if (typeof receipt.recorded_at !== 'string' || !receipt.recorded_at.endsWith('Z') || !Number.isFinite(Date.parse(receipt.recorded_at))) {
    fail(`${receipt.stage} receipt recorded_at must be a valid UTC timestamp`);
  }
  if (receipt.stage === 'code_review') {
    if (!CODE_DISPOSITIONS.has(receipt.disposition)) fail(`Unknown code_review disposition: ${String(receipt.disposition)}`);
    return;
  }
  if (receipt.disposition !== 'closed') fail(`Unknown closeout disposition: ${String(receipt.disposition)}`);
  if (!SHA.test(receipt.code_review_head ?? '')) fail('closeout receipt code_review_head must be a full lowercase commit SHA');
}

/** Every receipt in a document, in order. Lines inside code fences are examples and do not count. */
export function parseReceipts(content) {
  const receipts = [];
  let inFence = false;
  for (const matchLine of content.matchAll(/^.*$/gm)) {
    const line = matchLine[0].replace(/\r$/, '');
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.startsWith(`<!-- ${RECEIPT_TAG}`)) continue;
    const match = line.match(new RegExp(`^<!-- ${RECEIPT_TAG} (\\{.*\\}) -->$`));
    let fields = null;
    try {
      fields = match ? JSON.parse(match[1]) : null;
    } catch {
      fields = null;
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) fail(`Malformed ${RECEIPT_TAG} receipt near byte ${matchLine.index}`);
    validateCommon(fields);
    receipts.push({ ...fields, offset: matchLine.index });
  }
  if (receipts.length === 0) fail(`No ${RECEIPT_TAG} receipt found in the review record`);
  return receipts;
}

function latest(receipts, stage) {
  const receipt = [...receipts].reverse().find((candidate) => candidate.stage === stage);
  if (!receipt) fail(`No ${stage} receipt found in the review record`);
  return receipt;
}

function sectionFor(content, receipt, heading, required) {
  const headings = [...content.slice(0, receipt.offset).matchAll(/^## .+$/gm)];
  const nearest = headings.at(-1);
  if (!nearest || !nearest[0].startsWith(heading)) fail(`${receipt.stage} receipt must follow a "${heading}" section`);
  const text = content.slice(nearest.index, receipt.offset);
  for (const name of required) if (!text.includes(name)) fail(`Missing review section: ${name}`);
  return text;
}

/**
 * Decide whether the record supports `mode` at `head`. `isAncestor(a, b)` and
 * `commitExists(sha)` come from git; they are parameters so the rules are
 * testable without a repository. Returns the message to print.
 */
export function evaluate({ content, mode, head, isAncestor, commitExists, planOnly = () => false }) {
  // Recording a review in a plan that lives in the repository is itself a
  // commit. Commits that touch nothing but plan documents change no code, so
  // a receipt for the commit before them still covers the commit after.
  const sameCode = (reviewed, current) => reviewed === current || (isAncestor(reviewed, current) && planOnly(reviewed, current));
  const receipts = parseReceipts(content);
  const code = latest(receipts, 'code_review');
  const section = sectionFor(content, code, '## Code review', REQUIRED_CODE_SECTIONS);
  if (!section.includes(`Reviewed head: \`${code.head}\``)) fail("The review section does not name the receipt's reviewed head");
  if (!section.includes(`Disposition: \`${code.disposition}\``)) fail("The review section's disposition does not match the receipt");
  if (!commitExists(code.head)) fail(`Code-review head ${code.head} is not a commit in this repository`);

  if (mode === 'record') {
    if (code.head !== head) fail(`Review receipt head ${code.head} does not match expected HEAD ${head}`);
    return `code_review receipt is valid for ${code.head} (${code.disposition})`;
  }
  if (code.disposition === 'blocked') fail('Code review is blocked; the reviewer must finish the missing review work. It cannot be shipped or closed out.');
  if (!commitExists(head)) fail(`Expected head ${head} is not a commit in this repository`);
  if (code.head !== head && !isAncestor(code.head, head)) {
    fail(`Code-review head ${code.head} is not an ancestor of ${head}; review evidence cannot be carried across unrelated or rewritten history`);
  }
  if (mode === 'ship' && code.disposition === 'complete' && sameCode(code.head, head)) {
    return `complete code_review receipt is ready to ship at ${head}`;
  }
  if (!receipts.some((candidate) => candidate.stage === 'closeout')) {
    fail(
      code.disposition === 'decision_required'
        ? 'The review returned a decision. Resolve it, then record a closeout section and receipt at the final head.'
        : `HEAD moved since the review (${code.head} -> ${head}). Audit that delta, rerun the affected checks, and record a closeout section and receipt at ${head}. A base-branch merge alone does not need another independent review.`,
    );
  }
  const closeout = latest(receipts, 'closeout');
  sectionFor(content, closeout, '## Ship closeout', REQUIRED_CLOSEOUT_SECTIONS);
  if (closeout.code_review_head !== code.head) fail(`Closeout references code-review head ${closeout.code_review_head}, but the latest code review is ${code.head}`);
  if (!sameCode(closeout.head, head)) fail(`Closeout receipt head ${closeout.head} does not match expected HEAD ${head}`);
  return mode === 'closeout' ? `closeout receipt is valid for ${closeout.head}` : `review receipts are ready to ship at ${closeout.head}`;
}

function parseArgs(argv) {
  const options = { plan: null, ticket: null, mode: null, head: null };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!(key in options)) fail(`Unknown option: ${argv[index]}`);
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail(`Missing value for ${argv[index]}`);
    options[key] = argv[index + 1];
  }
  if (Boolean(options.plan) === Boolean(options.ticket)) fail('Pass exactly one of --plan <path> or --ticket <KEY>');
  if (!MODES.has(options.mode)) fail(`--mode must be one of: ${[...MODES].join(', ')}`);
  if (!SHA.test(options.head ?? '')) fail('--head must be a full lowercase 40-character commit SHA');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  let content;
  if (options.ticket) {
    const config = loadConfig(root);
    if (config.tracker.kind !== 'linear') fail('--ticket needs tracker.kind "linear" in factory.config.json; otherwise record the review in a plan file.');
    // Oldest first, so "the latest receipt wins" matches a plan's ordering.
    content = (await issueComments(options.ticket, { key: resolveKey(config) })).join('\n\n');
  } else {
    const planPath = path.resolve(options.plan);
    if (!fs.existsSync(planPath)) fail(`Plan document not found: ${planPath}`);
    content = fs.readFileSync(planPath, 'utf8');
  }
  const run = (args) => {
    try {
      execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  console.log(evaluate({
    content, mode: options.mode, head: options.head,
    commitExists: (sha) => run(['cat-file', '-e', `${sha}^{commit}`]),
    isAncestor: (older, newer) => run(['merge-base', '--is-ancestor', older, newer]),
    planOnly: (older, newer) => {
      const dir = path.relative(root, plansDir(root, loadConfig(root)));
      if (dir.startsWith('..') || path.isAbsolute(dir)) return false; // Plans live outside this repository.
      try {
        const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', `${older}..${newer}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
        return changed.length > 0 && changed.every((file) => file.startsWith(`${dir}/`));
      } catch {
        return false;
      }
    },
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
