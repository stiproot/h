#!/bin/bash
set -euo pipefail

# Saves a workflow definition under a key, then invokes it by key — decoupling authoring from
# execution.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

export WORKFLOW_KEY="${WORKFLOW_KEY:-test-workflow-$(date +%s)}"
PAYLOAD="${PAYLOAD:-${SCRIPT_DIR}/payloads/persistence-workflow.template.json}"

echo "==> Saving workflow under key: ${WORKFLOW_KEY}"
render_payload "$PAYLOAD" '${WORKFLOW_KEY}' \
  | curl -sf -X POST "${WORKFLOW_URL}/workflow/save" -H "Content-Type: application/json" -d @- | jq -c .

echo "==> Invoking saved workflow by key"
ID=$(curl -sf -X POST "${WORKFLOW_URL}/workflow/run/${WORKFLOW_KEY}" | jq -r '.instanceId')
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"
echo ""
echo "=== Workflow output ==="
workflow_output "$ID" | jq '.' 2>/dev/null || true
done_hint "$ID"
