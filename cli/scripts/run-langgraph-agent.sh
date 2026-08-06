#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/langgraph-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}"
export AGENT_MODEL="${AGENT_MODEL:-claude-sonnet-4-6}"
export AGENT_MAX_ITERATIONS="${AGENT_MAX_ITERATIONS:-30}"

export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/langgraph-agent}"

cd "${APP_DIR}/src"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale langgraph-agent 8009 3509 36009 61011

exec dapr run \
  --app-id langgraph-agent \
  --app-port 8009 \
  --dapr-http-port 3509 \
  --dapr-grpc-port 36009 \
  --dapr-internal-grpc-port 61011 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8009 LOG_LEVEL=info uv run uvicorn main:app --host 0.0.0.0 --port 8009
