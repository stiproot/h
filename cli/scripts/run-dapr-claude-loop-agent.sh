#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/dapr-claude-loop-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}"
export AGENT_MODEL="${AGENT_MODEL:-claude-sonnet-4-6}"
export AGENT_MAX_ITERATIONS="${AGENT_MAX_ITERATIONS:-30}"

export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/dapr-claude-loop-agent}"

cd "${APP_DIR}/src"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale dapr-claude-loop-agent 8007 3507 36007 61014

exec dapr run \
  --app-id dapr-claude-loop-agent \
  --app-port 8007 \
  --dapr-http-port 3507 \
  --dapr-grpc-port 36007 \
  --dapr-internal-grpc-port 61014 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8007 LOG_LEVEL=info uv run uvicorn main:app --host 0.0.0.0 --port 8007
