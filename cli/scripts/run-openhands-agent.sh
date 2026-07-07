#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/openhands-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export LLM_API_KEY="${LLM_API_KEY:?LLM_API_KEY is required}"
export LLM_BASE_URL="${LLM_BASE_URL}"
export AGENT_MODEL="${OPENHANDS_MODEL:-claude-sonnet-4-6}"
# MCP config source (OpenHands-format): provisioned per run into $HOME/.openhands/mcp.json so the
# CLI can reach workflow-mcp / github / dapr / obs. GH_TOKEN is substituted into the github header.
export GH_TOKEN="${GH_TOKEN:-}"
export MCP_CONFIG_SRC="${MCP_CONFIG_SRC:-${PROJECT_DIR}/apps/openhands-agent/.mcp.local.json}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/openhands-agent}"
export TESSL_TOKEN="${TESSL_API_KEY:?TESSL_API_KEY is required}"
# Available to the agent process so OpenHands' built-in "linear" skill can authenticate to the
# Linear GraphQL API; leave unset if no scenario needs Linear.
export LINEAR_API_KEY="${LINEAR_API_KEY:-}"

# The agent spawns `openhands` (the run) and `tessl` (setup steps) as child processes, inheriting
# this process's PATH. Both live in the user-local bin dir; prepend it so they resolve even when
# the pane was launched from a minimal-PATH shell (otherwise: ENOENT spawning 'openhands').
export PATH="${HOME}/.local/bin:${PATH}"

cd "${PROJECT_DIR}"
bunx turbo build --filter=openhands-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale openhands-agent 8004 3504 36004 61004

exec dapr run \
  --app-id openhands-agent \
  --app-port 8004 \
  --dapr-http-port 3504 \
  --dapr-grpc-port 36004 \
  --dapr-internal-grpc-port 61004 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8004 bun run src/index.ts
