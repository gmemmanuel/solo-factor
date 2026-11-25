---
name: mobile-release
description: Release what is on the base branch to testers or users of a mobile app, choosing between an over-the-air update and a native store build and keeping the backend ahead of the client. Use when asked to deploy, promote, release, or send a build to testers.
---

# Mobile release

Ship the base branch to one environment as one coordinated backend-and-client
promotion. Merging reaches nobody; this does. Run it only on the founder's
request.

Fill in before first use:

- **Environments:** dev `<id>`, tester/preview `<id>`, production `<id>`.
  Which of them this skill may touch: `<e.g. preview only>`.
- **Backend deploy commands:** migrations `<command>`, server functions `<command>`.
- **Over-the-air update command:** `<e.g. eas update --channel preview --message "…">`
- **Native build and submit commands:** `<e.g. eas build …>`, `<eas submit …>`
- **How a release is confirmed live:** `<command or check>`

## Choose the delivery mode

Lead with a recommendation when the request does not say.

1. **Native code or app configuration changed: store build.** That includes
   the app config, config plugins, permissions, the `ios/` or `android/`
   folders, an SDK upgrade, or a dependency with native code. An
   over-the-air update cannot carry any of these, and one sent to a binary
   it does not match can crash it. Bump the version the project's runtime
   policy keys on, so old binaries never receive the new bundle.
2. **A first-launch screen changed: store build.** Onboarding, first-run
   permissions and sign-in can finish before a downloaded update becomes
   active, so new users would never see the change.
3. **Otherwise: over the air.** JavaScript and assets reached after the
   first launch.

When unsure whether a dependency carries native code, check; do not guess.

## Order, and the gates that do not bend

1. **The release checkout is clean and at the base branch's head.** Never
   release branch code to testers or production.
2. **Backend before client.** Apply pending migrations, then deploy changed
   server code, then verify the environment matches the base branch.
   Only then deliver the client. A client that reaches users before its
   backend is the most common self-inflicted mobile outage.
3. **Read every pending migration.** Stop for the founder before anything
   with side effects on real data. Schema-only, repeatable changes proceed.
4. **Every message users will read is approved first.** Draft the update
   note from what actually changed since the last release of that kind,
   show the exact text, and wait. Publish exactly what was approved.
5. **Build and submit as separate steps**, so release notes attach to the
   exact binary.
6. **Never weaken a gate to finish.** A half-finished release reported
   plainly beats a guessed one.

## Done means delivered

A release is complete only when you have confirmed, not assumed:

- migrations applied and recorded;
- deployed server code matches the base branch;
- the update resolves on the target channel to the expected commit, or the
  build is actually available to testers on every platform and track;
- a smoke check of the changed behaviour passes against the released
  environment;
- the report to the founder says what went out, to whom, how you confirmed
  it, the approved note, and anything that did not go out and why.

## Stop and ask when

The checkout is dirty; a migration touches live data in a way you cannot
show is safe; the target is not one this skill may touch; an approval is
pending; a store console needs the founder (use `factory_ask_founder` with
`kind: "todo"` and steps); or any confirmation above fails.
