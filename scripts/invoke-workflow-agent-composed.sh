#!/bin/bash
set -euo pipefail

# claude-agent uses the workflows MCP server to compose and trigger a child workflow against
# dapr-claude-loop-agent. Prerequisites: workflow-svc, workflow-mcp, claude-agent,
# dapr-claude-loop-agent all running locally.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

PAYLOAD="${1:-${SCRIPT_DIR}/payloads/agent-composed-workflow.json}"

echo "==> Invoking claude-agent (workflow-mcp composition)"
ID=$(submit_workflow "$PAYLOAD")
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"
echo ""
echo "=== Workflow output ==="
workflow_output "$ID" | jq '.' 2>/dev/null || workflow_output "$ID"
done_hint "$ID"
