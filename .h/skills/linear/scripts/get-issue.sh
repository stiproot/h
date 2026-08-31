#!/bin/bash
set -euo pipefail

# Fetch a Linear issue (title, state, assignee, description, comments) by its identifier via the
# Linear GraphQL API. Uses LINEAR_API_KEY (a personal API key passed directly as the Authorization
# header), so it works headless — no interactive OAuth.
#
# Usage: get-issue.sh <ISSUE_ID>     e.g. get-issue.sh ABC-123

ISSUE_ID="${1:?Usage: get-issue.sh <ISSUE_ID> (e.g. ABC-123)}"
: "${LINEAR_API_KEY:?LINEAR_API_KEY must be set in the environment}"

KEY="${ISSUE_ID%%-*}"  # team key, e.g. AE
NUM="${ISSUE_ID##*-}"  # issue number, e.g. 1544

read -r -d '' QUERY <<'EOF' || true
query($key:String!,$num:Float!){
  issues(filter:{team:{key:{eq:$key}},number:{eq:$num}}){
    nodes{
      identifier title url
      state{name}
      assignee{name}
      description
      comments{nodes{ body user{name} }}
    }
  }
}
EOF

PAYLOAD=$(jq -n --arg q "$QUERY" --arg key "$KEY" --argjson num "$NUM" \
  '{query:$q, variables:{key:$key, num:$num}}')

RESP=$(curl -sf -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

if ! echo "${RESP}" | jq -e '.data.issues.nodes[0]' >/dev/null 2>&1; then
  echo "No Linear issue found for '${ISSUE_ID}'." >&2
  exit 1
fi

echo "${RESP}" | jq -r '
  .data.issues.nodes[0] |
  "Issue:    \(.identifier) — \(.title)",
  "State:    \(.state.name)",
  "Assignee: \(.assignee.name // "unassigned")",
  "URL:      \(.url)",
  "",
  "Description:",
  (.description // "(none)"),
  "",
  "Comments (\(.comments.nodes | length)):",
  (.comments.nodes[]? | "- \(.user.name): \(.body)")
'
