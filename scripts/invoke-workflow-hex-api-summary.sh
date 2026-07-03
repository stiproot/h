#!/bin/bash
set -euo pipefail

# openhands-agent builds a Node hex API, claude-agent summarizes it, and the summary is copied to
# ./output/<run-id>/.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

RUN_ID="run-$(date +%s)"
export TARGET_DIR="/output/${RUN_ID}"
PAYLOAD="${PAYLOAD:-${SCRIPT_DIR}/payloads/hex-api-workflow.template.json}"

echo "==> Invoking openhands-agent (hex-api) → claude-agent (summarize), output → ./output/${RUN_ID}"
ID=$(render_payload "$PAYLOAD" '${TARGET_DIR}' | submit_workflow -)
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"

if [[ -f "./output/${RUN_ID}/output.txt" ]]; then
  echo ""
  echo "--- Summary ---"
  cat "./output/${RUN_ID}/output.txt"
  echo "---------------"
fi
done_hint "$ID"
