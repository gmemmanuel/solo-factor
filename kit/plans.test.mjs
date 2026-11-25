import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { keyRegex, DEFAULTS } from './config.mjs';
import { resolve } from './plan-doc.mjs';
import { builderOf, checkPlan, planReviewed, surfacesOf, tierOf } from './plan-surfaces.mjs';
import { evaluate, parseReceipts } from './review-receipt.mjs';

function fixture(files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'factory-plans-'));
  const dir = path.join(root, 'docs', 'plans');
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'cart.ts'), '');
  writeFileSync(path.join(root, 'README.md'), '');
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
}
const keyPattern = keyRegex(DEFAULTS);
const never = async () => 'no';

test('a branch with a ticket key resolves to that ticket\'s plan', async () => {
  const { dir, done } = fixture({ 'APP-12 - Coupons.md': '# x', 'APP-120 - Other.md': '# y' });
  try {
    const result = await resolve({ dir, branch: 'sam/app-12-coupons', keyPattern, smallBug: never });
    assert.equal(result.code, 0);
    assert.equal(path.basename(result.lines[0]), 'APP-12 - Coupons.md');
  } finally { done(); }
});

test('a branch without a key resolves through the plan\'s exact Branch line', async () => {
  const { dir, done } = fixture({ 'Tidy the cart.md': 'Title\n\nBranch: `tidy-cart`\n', 'Other.md': 'Branch: `tidy-cart-2`\n' });
  try {
    const result = await resolve({ dir, branch: 'tidy-cart', keyPattern, smallBug: never });
    assert.equal(path.basename(result.lines[0]), 'Tidy the cart.md');
  } finally { done(); }
});

test('no plan plus a verified small bug is exit 3; no plan alone is never small-bug evidence', async () => {
  const { dir, done } = fixture();
  try {
    assert.deepEqual(await resolve({ dir, branch: 'app-7-typo', keyPattern, smallBug: async () => 'yes' }), { code: 3, lines: ['SMALL_BUG: APP-7'] });
    const notSmall = await resolve({ dir, branch: 'app-7-typo', keyPattern, smallBug: never });
    assert.equal(notSmall.code, 1);
    assert.match(notSmall.error, /not a small bug/);
    const unknown = await resolve({ dir, branch: 'app-7-typo', keyPattern, smallBug: async () => 'unknown' });
    assert.equal(unknown.code, 1);
    assert.match(unknown.error, /unverified, not absent/);
    assert.match((await resolve({ dir, branch: 'spike', keyPattern, smallBug: async () => 'yes' })).error, /not small-bug evidence/);
  } finally { done(); }
});

test('a keyless branch of small bugs resolves only when every commit names a verified small bug', async () => {
  const { dir, done } = fixture({ 'APP-9 - Planned.md': '# x' });
  try {
    const yes = async () => 'yes';
    assert.deepEqual((await resolve({ dir, branch: 'fixes', keyPattern, commitSubjects: ['APP-3 fix typo', 'Fix padding (APP-4)'], smallBug: yes })).lines, ['SMALL_BUG: APP-3', 'SMALL_BUG: APP-4']);
    assert.match((await resolve({ dir, branch: 'fixes', keyPattern, commitSubjects: ['APP-3 fix typo', 'tidy'], smallBug: yes })).error, /commits without ticket keys/);
    assert.match((await resolve({ dir, branch: 'fixes', keyPattern, commitSubjects: ['APP-9 thing'], smallBug: yes })).error, /has a plan/);
    assert.match((await resolve({ dir, branch: 'fixes', keyPattern, commitSubjects: ['APP-3 x'], smallBug: async (key) => (key === 'APP-3' ? 'no' : 'yes') })).error, /not a small bug/);
  } finally { done(); }
});

test('two plans for one ticket or one branch is an error, not a guess', async () => {
  const { dir, done } = fixture({ 'APP-1 - A.md': '', 'APP-1 - B.md': '' });
  try {
    assert.match((await resolve({ dir, branch: 'app-1', keyPattern, smallBug: never })).error, /Several plans/);
  } finally { done(); }
});

const PLAN = `# Coupons - APP-12

## Surfaces

Every file this plan creates, modifies or deletes. See docs/guide.md for how.

- \`src/cart.ts\`
- \`src/coupons/apply.ts\` (new)
- \`README.md\`

## Implementation contract

**Implementer tier:** Tier 2 - one bounded ambiguity
**Builder:** Full-stack - backend logic
`;

test('surfaces are the listed files only, and the tier and builder are read from their lines', () => {
  const { root, done } = fixture();
  try {
    assert.deepEqual(surfacesOf(PLAN, root), ['README.md', 'src/cart.ts', 'src/coupons/apply.ts']);
    assert.equal(surfacesOf('# no section', root), null);
    assert.equal(tierOf(PLAN), 2);
    assert.equal(builderOf(PLAN), 'fullstack');
    assert.equal(builderOf('**Builder:** UI - screens'), 'ui');
    assert.equal(tierOf('**Implementer tier:** [Tier 1 | Tier 2 | Tier 3] - template'), null);
    assert.equal(planReviewed(PLAN), false);
    assert.equal(planReviewed(`${PLAN}\n## Plan review - 2026-01-01 - reviewer\n`), true);
  } finally { done(); }
});

