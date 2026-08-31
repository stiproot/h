#!/bin/bash
set -euo pipefail

# Post a comment to a Linear issue (identified by its human key, e.g. ABC-123) via the Linear GraphQL
# API. Uses LINEAR_API_KEY (a personal API key passed directly as the Authorization header), so it
# works headless — no interactive OAuth. This is the write counterpart to get-issue.sh: together they
# let an unattended agent read an issue and post findings back to it (e.g. a grooming pass).
#
# The comment body is read from a file or stdin — never a positional argument — so multi-line Markdown
# (with quotes, backslashes, or `$`) is passed verbatim without shell-escaping hazards.
#
# Usage:
#   add-comment.sh <ISSUE_ID> <BODY_FILE>   # body from a file    e.g. add-comment.sh ABC-123 findings.md
#   add-comment.sh <ISSUE_ID> -             # body from stdin      e.g. cat findings.md | add-comment.sh ABC-123 -
#   add-comment.sh <ISSUE_ID>               # body from stdin (same as '-')

ISSUE_ID="${1:?Usage: add-comment.sh <ISSUE_ID> <BODY_FILE|-> (e.g. add-comment.sh ABC-123 findings.md)}"
BODY_SRC="${2:--}"
: "${LINEAR_API_KEY:?LINEAR_API_KEY must be set in the environment}"

if [[ "$BODY_SRC" == "-" ]]; then
  BODY="$(cat)"
else
  [[ -f "$BODY_SRC" ]] || { echo "Body file not found: ${BODY_SRC}" >&2; exit 1; }
  BODY="$(cat "$BODY_SRC")"
fi
# Refuse to post whitespace-only bodies — Linear accepts them, but an empty grooming comment is noise.
[[ -n "${BODY//[[:space:]]/}" ]] || { echo "Refusing to post an empty comment to ${ISSUE_ID}." >&2; exit 1; }

KEY="${ISSUE_ID%%-*}"  # team key, e.g. AE
NUM="${ISSUE_ID##*-}"  # issue number, e.g. 1544

# commentCreate keys on the issue's UUID, not its human identifier — resolve ABC-123 -> UUID first.
read -r -d '' LOOKUP <<'EOF' || true
query($key:String!,$num:Float!){
  issues(filter:{team:{key:{eq:$key}},number:{eq:$num}}){ nodes{ id identifier } }
}
EOF

LOOKUP_PAYLOAD=$(jq -n --arg q "$LOOKUP" --arg key "$KEY" --argjson num "$NUM" \
  '{query:$q, variables:{key:$key, num:$num}}')

LOOKUP_RESP=$(curl -sf -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${LOOKUP_PAYLOAD}")

ISSUE_UUID=$(echo "${LOOKUP_RESP}" | jq -r '.data.issues.nodes[0].id // empty')
if [[ -z "$ISSUE_UUID" ]]; then
  echo "No Linear issue found for '${ISSUE_ID}'." >&2
  exit 1
fi

read -r -d '' MUTATION <<'EOF' || true
mutation($issueId:String!,$body:String!){
  commentCreate(input:{issueId:$issueId, body:$body}){
    success
    comment{ id url }
  }
}
EOF

MUT_PAYLOAD=$(jq -n --arg q "$MUTATION" --arg issueId "$ISSUE_UUID" --arg body "$BODY" \
  '{query:$q, variables:{issueId:$issueId, body:$body}}')

RESP=$(curl -sf -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${MUT_PAYLOAD}")

if [[ "$(echo "${RESP}" | jq -r '.data.commentCreate.success // false')" != "true" ]]; then
  echo "Failed to post comment to ${ISSUE_ID}:" >&2
  echo "${RESP}" | jq . >&2
  exit 1
fi

echo "${RESP}" | jq -r '"Posted comment to '"${ISSUE_ID}"': \(.data.commentCreate.comment.url)"'
