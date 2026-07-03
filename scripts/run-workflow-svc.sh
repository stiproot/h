#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/workflow-svc"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

cd "${PROJECT_DIR}"
bunx turbo build --filter=workflow-svc

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale workflow-svc 8003 3503 50001 50003

exec dapr run \
  --app-id workflow-svc \
  --app-port 8003 \
  --dapr-http-port 3503 \
  --dapr-grpc-port 50001 \
  --dapr-internal-grpc-port 50003 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8003 bun run src/index.ts
