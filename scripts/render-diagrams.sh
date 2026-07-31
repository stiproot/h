#!/usr/bin/env bash
# Render the canonical mermaid diagrams (docs/diagrams/*.md) to PNGs under
# docs/diagrams/rendered/ — the cross-device communication artifacts (chat, Slack, a phone).
# The markdown SOURCES are the single source of truth: GitHub, IDEs, and Claude artifacts all
# render the fences natively, so rendered/ is gitignored, produced on demand.
#
# Tooling is self-provisioning and OUT of the bun workspace: @mermaid-js/mermaid-cli drags in
# puppeteer/chromium, which the CI install and the app images must never pay for. It lives in
# a gitignored .diagram-tools/ dir with its own package.json (bun's global cache makes the
# second install cheap; chromium caches under ~/.cache/puppeteer).
#
# Usage:
#   scripts/render-diagrams.sh              # render every docs/diagrams/*.md (except README)
#   scripts/render-diagrams.sh <name>       # render one, e.g. implement-pr-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/docs/diagrams"
OUT_DIR="$SRC_DIR/rendered"
TOOLS="$ROOT/.diagram-tools"

# Self-provision mermaid-cli (idempotent; first run may download chromium).
if [ ! -x "$TOOLS/node_modules/.bin/mmdc" ]; then
  echo "render-diagrams: provisioning mermaid-cli into .diagram-tools/ (first run only)"
  mkdir -p "$TOOLS"
  [ -f "$TOOLS/package.json" ] || printf '{"name":"h-diagram-tools","private":true}\n' > "$TOOLS/package.json"
  (cd "$TOOLS" && bun add @mermaid-js/mermaid-cli >/dev/null)
fi
MMDC="$TOOLS/node_modules/.bin/mmdc"

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
