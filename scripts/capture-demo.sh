#!/usr/bin/env bash
# Regenerate docs/assets/flow.gif (the README's walkthrough) and the six
# scene stills from docs/index.html. Needs a headless Chromium (Playwright's
# cache, or set CHROME) and ffmpeg.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
chrome="${CHROME:-$(find "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright" -type f -name chrome-headless-shell 2>/dev/null | sort | tail -1 || true)}"
[ -x "$chrome" ] || { echo "No headless Chromium found; set CHROME." >&2; exit 1; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
beats=(4 4 5 4 4 6)
frame=0; list="$work/frames.txt"; : > "$list"
for scene in 1 2 3 4 5 6; do
  last=${beats[$((scene - 1))]}
  for beat in $(seq 0 "$last"); do
    png="$work/$(printf '%03d' "$frame").png"
    "$chrome" --headless --disable-gpu --hide-scrollbars --user-data-dir="$work/profile" --window-size=1200,640 \
      --virtual-time-budget=1500 --screenshot="$png" "file://$root/docs/index.html?embed&scene=$scene&t=$beat" >/dev/null 2>&1
    # The last beat of a scene is held long enough to read.
    hold=$([ "$beat" = "$last" ] && echo 3.2 || echo 1.0)
    printf "file '%s'\nduration %s\n" "$png" "$hold" >> "$list"
    [ "$beat" = "$last" ] && cp "$png" "$root/docs/assets/flow-$scene.png"
    frame=$((frame + 1))
  done
done
printf "file '%s'\n" "$png" >> "$list"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$list" \
  -vf "fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  "$root/docs/assets/flow.gif"
ls -la "$root/docs/assets/flow.gif"
