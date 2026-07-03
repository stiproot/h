#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

PAYLOAD="${PAYLOAD:-${SCRIPT_DIR}/payloads/skill-creator-workflow.template.json}"
RUN_ID="run-$(date +%s)"
export TARGET_DIR="/output/${RUN_ID}"
export SKILL_SPEC="${SKILL_SPEC:-github:anthropics/skills@690f15c}"
export SKILL_NAME="${SKILL_NAME:-skill-creator}"
export TASK="${TASK:-Use the /skill-creator skill to create a new skill called greet that makes Claude respond with a friendly greeting and the current date.}"

echo "==> Invoking claude-agent (skill-creator: ${SKILL_SPEC} --skill ${SKILL_NAME})"
ID=$(render_payload "$PAYLOAD" '${SKILL_SPEC} ${SKILL_NAME} ${TASK} ${TARGET_DIR}' | submit_workflow -)
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"

if [[ -f "./output/${RUN_ID}/output.txt" ]]; then
  echo ""
  echo "--- Claude output ---"
  cat "./output/${RUN_ID}/output.txt"
  echo "---------------------"
fi
done_hint "$ID"
