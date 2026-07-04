#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

PAYLOAD="${1:-${SCRIPT_DIR}/payloads/skill-search-workflow.json}"

echo "==> Invoking claude-agent (skill-search)"
ID=$(submit_workflow "$PAYLOAD")
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"
done_hint "$ID"
