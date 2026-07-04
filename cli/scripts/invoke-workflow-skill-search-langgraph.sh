#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

PAYLOAD="${1:-${SCRIPT_DIR}/payloads/langgraph-workflow.json}"

echo "==> Invoking langgraph-agent"
ID=$(submit_workflow "$PAYLOAD")
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"
echo ""
echo "=== Workflow output ==="
workflow_output "$ID" | jq '.' 2>/dev/null || workflow_output "$ID"
done_hint "$ID"
