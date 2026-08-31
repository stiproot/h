#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/pi-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

# Not enforced at the script level (the strategy validates at run time with a clean error) — a
# missing credential should not block starting the service.
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_BASE_URL="${LLM_BASE_URL:-}"
export AGENT_MODEL="${PI_MODEL:-claude-sonnet-4-6}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/pi-agent}"
# Consumed by a workflow's `setup` step (h.setupSteps): install the h skills into the agent's workspace.
export AGENT_APP_DIR="${APP_DIR}"
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/.h/skills}"

# The agent spawns `pi` as a child process, inheriting this process's PATH. The binary may live
# in the user-local bin dir; prepend it so it resolves even from a minimal-PATH shell.
export PATH="${HOME}/.local/bin:${PATH}"

cd "${PROJECT_DIR}"
# Toolchain guard: fail loud if turbo/native bins are hollow (cross-uid-poisoned bun cache)
# instead of dying cryptically at `bunx turbo build`. See the `Toolchain guard` gotcha in CLAUDE.md.
node "${PROJECT_DIR}/scripts/check-tsc.mjs" --native-only || exit 1
bunx turbo build --filter=pi-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale pi-agent 8015 3515 36015 61016

exec dapr run \
  --app-id pi-agent \
  --app-port 8015 \
  --dapr-http-port 3515 \
  --dapr-grpc-port 36015 \
  --dapr-internal-grpc-port 61016 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8015 bun run src/index.ts
