#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/dapr-mcp"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

cd "${PROJECT_DIR}"
# Toolchain guard: fail loud if turbo/native bins are hollow (cross-uid-poisoned bun cache)
# instead of dying cryptically at `bunx turbo build`. See the `Toolchain guard` gotcha in CLAUDE.md.
node "${PROJECT_DIR}/scripts/check-tsc.mjs" --native-only || exit 1
bunx turbo build --filter=dapr-mcp

cd "${APP_DIR}"

# --app-port is the GenericActor host (express/DaprServer), since the sidecar calls actor
# callbacks on the app-port. MCP-SSE is served by Fastify on APP_PORT (8011), reached
# directly by clients. The actor port is 8012 (not 8021 — that is taken by a macOS launchd
# daemon on this platform).
source "${SCRIPT_DIR}/_lib.sh"
stop_stale dapr-mcp 8011 8012 3511 36011 61013

exec dapr run \
  --app-id dapr-mcp \
  --app-port 8012 \
  --dapr-http-port 3511 \
  --dapr-grpc-port 36011 \
  --dapr-internal-grpc-port 61013 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8011 ACTOR_APP_PORT=8012 DAPR_HTTP_PORT=3511 bun run src/index.ts
