---
name: react-native-performance
description: Measure and improve React Native performance. Use for slow or janky UI, frame drops, excessive re-renders, slow startup, large bundles, memory growth, list or input lag, or a performance-focused code review.
---

# React Native performance

Performance work is a measurement loop. If the number does not improve,
revert, or try the next hypothesis the evidence supports.

## Workflow

1. Define the affected interaction and capture a baseline before proposing
   anything. Record the build type, device, scenario, and one relevant
   metric: frame rate, commit cost or re-render count, startup time, bundle
   size, or memory trend.
2. Find the first **measured** bottleneck. Do not infer a render problem
   from component count, and do not add `useMemo` or `useCallback` on
   suspicion.
3. Apply the smallest change that targets the measured cause, repeat the
   same measurement, and keep the before/after evidence in the plan.
4. Add a focused automated test for behaviour that could regress.

## Triage

- **Frame drops or animation jank:** profile the interaction first. Keep
  visual work off the JavaScript thread (`reanimated-interactions`).
- **Broad re-renders:** identify the state or context update and the
  components actually re-rendering. Prefer a smaller state boundary or
  stable data flow; memoize only when the profile proves it helps.
- **List or input lag:** check virtualization, the cost of rendering one
  item, unstable props, and synchronous work on each keystroke. Do not
  switch list libraries without a measured bottleneck.
- **Slow startup or a large bundle:** measure a release-equivalent build
  before and after. Review direct imports, unused dependencies and assets
  before reaching for code-splitting or native changes.
- **Memory growth:** establish a repeatable flow and a baseline. Separate
  JavaScript retention from native resource lifetime before choosing a fix.

## Guardrails

- Check the installed package versions before recommending a
  version-specific API.
- Preserve the project's existing navigation, styling and startup patterns.
- A debug build's numbers are not a release build's. Say which you measured.

## Attribution

Adapted from Callstack Incubator's `react-native-best-practices` skill (MIT
License), reduced to a workflow and guardrails.
