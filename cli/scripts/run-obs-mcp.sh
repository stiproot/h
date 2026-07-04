#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/obs-mcp"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

cd "${PROJECT_DIR}"
bunx turbo build --filter=obs-mcp

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale obs-mcp 8013

# obs-mcp reads Zipkin/Loki over HTTP and the run ledger off the shared volume — no Dapr sidecar.
export APP_PORT="${APP_PORT:-8013}"
export ZIPKIN_URL="${ZIPKIN_URL:-http://localhost:9411}"
export LOKI_URL="${LOKI_URL:-http://localhost:3100}"
export RUNS_DIR="${RUNS_DIR:-$(cd "${PROJECT_DIR}/.." && pwd)/h-workspace/.runs}"

exec bun run src/index.ts
