#!/bin/bash
set -euo pipefail

# Invoke the workflow-agent: seed a plain-English task into the state store, then trigger the agent,
# which reasons the task into a workflow and builds → runs → monitors it. Task configs live in
# payloads/<name>-task.json (static) or payloads/<name>-task.template.json (with ${VARS});
# org-specific configs live in the gitignored payloads/domain/ and resolve the same way.
#
# Usage: invoke-workflow-agent.sh <name> [value | VAR=value ...]
#
# Args are either bare positional values (filled into the task config's ${VARS} in order) or
# explicit VAR=value pairs (which take precedence):
#   invoke-workflow-agent.sh trivial
#   invoke-workflow-agent.sh linear-read ABC-123              # or: linear-read ISSUE_ID=ABC-123
#   invoke-workflow-agent.sh repo-qa https://github.com/octocat/Hello-World "" "What does this repo do?"
#     (repo-qa positional order = REPO_URL BRANCH QUESTIONS)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

AGENT_URL="${AGENT_URL:-http://localhost:8010}"          # workflow-agent app
DAPR_HTTP_PORT="${DAPR_HTTP_PORT:-3510}"                  # workflow-agent's Dapr sidecar
STATE_URL="http://localhost:${DAPR_HTTP_PORT}/v1.0/state/statestore"

[[ -f "${PROJECT_DIR}/.env" ]] && { set -a; source "${PROJECT_DIR}/.env"; set +a; }

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "Usage: $0 <name> [value | VAR=value ...]"
  echo "Available task configs:"
  ls "${SCRIPT_DIR}"/payloads/*-task*.json "${SCRIPT_DIR}"/payloads/domain/*-task*.json 2>/dev/null | sed 's#.*/##; s/-task.*//' | sort -u | sed 's/^/  - /'
  exit 1
fi
shift

# Committed demo payloads first, then the gitignored domain dir (see payloads/README.md).
TASK_FILE=""
for cand in \
  "${SCRIPT_DIR}/payloads/${NAME}-task.template.json" \
  "${SCRIPT_DIR}/payloads/${NAME}-task.json" \
  "${SCRIPT_DIR}/payloads/domain/${NAME}-task.template.json" \
  "${SCRIPT_DIR}/payloads/domain/${NAME}-task.json"; do
  [[ -f "$cand" ]] && { TASK_FILE="$cand"; break; }
done
[[ -z "$TASK_FILE" ]] && { echo "No task config for '${NAME}' (payloads[/domain]/${NAME}-task[.template].json)"; exit 1; }

# Template variables, in first-occurrence order — positional args fill these in order.
# ({ grep || true; } so a static config with no ${VARS} (grep exits 1) doesn't trip set -e/pipefail.)
VARS=$({ grep -oE '\$\{[A-Z_]+\}' "$TASK_FILE" || true; } | sed 's/[${}]//g' | awk '!seen[$0]++')

# Split args into explicit VAR=value (take precedence) and bare positional values.
ALLOW=""
EXPLICIT=" "
POSITIONAL=()
for arg in "$@"; do
  if [[ "$arg" == *=* ]]; then
    export "$arg"
    ALLOW="${ALLOW}\${${arg%%=*}} "
    EXPLICIT="${EXPLICIT}${arg%%=*} "
  else
    POSITIONAL+=("$arg")
  fi
done

# Map positional values onto the not-explicitly-set template vars, in order.
# (set +u around the array reads: in bash 3.2 reading an empty array under nounset is an error.)
set +u
npos=${#POSITIONAL[@]}
pi=0
for v in $VARS; do
  case "$EXPLICIT" in *" $v "*) continue ;; esac
  [[ $pi -lt $npos ]] || continue
  export "${v}=${POSITIONAL[$pi]}"
  ALLOW="${ALLOW}\${${v}} "
  pi=$((pi + 1))
done
set -u
if [[ $pi -lt $npos ]]; then
  echo "Too many arguments for '${NAME}'. Template variables: $(echo "$VARS" | paste -sd, -)"
  exit 1
fi

# Static configs are read verbatim; templates are rendered (only the passed vars are substituted).
if [[ -z "$ALLOW" ]]; then BODY="$(cat "$TASK_FILE")"; else BODY="$(envsubst "$ALLOW" < "$TASK_FILE")"; fi
if grep -q '\${' <<<"$BODY"; then
  echo "Unresolved \${...} in rendered task — pass the missing VAR=value:"
  grep -oE '\$\{[A-Z_]+\}' <<<"$BODY" | sort -u | sed 's/^/  /'
  exit 1
fi

TASK_ID=$(jq -r '.taskId' <<<"$BODY")
echo "==> Seeding task '${TASK_ID}' into the state store"

TASK_JSON=$(jq '{id:.taskId, status:"pending", problem:.problem, issueId:(.issueId // null), result:null, pluginFeedback:null}' <<<"$BODY")
curl -sf -X POST "$STATE_URL" -H "Content-Type: application/json" \
  -d "[{\"key\":\"task:${TASK_ID}\",\"value\":${TASK_JSON}}]" >/dev/null

# Append to the task index (read-modify-write).
INDEX=$(curl -s "${STATE_URL}/tasks:index"); [[ -z "$INDEX" || "$INDEX" == "null" ]] && INDEX="[]"
NEW_INDEX=$(jq --arg id "$TASK_ID" 'if index($id) then . else . + [$id] end' <<<"$INDEX")
curl -sf -X POST "$STATE_URL" -H "Content-Type: application/json" \
  -d "[{\"key\":\"tasks:index\",\"value\":${NEW_INDEX}}]" >/dev/null

echo "==> Triggering workflow-agent for '${TASK_ID}' (build → run → monitor)..."
curl -s --max-time 1800 -X POST "${AGENT_URL}/run" \
  -H "Content-Type: application/json" -d "{\"taskId\":\"${TASK_ID}\"}" | jq '.'
