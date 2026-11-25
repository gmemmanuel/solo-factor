---
name: reanimated-interactions
description: Build or review React Native Reanimated and Gesture Handler interactions. Use for shared values, animated styles, timing or spring animations, layout or scroll animations, gestures, swipes, dragging, drawers, touch handling, reduced motion, or UI-thread performance.
---

# Reanimated interactions

Check the installed versions of Reanimated and Gesture Handler before
writing version-specific code; their APIs differ between major versions.

## Workflow

1. Identify the interaction, what accessibility expects of it, and whether
   the visual state must stay responsive while JavaScript is busy.
2. Keep continuous visual state in shared values, and keep UI-thread
   worklets short and deterministic.
3. With Gesture Handler 2, use the builder API and memoize gestures whose
   inputs are stable. Confirm the app root already provides the
   gesture-handler setup before adding wrappers.
4. Schedule React state, navigation and analytics from a worklet onto the
   JavaScript thread with the scheduling function your installed version
   provides (`scheduleOnRN` in Reanimated 4; `runOnJS` before it).
5. Respect reduced-motion preferences for motion that is not essential.
6. Test with geometry, not just accessibility actions: drive grant, move
   and release, include a re-render mid-gesture, and assert that a parent
   press did not fire.

## Guardrails

- No heavy computation, side effects or repeated JavaScript scheduling
  inside `useAnimatedStyle` or high-frequency gesture callbacks.
- Do not mix competing gesture systems in one interaction tree. Compose
  gestures deliberately when they must cooperate.
- Keep the active gesture primitive stable across re-renders. A healthy
  move delta followed by zero at release usually means the responder was
  recreated mid-gesture.
- Do not add motion because a state changed. Motion must clarify feedback,
  hierarchy or progress.
- A settled render cannot prove native recognition or scrolling. Those need
  a real device: say so, and ask the founder to try it.

## Attribution

Adapted from Software Mansion Labs' `react-native-best-practices` skill
(MIT, as declared in its `SKILL.md`), reduced to a workflow and guardrails.
