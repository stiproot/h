#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/workflow-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}"
export AGENT_MODEL="${AGENT_MODEL:-claude-sonnet-4-6}"
export AGENT_MAX_ITERATIONS="${AGENT_MAX_ITERATIONS:-25}"
# workflow-mcp is reachable on the host at 8005 in local dev.
export WORKFLOW_MCP_URL="${WORKFLOW_MCP_URL:-http://localhost:8005/sse}"

cd "${APP_DIR}/src"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale workflow-agent 8010 3510 36010 50012

exec dapr run \
  --app-id workflow-agent \
  --app-port 8010 \
  --dapr-http-port 3510 \
  --dapr-grpc-port 36010 \
  --dapr-internal-grpc-port 50012 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8010 LOG_LEVEL=info uv run uvicorn main:app --host 0.0.0.0 --port 8010
