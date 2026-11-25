---
name: android-device-screenshot
description: Capture a screenshot from a connected Android test device over adb. Use when the founder is testing on a physical Android phone and wants the agent to see the current screen.
---

# Android device screenshot

This captures whatever is on a real device right now. It needs the device,
a build, and someone to navigate there. To look at your own UI change from a
session with no device, use `mobile-ui-preview` instead. Reach for `adb`
when the question needs the real runtime: system font scaling, native text
metrics, animation, or platform services.

## Workflow

1. Confirm `adb` is installed: `adb version`.
2. Check connectivity: `adb devices -l`.
3. If no device is listed:
   - **USB:** ask the founder to unlock the phone, enable USB debugging,
     choose "File transfer", and accept the authorization prompt.
   - **Wi-Fi:** reconnect to an already paired device by host and port.
     First pairing usually needs USB once.
4. Capture, with a timestamped name so nothing is overwritten:

   ```sh
   mkdir -p .context/screenshots
   adb exec-out screencap -p > ".context/screenshots/android-$(date +%Y%m%d-%H%M%S).png"
   ```

   With several devices attached, add `-s <serial>` after `adb`.
5. Read the image, and give its path in your reply.

## Rules

- Save only under a scratch directory the project ignores in git.
- A screenshot may show a real user's data. Do not attach it to a ticket or
  a pull request without checking.
