#!/bin/bash
set -euo pipefail

# Demonstrates a reusable agent workspace. A workflow carrying a top-level `workspaceId` targets a
# stable workspace dir across runs; the idempotent `setup` step records a hash in
# .agent-setup-complete and short-circuits on reuse — so it provisions skills/config only once.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

export WORKSPACE_ID="${WORKSPACE_ID:-reusable-demo}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"
TIMEOUT="${TIMEOUT:-120}"
PAYLOAD="${PAYLOAD:-${SCRIPT_DIR}/payloads/workspace-reuse-workflow.template.json}"

run_once() {
  echo "==> $1 (workspaceId=${WORKSPACE_ID})"
  local id
  id=$(render_payload "$PAYLOAD" '${WORKSPACE_ID}' | submit_workflow -)
  echo "    instance: ${id}"
  poll_workflow "$id" "$TIMEOUT" "$POLL_INTERVAL"
}

run_once "Run 1 (provisions)"
echo ""
run_once "Run 2 (reuses workspace, skips setup)"
echo ""
echo "==> Both runs targeted {AGENT_BASE_DIR}/workspaces/${WORKSPACE_ID}; run 2's setup short-circuited"
echo "    via .agent-setup-complete (spec hash unchanged)."
