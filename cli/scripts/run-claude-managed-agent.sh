#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/claude-managed-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}"
export AGENT_MODEL="${AGENT_MODEL:-claude-sonnet-4-6}"
export AGENT_MAX_ITERATIONS="${AGENT_MAX_ITERATIONS:-10}"

cd "${APP_DIR}/src"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale claude-managed-agent 8008 3508 36008 61009

exec dapr run \
  --app-id claude-managed-agent \
  --app-port 8008 \
  --dapr-http-port 3508 \
  --dapr-grpc-port 36008 \
  --dapr-internal-grpc-port 61009 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env PYTHONPATH=. uvicorn main:app --host 0.0.0.0 --port 8008
