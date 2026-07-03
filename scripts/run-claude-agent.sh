#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/claude-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}"
export AGENT_MODEL="${AGENT_MODEL:-claude-haiku-4-5}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/claude-agent}"
export AGENT_APP_DIR="${APP_DIR}"
# Root-level h skills (harness skill source), reusable by any agent — delivered to the agent's
# ~/.claude/skills/ by a workflow setup step. Lives at the repo root, not inside an agent app.
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/skills}"
export TESSL_TOKEN="${TESSL_API_KEY:?TESSL_API_KEY is required}"
export GH_TOKEN="${GH_TOKEN:-}"
export NOTION_API_KEY="${NOTION_API_KEY:-}"
export MCP_CONFIG_SRC="${AGENT_APP_DIR}/.mcp.local.json"

cd "${PROJECT_DIR}"
bunx turbo build --filter=claude-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale claude-agent 8002 3502 36002 50002

exec dapr run \
  --app-id claude-agent \
  --app-port 8002 \
  --dapr-http-port 3502 \
  --dapr-grpc-port 36002 \
  --dapr-internal-grpc-port 50002 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8002 bun run src/index.ts
