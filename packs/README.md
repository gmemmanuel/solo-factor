# Packs

A pack is a set of stack-specific skills. Unlike the skills in `skills/`,
which ship with the plugin and describe the factory's process, a pack is
**copied into your project** and edited there, because it describes your
stack and you will change it.

| Pack | For | Skills |
|---|---|---|
| [`mobile`](mobile/) | React Native / Expo apps (most of it applies to native iOS and Android too) | release routing, UI previews without a device, performance, gestures and animation, Android device screenshots |

## Installing a pack

The Mechanic does this during onboarding when the project matches. By hand:

```sh
cp -R packs/mobile/skills/* <your-project>/.agents/skills/   # or .claude/skills/
```

Then open each skill and replace the placeholders (`<…>`) with your real
commands and paths, and record the pack under "Packs installed" in your
project's `FACTORY.md`.

## Writing a pack

A pack earns its place when the same stack knowledge would otherwise be
rediscovered in every project: how a release reaches users, what cannot be
verified without a device, which mistakes the stack makes easy. Keep each
skill to a method and its guardrails. Leave project facts as placeholders.
