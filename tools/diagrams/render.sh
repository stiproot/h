#!/usr/bin/env bash
# Render the canonical mermaid diagrams (docs/diagrams/*.md) to PNGs under
# docs/diagrams/rendered/ — the cross-device communication artifacts (chat, Slack, a phone).
# The markdown SOURCES are the single source of truth: GitHub, IDEs, and Claude artifacts all
# render the fences natively, so rendered/ is gitignored, produced on demand.
#
# Tooling is self-provisioning and OUT of the bun workspace: @mermaid-js/mermaid-cli drags in
# puppeteer/chromium, which the CI install and the app images must never pay for. It lives in
# the gitignored tools/diagrams/.deps/ dir with its own package.json (bun's global cache makes the
# second install cheap; chromium caches under ~/.cache/puppeteer).
#
# Usage:
#   tools/diagrams/render.sh                # render every docs/diagrams/*.md (except README)
#   tools/diagrams/render.sh <name>         # render one, e.g. implement-pr-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT/docs/diagrams"
OUT_DIR="$SRC_DIR/rendered"
DEPS="$ROOT/tools/diagrams/.deps"

# Self-provision mermaid-cli (idempotent; first run may download chromium).
if [ ! -x "$DEPS/node_modules/.bin/mmdc" ]; then
  echo "render: provisioning mermaid-cli into tools/diagrams/.deps/ (first run only — bun add)"
  mkdir -p "$DEPS"
  [ -f "$DEPS/package.json" ] || printf '{"name":"h-diagram-deps","private":true}\n' > "$DEPS/package.json"
  # puppeteer's postinstall (chromium fetch) flakes on first run — observed twice live;
  # one retry against bun's now-warm cache reliably lands it.
  (cd "$DEPS" && bun add @mermaid-js/mermaid-cli >/dev/null) \
    || (cd "$DEPS" && bun add @mermaid-js/mermaid-cli >/dev/null)
fi
MMDC="$DEPS/node_modules/.bin/mmdc"

mkdir -p "$OUT_DIR"

render_one() {
  local src="$1"
  local base
  base="$(basename "$src" .md)"
  # mmdc on markdown input emits one image per fence, suffixed -1, -2, …
  "$MMDC" --quiet -i "$src" -o "$OUT_DIR/$base.png" --scale 2 --backgroundColor white
  # Single-fence sources (the norm) get the clean name.
  if [ -f "$OUT_DIR/$base-1.png" ] && [ ! -f "$OUT_DIR/$base-2.png" ]; then
    mv "$OUT_DIR/$base-1.png" "$OUT_DIR/$base.png"
  fi
  echo "rendered: docs/diagrams/rendered/$base*.png"
}

if [ $# -ge 1 ]; then
  render_one "$SRC_DIR/$1.md"
else
  found=0
  for src in "$SRC_DIR"/*.md; do
    [ "$(basename "$src")" = "README.md" ] && continue
    render_one "$src"
    found=1
  done
  [ "$found" = 1 ] || { echo "render-diagrams: no diagram sources in docs/diagrams/"; exit 1; }
fi