test('a plan with no Surfaces section, an empty one, or a path in a directory that does not exist is refused', () => {
  const { root, dir, done } = fixture({ 'ok.md': PLAN, 'none.md': '# x', 'empty.md': '## Surfaces\n\nnothing yet\n', 'typo.md': '## Surfaces\n- `scr/deep/nested/cart.ts`\n' });
  try {
    assert.equal(checkPlan(path.join(dir, 'ok.md'), root).ok, true);
    assert.match(checkPlan(path.join(dir, 'none.md'), root).message, /no "## Surfaces" section/);
    assert.match(checkPlan(path.join(dir, 'empty.md'), root).message, /declares no repo-relative/);
    assert.match(checkPlan(path.join(dir, 'typo.md'), root).message, /check for typos/);
  } finally { done(); }
});

const HEAD = 'a'.repeat(40);
const LATER = 'b'.repeat(40);
const receipt = (fields) => `<!-- factory-review:v1 ${JSON.stringify({ agent: 'reviewer', recorded_at: '2026-01-31T12:00:00Z', ...fields })} -->`;
const review = (disposition, head = HEAD) => `## Code review - 2026-01-31 - reviewer

Reviewed head: \`${head}\`
Disposition: \`${disposition}\`

### Verification
ran
### Issues found and fixed
None
### Needs a decision
None

${receipt({ stage: 'code_review', head, disposition })}
`;
const closeout = (head = LATER, reviewed = HEAD) => `## Ship closeout - 2026-02-01

### Changes since review
Merged main.
### Verification
ran

${receipt({ stage: 'closeout', head, disposition: 'closed', code_review_head: reviewed })}
`;
const repo = { commitExists: () => true, isAncestor: (older, newer) => older === HEAD && newer === LATER };

test('a complete review at the exact head records and ships', () => {
  assert.match(evaluate({ content: review('complete'), mode: 'record', head: HEAD, ...repo }), /valid/);
  assert.match(evaluate({ content: review('complete'), mode: 'ship', head: HEAD, ...repo }), /ready to ship/);
});

test('a review of another head cannot be recorded, and a blocked review never ships', () => {
  assert.throws(() => evaluate({ content: review('complete'), mode: 'record', head: LATER, ...repo }), /does not match expected HEAD/);
  assert.throws(() => evaluate({ content: review('blocked'), mode: 'ship', head: HEAD, ...repo }), /blocked/);
});

test('a head that moved after review ships only with a closeout at the new head linked to that review', () => {
  assert.throws(() => evaluate({ content: review('complete'), mode: 'ship', head: LATER, ...repo }), /HEAD moved since the review/);
  assert.match(evaluate({ content: review('complete') + closeout(), mode: 'ship', head: LATER, ...repo }), /ready to ship/);
  assert.throws(() => evaluate({ content: review('complete') + closeout(LATER, 'c'.repeat(40)), mode: 'ship', head: LATER, ...repo }), /references code-review head/);
  assert.throws(() => evaluate({ content: review('complete') + closeout(HEAD), mode: 'ship', head: LATER, ...repo }), /does not match expected HEAD/);
});

test('commits that touch only plan documents do not count as a change since review', () => {
  const planCommits = { ...repo, planOnly: (older, newer) => older === HEAD && newer === LATER };
  assert.match(evaluate({ content: review('complete'), mode: 'ship', head: LATER, ...planCommits }), /ready to ship/);
  // A closeout recorded at one head still covers a later head that only added it to the plan.
  const THIRD = 'e'.repeat(40);
  const chain = { commitExists: () => true, isAncestor: () => true, planOnly: (older, newer) => older === LATER && newer === THIRD };
  assert.match(evaluate({ content: review('complete') + closeout(), mode: 'ship', head: THIRD, ...chain }), /ready to ship/);
  assert.throws(() => evaluate({ content: review('complete'), mode: 'ship', head: THIRD, ...chain }), /HEAD moved since the review/);
});

test('a returned decision needs a closeout even at the same head, and unrelated history is refused', () => {
  assert.throws(() => evaluate({ content: review('decision_required'), mode: 'ship', head: HEAD, ...repo }), /returned a decision/);
  assert.match(evaluate({ content: review('decision_required') + closeout(HEAD), mode: 'ship', head: HEAD, ...repo }), /ready to ship/);
  assert.throws(() => evaluate({ content: review('complete'), mode: 'ship', head: 'd'.repeat(40), ...repo }), /not an ancestor/);
});

test('a receipt must sit under a complete review section that names the same head and disposition', () => {
  assert.throws(() => evaluate({ content: receipt({ stage: 'code_review', head: HEAD, disposition: 'complete' }), mode: 'record', head: HEAD, ...repo }), /must follow a "## Code review" section/);
  assert.throws(() => evaluate({ content: review('complete').replace('### Verification\nran\n', ''), mode: 'record', head: HEAD, ...repo }), /Missing review section/);
  assert.throws(() => evaluate({ content: review('complete').replace('Disposition: `complete`', 'Disposition: `blocked`'), mode: 'record', head: HEAD, ...repo }), /disposition does not match/);
});

test('a receipt inside a code fence is an example, and a malformed one is an error', () => {
  assert.throws(() => parseReceipts(`\`\`\`\n${receipt({ stage: 'code_review', head: HEAD, disposition: 'complete' })}\n\`\`\``), /No factory-review:v1 receipt/);
  assert.throws(() => parseReceipts('<!-- factory-review:v1 {oops} -->'), /Malformed/);
  assert.throws(() => parseReceipts(receipt({ stage: 'code_review', head: 'abc', disposition: 'complete' })), /full lowercase commit SHA/);
});
