#!/bin/bash
set -euo pipefail

# openhands-agent builds a Node hex API, then claude-agent explores and tests it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

PAYLOAD="${1:-${SCRIPT_DIR}/payloads/openhands-workflow.json}"

echo "==> Invoking openhands-agent (build) → claude-agent (test)"
ID=$(submit_workflow "$PAYLOAD")
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"
done_hint "$ID"
