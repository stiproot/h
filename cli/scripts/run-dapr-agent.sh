#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/dapr-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

# LLM config: provider-neutral LLM_* take precedence, the Anthropic-named vars are the fallback
# (resolved in main.py). Neither key is hard-required here — main.py fails clearly if no base URL is
# configured — so a DeepSeek-only setup can leave the ANTHROPIC_* vars blank and set LLM_* instead.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}"
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_BASE_URL="${LLM_BASE_URL:-}"
export AGENT_MODEL="${DAPR_AGENT_MODEL:-${AGENT_MODEL:-claude-haiku-4-5}}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/dapr-agent}"
# Opt-in workflow orchestration: set WORKFLOWS_MCP_URL (e.g. http://localhost:8005/sse) in .env to
# let this agent construct/invoke/monitor workflows. H_SKILLS_DIR (defaulted here) then lets it load
# the workflow-orchestrator procedure; both are inert when WORKFLOWS_MCP_URL is unset.
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/.h/skills}"
export H_RULES_DIR="${H_RULES_DIR:-${PROJECT_DIR}/.h/rules}"

cd "${APP_DIR}/src"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale dapr-agent 8006 3506 36006 61005

exec dapr run \
  --app-id dapr-agent \
  --app-port 8006 \
  --dapr-http-port 3506 \
  --dapr-grpc-port 36006 \
  --dapr-internal-grpc-port 61005 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8006 LOG_LEVEL=info uv run uvicorn main:app --host 0.0.0.0 --port 8006
