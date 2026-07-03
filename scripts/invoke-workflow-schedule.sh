#!/bin/bash
set -euo pipefail

# Saves a workflow with a cron schedule and shows workflow-svc firing it automatically: a cron binding
# POSTs /workflow-cron-tick every 60s, and the handler runs any saved workflow whose schedule is due,
# stamping schedule.lastRunAt. Pairs with workspaceId so the workspace is provisioned once and reused.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

export KEY="${KEY:-scheduled-demo}"
TIMEOUT="${TIMEOUT:-240}"
PAYLOAD="${PAYLOAD:-${SCRIPT_DIR}/payloads/schedule-workflow.template.json}"

echo "==> Saving workflow '${KEY}' with an every-minute schedule (cron \"* * * * *\")"
render_payload "$PAYLOAD" '${KEY}' \
  | curl -sf -X POST "${WORKFLOW_URL}/workflow/save" -H "Content-Type: application/json" -d @- | jq -c .
echo ""

echo "==> Persisted schedule:"
curl -sf "${WORKFLOW_URL}/workflow/get/${KEY}" | jq -c '.schedule'
echo ""

echo "==> Waiting for the cron to fire it twice (lastRunAt should advance ~1 min apart)..."
prev=""; advances=0; elapsed=0
while (( elapsed < TIMEOUT )); do
  lr=$(curl -sf "${WORKFLOW_URL}/workflow/get/${KEY}" | jq -r '.schedule.lastRunAt // "null"')
  echo "    [${elapsed}s] lastRunAt=${lr}"
  if [[ "$lr" != "null" && "$lr" != "$prev" ]]; then
    [[ -n "$prev" ]] && advances=$((advances + 1))
    prev="$lr"
  fi
  (( advances >= 1 )) && { echo ""; echo "==> Fired on schedule twice — scheduler works."; break; }
  sleep 15; elapsed=$((elapsed + 15))
done
(( advances < 1 )) && { echo "==> Timed out before two fires."; exit 1; }
echo ""

echo "==> Cleaning up saved workflow '${KEY}'"
curl -sf -X DELETE "${SIDECAR_URL}/v1.0/state/statestore/${KEY}" >/dev/null
NEWIDX=$(curl -sf "${SIDECAR_URL}/v1.0/state/statestore/__workflow_index__" \
  | jq -c --arg k "$KEY" '[.[] | select(. != $k)]')
curl -sf -X POST "${SIDECAR_URL}/v1.0/state/statestore" -H "Content-Type: application/json" \
  -d "$(jq -nc --argjson v "$NEWIDX" '[{key:"__workflow_index__", value:$v}]')" >/dev/null
echo "    done."
