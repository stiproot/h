#!/usr/bin/env bash
# Usage: install-plugins.sh "<plugins>" <marketplace-url>...
# plugins: space-separated name@marketplace tokens. No-op when empty.
# marketplace-url: one or more marketplace URLs (passed as separate arguments via $@).
# Plugin names must not contain spaces; marketplace URLs can contain query parameters;
# marketplace add is idempotent (|| true); plugin install errors propagate.
set -e
plugins="$1"; shift
[ -n "$plugins" ] || exit 0
for mp in "$@"; do
  claude plugin marketplace add "$mp" || true
done
for p in $plugins; do
  claude plugin install "$p"
done
