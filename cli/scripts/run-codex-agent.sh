#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/codex-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export AGENT_MODEL="${CODEX_MODEL:-o4-mini}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/codex-agent}"
export AGENT_APP_DIR="${APP_DIR}"
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/skills}"

cd "${PROJECT_DIR}"
node "${PROJECT_DIR}/scripts/check-tsc.mjs" --native-only || exit 1
bunx turbo build --filter=codex-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale codex-agent 8016 3516 36016 61017

exec dapr run \
  --app-id codex-agent \
  --app-port 8016 \
  --dapr-http-port 3516 \
  --dapr-grpc-port 36016 \
  --dapr-internal-grpc-port 61017 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8016 bun run src/index.ts
