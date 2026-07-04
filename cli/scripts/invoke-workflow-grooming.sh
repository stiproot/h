#!/bin/bash
set -euo pipefail

# Invoke the grooming workflow via workflow-agent: seed a task into the state store, trigger
# workflow-agent, which builds and runs a 4-step ephemeral workflow — worktree → setup → groom →
# writeback — using the workflows MCP to call workflow-svc and claude-agent.
#
# This follows the same pattern as invoke-workflow-agent.sh (task seeding + synchronous POST to
# workflow-agent) so the full trace is visible end-to-end: workflow-agent → workflow-mcp →
# workflow-svc → claude-agent.
#
# Usage:
#   invoke-workflow-grooming.sh <ISSUE_ID> [context words...] [--dry-run]
#     <ISSUE_ID>   Linear issue key, e.g. ABC-123.
#     [context]    optional free-text hypothesis/context handed to the grooming agent.
#     --dry-run    run read+analyze only; skip the write-back-to-Linear step (nothing is posted).
#
# Examples:
#   invoke-workflow-grooming.sh ABC-123
#   invoke-workflow-grooming.sh ABC-123 "probably a race in the scheduler" --dry-run
#
# Prerequisites: the target repo pre-cloned into the shared workspace root
# (cli/scripts/clone.sh); the grooming task template at
# payloads/domain/grooming-task.template.json (gitignored — see payloads/domain/README.md);
# .env carries LINEAR_API_KEY, GH_TOKEN, and NOTION_API_KEY (plus whatever credentials your
# domain template's inspection steps need, e.g. a live AWS SSO session).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

DRY_RUN=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

export ISSUE_ID="${ARGS[0]:-}"
export DRY_RUN
CONTEXT="${ARGS[*]:1}"   # remaining args joined as free-text context (may be empty)

if [[ -z "$ISSUE_ID" ]]; then
  echo "Usage: $0 <ISSUE_ID> [context words...] [--dry-run]"
  echo "Example: $0 ABC-123"
  exit 1
fi

[[ -f "${PROJECT_DIR}/.env" ]] && { set -a; source "${PROJECT_DIR}/.env"; set +a; }

AGENT_URL="${AGENT_URL:-http://localhost:8010}"
AGENT_DAPR_HTTP_PORT="${AGENT_DAPR_HTTP_PORT:-3510}"
STATE_URL="http://localhost:${AGENT_DAPR_HTTP_PORT}/v1.0/state/statestore"

PAYLOAD="${SCRIPT_DIR}/payloads/domain/grooming-task.template.json"
[[ -f "$PAYLOAD" ]] || { echo "Missing ${PAYLOAD} — domain payloads are gitignored; see payloads/domain/README.md"; exit 1; }

echo "==> Grooming Linear issue ${ISSUE_ID}$([[ $DRY_RUN == 1 ]] && echo ' (dry run — no write-back)')"

# Render the template: envsubst only ${ISSUE_ID} and ${DRY_RUN}, leaving agent-side tokens
# ($AGENT_APP_DIR / $H_SKILLS_DIR / $HOME) and engine-side {{step.field}} refs untouched.
# SC2016: single-quoted ${ISSUE_ID} / ${DRY_RUN} are intentional — they are the envsubst allowlist.
# shellcheck disable=SC2016
BODY="$(render_payload "$PAYLOAD" '${ISSUE_ID} ${DRY_RUN}')"

# Splice the free-text context in via jq (not envsubst) so quotes/backslashes in it can't corrupt
# the JSON. split() is a literal (non-regex) split, so the context is spliced in verbatim.
BODY="$(jq --arg ctx "$CONTEXT" '
  .problem |= (split("__CONTEXT__") | .[0] + $ctx + (.[1] // ""))
' <<<"$BODY")"

TASK_ID=$(jq -r '.taskId' <<<"$BODY")
echo "==> Seeding task '${TASK_ID}' into the state store"

TASK_JSON=$(jq '{id:.taskId, status:"pending", problem:.problem, issueId:(.issueId // null), result:null, pluginFeedback:null}' <<<"$BODY")
curl -sf -X POST "$STATE_URL" \
  -H "Content-Type: application/json" \
  -d "[{\"key\":\"task:${TASK_ID}\",\"value\":${TASK_JSON}}]" >/dev/null

INDEX=$(curl -s "${STATE_URL}/tasks:index"); [[ -z "$INDEX" || "$INDEX" == "null" ]] && INDEX="[]"
NEW_INDEX=$(jq --arg id "$TASK_ID" 'if index($id) then . else . + [$id] end' <<<"$INDEX")
curl -sf -X POST "$STATE_URL" \
  -H "Content-Type: application/json" \
  -d "[{\"key\":\"tasks:index\",\"value\":${NEW_INDEX}}]" >/dev/null

echo "==> Triggering workflow-agent for '${TASK_ID}' (groom → [writeback])..."
curl -s --max-time 1800 -X POST "${AGENT_URL}/run" \
  -H "Content-Type: application/json" \
  -d "{\"taskId\":\"${TASK_ID}\"}" | jq '.'

done_hint "$TASK_ID"
