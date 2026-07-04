#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/workflow-mcp"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

cd "${PROJECT_DIR}"
bunx turbo build --filter=workflow-mcp

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale workflow-mcp 8005 3505 36005 50010

exec dapr run \
  --app-id workflow-mcp \
  --app-port 8005 \
  --dapr-http-port 3505 \
  --dapr-grpc-port 36005 \
  --dapr-internal-grpc-port 50010 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8005 bun run src/index.ts
