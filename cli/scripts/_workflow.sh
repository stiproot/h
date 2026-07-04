#!/bin/bash
# Shared helpers for invoke-*.sh scripts (workflow-svc submit + poll). Sourced, not executed.

WORKFLOW_URL="${WORKFLOW_URL:-http://localhost:8003}"
SIDECAR_URL="${SIDECAR_URL:-http://localhost:3503}"

# render_payload <template-file> <envsubst-allowlist>
# Renders a *.template.json by substituting only the allowlisted ${VARS} (read from the environment),
# leaving agent-side ($AGENT_APP_DIR) and engine-side ($ref / {{step.field}}) tokens untouched.
render_payload() {
  local template="$1"; shift
  envsubst "$*" < "$template"
}

# submit_workflow <payload-file|-> [endpoint]
# POSTs a JSON body (from a file, or '-' for stdin) to /workflow/<endpoint> (default: run) and echoes
# the returned instanceId.
submit_workflow() {
  local payload="$1" endpoint="${2:-run}" body
  if [[ "$payload" == "-" ]]; then body="$(cat)"; else body="$(cat "$payload")"; fi
  curl -sf -X POST "${WORKFLOW_URL}/workflow/${endpoint}" \
    -H "Content-Type: application/json" -d "$body" | jq -r '.instanceId'
}

# poll_workflow <instanceId> [timeout-secs] [interval-secs]
# Polls until the instance reaches a terminal state, printing status as it goes. Returns 0 on
# COMPLETED, 1 on FAILED/TERMINATED (dumps state), 2 on timeout.
poll_workflow() {
  local id="$1" timeout="${2:-600}" interval="${3:-5}" elapsed=0 state status
  while true; do
    state=$(curl -sf "${SIDECAR_URL}/v1.0-beta1/workflows/dapr/${id}" || echo '{"runtimeStatus":"UNKNOWN"}')
    status=$(echo "$state" | jq -r '.runtimeStatus')
    echo "    [${elapsed}s] status: ${status}"
    case "$status" in
      COMPLETED) return 0 ;;
      FAILED | TERMINATED)
        echo "$state" | jq .
        return 1
        ;;
    esac
    if (( elapsed >= timeout )); then
      echo "    timed out after ${timeout}s"
      return 2
    fi
    sleep "$interval"
    elapsed=$(( elapsed + interval ))
  done
}

# workflow_output <instanceId>
# Prints the workflow's serialized output (the map of step results), or nothing if absent.
workflow_output() {
  curl -sf "${SIDECAR_URL}/v1.0-beta1/workflows/dapr/$1" \
    | jq -r '.properties."dapr.workflow.output" // empty'
}

# done_hint <instanceId>
# Points at the run ledger / observability tooling for inspecting what the agents did.
done_hint() {
  echo ""
  echo "==> Inspect this run: obs-mcp runs_list / run_get, or \${AGENT_RUNS_DIR}/$1/ on the shared volume."
}
