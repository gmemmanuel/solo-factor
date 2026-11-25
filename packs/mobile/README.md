# Mobile pack

Skills for building a mobile app through the factory. They came out of
shipping a React Native + Expo app to real testers with agents doing nearly
all of the work, and they concentrate on the three places mobile differs
from web:

1. **A merge is not a release.** JavaScript can go over the air; native
   changes need a store build; the backend must be ready before either.
   `mobile-release` is the Deployer's method.
2. **Agents cannot hold a phone.** `mobile-ui-preview` gives builders and
   reviewers real renders of changed screens, and gives the founder a
   before/after image to judge before they pick up their device.
   `android-device-screenshot` covers the cases that need real hardware.
3. **The UI thread is unforgiving.** `react-native-performance` and
   `reanimated-interactions` keep agents measuring before optimizing and
   keep animation work off the JavaScript thread.

| Skill | Used by |
|---|---|
| `mobile-release` | Deployer |
| `mobile-ui-preview` | builders, code reviewers |
| `react-native-performance` | builders, planners |
| `reanimated-interactions` | UI builders |
| `android-device-screenshot` | anyone working with the founder on a device |

These are starting points. Replace every `<placeholder>` with your project's
real commands before relying on them.
