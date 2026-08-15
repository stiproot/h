#!/usr/bin/env bash
# Usage: install-steering.sh <steering-file> [claude-home]
#
# Install h's runtime steering into an agent's user-global memory ADDITIVELY.
#
# h's steering describes the RUNTIME the agent is running inside — the MCP set, the output
# contract, the publish edge. It is deliberately NOT the rules of whatever repository the agent is
# working in, and the steering file says so in its own first paragraph. So it is installed
# ALONGSIDE whatever is already there, never over it:
#
#   <claude-home>/h-runtime.md   h's own file — overwritten freely, h is its only writer
#   <claude-home>/CLAUDE.md      appended to, and only ever BETWEEN the markers below
#
# Everything outside the markers is preserved byte for byte, so this is safe to run against a home
# that already has memory in it — which on the LOCAL substrate is the operator's own machine, where
# the previous `cp` over CLAUDE.md destroyed their personal memory on every `--with-setup` run.
# Re-running replaces the block in place rather than appending a second copy.
#
# The block carries the steering INLINE rather than an `@h-runtime.md` import: an import is one
# line and self-updating, but if imports are not honoured wherever this lands, the steering
# disappears with no error at all. Inline cannot fail quietly.
set -euo pipefail

src="${1:?usage: install-steering.sh <steering-file> [claude-home]}"
home="${2:-$HOME/.claude}"

[ -f "$src" ] || { echo "install-steering: no steering file at $src" >&2; exit 1; }

begin="<!-- BEGIN h runtime steering (managed by h — edits between the markers are overwritten) -->"
end="<!-- END h runtime steering -->"

mkdir -p "$home"
cp "$src" "$home/h-runtime.md"

memory="$home/CLAUDE.md"
[ -f "$memory" ] || : > "$memory"

# Drop a previous block (if any), then append the current one. awk rather than sed -i so the
# marker text needs no escaping and the file is rewritten atomically via the temp file.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
awk -v b="$begin" -v e="$end" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  !skip   { print }
' "$memory" > "$tmp"

# Collapse trailing blank lines so repeated runs cannot grow the file unboundedly.
while [ -s "$tmp" ] && [ -z "$(tail -n 1 "$tmp")" ]; do
  sed -i '$ d' "$tmp"
done

{
  [ -s "$tmp" ] && echo
  echo "$begin"
  cat "$src"
  echo "$end"
} >> "$tmp"

mv "$tmp" "$memory"
trap - EXIT
