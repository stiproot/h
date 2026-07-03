#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/_workflow.sh"

export REPO_URL="${1:-}"
export TASK="${2:-You are a senior software engineer conducting a code review. Explore the ./repo directory and review the code. Write a structured Markdown review to review.md.}"
export OUTPUT_DIR="${OUTPUT_DIR:-${PROJECT_DIR}/output}"
PAYLOAD="${PAYLOAD:-${SCRIPT_DIR}/payloads/code-review-workflow.template.json}"

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: $0 <repo-url> [task-description]"
  echo "Example: $0 https://github.com/octocat/Hello-World"
  exit 1
fi

# .env carries GH_TOKEN for private-repo clones (used server-side by the clone step).
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi
mkdir -p "$OUTPUT_DIR"

echo "==> Invoking claude-agent (code-review of ${REPO_URL})"
echo "    output: ${OUTPUT_DIR}"
ID=$(render_payload "$PAYLOAD" '${REPO_URL} ${TASK} ${OUTPUT_DIR}' | submit_workflow -)
echo "==> Instance ID: ${ID}"
poll_workflow "$ID"
done_hint "$ID"
