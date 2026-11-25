---
name: mobile-ui-preview
description: Render a mobile app's real screens and components to images without a device or simulator, and produce a before/after comparison for a branch. Use when building or reviewing any change to a screen, when a founder check needs its before/after image, or when setting up a preview harness in a project that has none.
---

# UI previews without a device

Agents cannot hold a phone, and "I could not see the screen" is not a reason
to ship UI nobody looked at. A preview harness renders real components, with
their real styles and realistic data, to PNG files from a plain agent
session. It is the builder's eyes, the reviewer's independent check, and the
image the founder judges before deciding whether to pick up their device.

Fill in before first use:

- **Render command:** `<e.g. npm run ui:preview -- --scene <name>>`
- **Before/after command:** `<e.g. npm run ui:preview -- --baseline <merge-base>>`
- **Where scenes live:** `<e.g. tests/ui-preview/>`
- **Where images are written:** `<path>`, including one side-by-side `before-after.png`

## Using it

- **Builder:** add or extend a scene for every screen and state the plan
  changes: empty, loading, error, typical, and the fullest realistic data.
  Run it, **read the images**, and fix what you see. Link the before/after
  image in your report.
- **Reviewer:** regenerate the images yourself at the final head. Do not
  take the builder's on trust. A changed state with no scene is a coverage
  finding. Compare against the approved mockup when the plan has one:
  hierarchy, wording and density, not just colours.
- **Founder check:** the factory wants ONE side-by-side image, each changed
  screen before on the left and after on the right. Pass it as
  `before_after` with `founder_check`.

## What it cannot show

Say so in your report instead of implying full coverage: system font
scaling, real text measurement and line breaking on the device, animation
and gesture feel, keyboard behaviour, and anything that depends on native
modules. Those need the founder's device.

## If the project has no harness yet

Propose one to the Architect as shared tooling; it pays for itself on the
first UI ticket. The shape that works:

1. **Scenes** are small files that mount one real screen or component with
   fixed, realistic props and mocked data hooks. No network, no clock: the
   same commit always renders the same pixels.
2. **A renderer** turns a scene into a PNG headlessly. For React Native, a
   web build of the components (`react-native-web`) screenshotted with a
   headless browser at phone dimensions is the cheapest faithful option;
   component-level snapshot renderers also work.
3. **A baseline mode** checks out the merge base into a temporary worktree,
   renders the same scenes there, and writes `before/`, `current/` and a
   stitched `before-after.png` plus a list of the scenes whose pixels
   changed.
4. It runs from an ordinary agent session: no simulator, no dev server left
   running, no credentials.
