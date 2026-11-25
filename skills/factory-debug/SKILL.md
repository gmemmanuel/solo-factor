---
name: factory-debug
description: Root-cause a bug before anything is planned or patched. Use when handed a bug report, when a plan's diagnosis has competing theories, or when a failure's cause is not yet proven, and the project's FACTORY.md does not name a debugging skill of its own.
---

# Diagnose a bug

Read the project's `FACTORY.md` first. If its "Stage skills" table names a
different skill for diagnosis, use that one. Otherwise this is the method.

The output is a **root-caused diagnosis, not a patch.** The fix goes through
the pipeline like any other change. A small, well-understood fix may take
the small-bug fast path, but it still starts from a proven cause.

## 1. Intake

- Resolve who and what first. For a report from a real user, find the
  account and look at the real state before forming any theory. Inspection
  of real users' data is read-only.
- Pull the facts out of the report: dates and times, the exact words on
  screen, identifiers, device and platform.
- Search `LEARNINGS.md` and past plans for the same class of failure.

## 2. Diagnose

1. **Reproduce the exact failing sequence**, or replay it from real state,
   before proposing anything.
2. **Find the first broken layer:** the interface, stored state, the logic
   or orchestration between them, a fallback or retry path, an outside
   provider, or the data itself. The fix targets that layer, not the place
   the symptom showed.
3. **Read the actual artifact of the failure** (the log line, the trace, the
   stored row) and compare it with the contract that should have held.
4. **Name the class, not just the instance.** What other inputs, users or
   states hit the same defect?

Two checks are the cheapest way to kill a wrong theory. Skipping them is
what produces plans that die in review:

5. **Read the tests for any contract you are about to blame.** Tests show
   the shape a contract already accepts, so they disprove "the system cannot
   express this" faster than reading the implementation can confirm it.
6. **Check whether earlier work already owns this**, by subsystem, not by
   ticket number: `git log origin/<base> --grep="<subsystem term>" -i --oneline`.

Record the base-branch commit the diagnosis was taken against.

## 3. What you hand over

A written diagnosis: the symptom, the steps to reproduce, the first broken
layer, the root cause with evidence (`file:line`, log or trace identifiers,
stored rows), the class of failure, and a proposed direction for the fix. It
becomes the TLDR and the critical decisions of the ticket's plan. The report
opens with what a user experienced, in plain words.

## Rules

- No workarounds, no removing a recent feature, no patching the symptom.
- If the only fix you can see is hardcoding the reported case or matching
  human language with a regex, the contract is missing or wrong. Write up
  the class and the missing contract instead.
- If you cannot prove the cause, say exactly what you tried, what the
  evidence shows, and what is missing. Do not guess and fix.
- "I lack access" is a claim to verify. Try the read path before reporting
  it as a blocker.
