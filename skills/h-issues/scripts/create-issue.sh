#!/bin/bash
set -euo pipefail

# Create a GitHub issue on the h repo (h-issues skill). Headless: GH_TOKEN + curl.
#
# Usage: create-issue.sh "<title>" <body.md> [label ...]
#   <title>    imperative, specific, ≤80 chars (see SKILL.md)
#   <body.md>  path to the Markdown body (Context / Problem / Acceptance)
#   [label]    optional labels — NEVER agent-approved (the maintainer's trust gate)
#
# H_REPO overrides the target (default stiproot/h). Prints the issue number and URL.

TITLE="${1:?Usage: create-issue.sh \"<title>\" <body.md> [label ...]}"
BODY_FILE="${2:?body .md path required}"
shift 2
REPO="${H_REPO:-stiproot/h}"
: "${GH_TOKEN:?GH_TOKEN is required}"

[[ -f "$BODY_FILE" ]] || { echo "body file not found: $BODY_FILE" >&2; exit 1; }

for label in "$@"; do
  if [[ "$label" == "agent-approved" ]]; then
    echo "refusing to self-apply agent-approved — that label is the maintainer's trust gate" >&2
    exit 1
  fi
done

LABELS_JSON=$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')

python3 - "$TITLE" "$BODY_FILE" "$LABELS_JSON" <<'EOF' > /tmp/h-issue-body.json
import json, sys
title, body_file, labels_json = sys.argv[1], sys.argv[2], sys.argv[3]
payload = {"title": title, "body": open(body_file).read(), "labels": json.loads(labels_json)}
print(json.dumps(payload))
EOF

curl -sf -m 15 -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/issues" \
  -d @/tmp/h-issue-body.json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("#%s %s" % (d["number"], d["html_url"]))'
