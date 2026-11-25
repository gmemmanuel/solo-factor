# [Ticket title] - [KEY]

Branch: `[exact branch name]`

Base: `[base-branch commit the diagnosis or design was taken against]`

**Overall progress:** `0%`

## TLDR

What we are building or fixing, and why, in a few lines. For a bug: the single
root cause with `file:line`, the first broken layer, and the class of failure.

## Product explanation

**Today:** [what a user experiences now; name a real user or case if known]
**After:** [what they will experience once this ships]
**Why it is worth building:** [the evidence, who it affects, the recorded decisions it follows, or "none apply"]

## Critical decisions

- Decision 1: [choice] - [reason, with `file:line` where it rests on existing code]

## Product surface

[Only when the user will see something new. Affected screens and the user's
job on each; every new user-facing word; the mockup's path and who approved
it, when. Otherwise: `n/a`.]

## Surfaces

Every file this plan creates, modifies or deletes. Repo-relative, one per line.

- `path/to/file.ts`
- `path/to/new-file.ts` (new)

## Implementation contract

**Implementer tier:** [Tier 1 | Tier 2 | Tier 3] - [Tier 1: the contract has no unfilled cells. Tier 2 or 3: the cells you could not fill, and why]
**Builder:** [UI | Full-stack] - [why]

### Identifiers

| Name | Kind | Location |
|---|---|---|
| `[exact_name]` | [field / type / function / column / enum value / config key / test file] | `[path]` |

### Shapes

```
// [path:line] - current
// [path:line] - after
```

### Behaviour tables

[Input x current state -> outcome, every cell filled. `n/a` if unconditional.]

### Touch list

| File | Change |
|---|---|
| `[path]` | [what changes] |
| `[path]` | **unchanged** - [why a reader would expect otherwise, and the search that proves it] |

### Callers and entrances

| Function | Caller or entrance (`file:line`) | What happens on this path after the change |
|---|---|---|

### Prompt changes

[For any prompt an AI model reads: the exact current lines with `file:line`,
the exact replacement, and every worked example that becomes wrong. `n/a` if none.]

### Test inventory

| Test file | What it asserts |
|---|---|

## Tasks

Status: 🟥 to do, 🟨 in progress, 🟩 done.

- [ ] 🟥 **Step 1: [name]**
  - [ ] 🟥 [subtask]
- [ ] 🟥 **Step 2: [name]**

## Verification (agent-run)

- **Deterministic checks:** [exact commands]
- **Live or end-to-end check the builder runs:** [command, fixture or test account, expected result; or why none is needed]
- **Designed variations:** [the exact reproduction plus 2 or 3 inputs that exercise the same class differently]
- **What the reviewer needs for an independent pass:** [fixtures, accounts, scripts]
- **What the founder tries, if a screen changes:** [the short check; never the proof]

## Follow-ups and out of scope

[Real things found and deliberately not fixed, each with one line on why.]

## Builder plan amendments

[The builder records here every cell it corrected or filled: the cell, the evidence, the change, the attempt number.]

<!-- Reviews are appended below this line and never deleted. -->
