#!/usr/bin/env bash
# Usage: install-plugins.sh "<plugins>" <marketplace-url>...
# plugins: space-separated name@marketplace tokens. No-op when empty.
# marketplace-url: one or more marketplace URLs (each individually quoted).
# Plugin names must not contain spaces; marketplace add is idempotent (|| true);
# plugin install errors propagate — a failed install fails the step.
set -e
plugins="$1"; shift
[ -n "$plugins" ] || exit 0
for mp in "$@"; do
  claude plugin marketplace add "$mp" || true
done
for p in $plugins; do
  claude plugin install "$p"
done
