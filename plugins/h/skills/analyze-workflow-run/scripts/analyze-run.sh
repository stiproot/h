#!/bin/bash
set -uo pipefail

# Analyze an h workflow run across every observability source and print a single report:
# workflow status, the run-ledger per-step outcomes (authoritative), agent outputs, worktree state,
# Zipkin error spans, and any follow-up tasks the run seeded via pub/sub.
#
# Run from the h repo root (paths default to the local layout; override via env).
# Usage: analyze-run.sh <workflowInstanceId> [taskId]

INSTANCE="${1:?Usage: analyze-run.sh <workflowInstanceId> [taskId]}"
TASK_ID="${2:-$INSTANCE}"   # for the agent-built path, the taskId is usually == the instanceId

WF_SVC="${WF_SVC_URL:-http://localhost:8003}"
STATE="${DAPR_STATE_URL:-http://localhost:3510/v1.0/state/statestore}"
AGENT_RUNS_DIR="${AGENT_RUNS_DIR:-../h-workspace/.runs}"
TARGET_REPO="${TARGET_REPO_PATH:-../h-workspace/repo}"
ZIPKIN="${ZIPKIN_URL:-http://localhost:9411}"
G="${AGENT_RUNS_DIR}/${INSTANCE}"

echo "================ 1. workflow status ================"
curl -s --max-time 5 "${WF_SVC}/workflow/status/${INSTANCE}" \
  | jq '{runtimeStatus, output:(.output[0:300])}' 2>/dev/null || echo "(workflow-svc unreachable)"

echo ""; echo "================ 2. task state (the agent's OWN report — treat as a claim, verify below) ================"
curl -s "${STATE}/task:${TASK_ID}" \
  | jq '{id, status, issueId, result:(.result[0:400])}' 2>/dev/null || echo "(no task:${TASK_ID})"

echo ""; echo "================ 3. run ledger — per-step outcomes (AUTHORITATIVE) ================"
# A failed setup/clone/worktree shows here with its real error even when the agent's task.result only
# guesses. Newest first.
if [ -d "${G}" ]; then
  for d in $(ls -dt "${G}"/*/ 2>/dev/null); do
    if [ -f "${d}/summary.json" ]; then
      jq -r '"[\(.status // "?")] \(.kind // "agent")/\(.activity // .agentId // "run")\(if .error then " — ERROR: "+(.error[0:220]) else "" end)"' "${d}/summary.json" 2>/dev/null
    else
      echo "[in-flight] $(basename "${d}") (no summary.json — agent run still going or died mid-run)"
    fi
  done
else
  echo "(no ledger group at ${G})"
fi

echo ""; echo "================ 4. agent outputs (diagnosis / reports / fix summary) ================"
for d in $(ls -dt "${G}"/*claude*/ "${G}"/*openhands*/ "${G}"/*dapr*/ "${G}"/*langgraph*/ 2>/dev/null); do
  out="${d}output.txt"
  [ -f "${out}" ] && { echo "--- $(basename "${d}") ---"; head -c 700 "${out}"; echo; echo; }
done

echo "================ 5. worktree state (what the run produced) ================"
git -C "${TARGET_REPO}" worktree list 2>/dev/null | grep -E "${INSTANCE}|triage" || echo "(no matching worktree)"
WT="$(git -C "${TARGET_REPO}" worktree list 2>/dev/null | awk -v i="${INSTANCE}" 'index($0,i){print $1; exit}')"
if [ -n "${WT:-}" ]; then
  echo "uncommitted changes in ${WT}:"; git -C "${WT}" status --porcelain 2>/dev/null | head -20
fi

echo ""; echo "================ 6. Zipkin error spans (cross-check; catches activity failures) ================"
curl -s --max-time 8 "${ZIPKIN}/api/v2/traces?serviceName=workflow-svc&annotationQuery=error&limit=40&lookback=3600000" 2>/dev/null \
  | jq -r '.[][] | select(.tags.error) | "[\(.name)] \(.tags.error[0:160])"' 2>/dev/null | sort -u | head -15 \
  || echo "(zipkin unreachable)"

echo ""; echo "================ 7. follow-up tasks seeded via pub/sub (e.g. plugin-improvement) ================"
curl -s "${STATE}/tasks:index" | jq '.' 2>/dev/null || echo "(no tasks:index)"
