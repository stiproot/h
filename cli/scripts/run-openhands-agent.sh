#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/openhands-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

# Not enforced at the script level (the strategy validates at run time with a clean error) — a
# missing credential or a domain-only tool (tessl) should not block starting the service.
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_BASE_URL="${LLM_BASE_URL}"
export AGENT_MODEL="${OPENHANDS_MODEL:-claude-sonnet-4-6}"
# MCP config source (OpenHands-format): provisioned per run into $HOME/.openhands/mcp.json so the
# CLI can reach workflow-mcp / github / dapr / obs. GH_TOKEN is substituted into the github header.
export GH_TOKEN="${GH_TOKEN:-}"
export MCP_CONFIG_SRC="${MCP_CONFIG_SRC:-${PROJECT_DIR}/apps/openhands-agent/.mcp.host.json}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/openhands-agent}"
# Consumed by a workflow's `setup` step (h.setupSteps): install the h skills into the agent's
# workspace and copy runtime steering. Parity with run-claude-agent.sh — without these the setup
# step's `cp -r $H_SKILLS_DIR/.` runs against an empty var. openhands-agent ships no steering/ dir,
# so the (guarded) steering copy is a clean no-op.
export AGENT_APP_DIR="${APP_DIR}"
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/.h/skills}"
export TESSL_TOKEN="${TESSL_API_KEY:-}"
# Available to the agent process so OpenHands' built-in "linear" skill can authenticate to the
# Linear GraphQL API; leave unset if no scenario needs Linear.
export LINEAR_API_KEY="${LINEAR_API_KEY:-}"

# The agent spawns `openhands` (the run) and `tessl` (setup steps) as child processes, inheriting
# this process's PATH. Both live in the user-local bin dir; prepend it so they resolve even when
# the pane was launched from a minimal-PATH shell (otherwise: ENOENT spawning 'openhands').
export PATH="${HOME}/.local/bin:${PATH}"

cd "${PROJECT_DIR}"
# Toolchain guard: fail loud if turbo/native bins are hollow (cross-uid-poisoned bun cache)
# instead of dying cryptically at `bunx turbo build`. See the `Toolchain guard` gotcha in CLAUDE.md.
node "${PROJECT_DIR}/scripts/check-tsc.mjs" --native-only || exit 1
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
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8004 bun run src/index.ts
