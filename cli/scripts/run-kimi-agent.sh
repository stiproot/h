#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/kimi-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

# ── Moonshot / Kimi auth block ─────────────────────────────────────────────
# ANTHROPIC_AUTH_TOKEN is consumed by the claude CLI as Authorization: Bearer.
# None of the ANTHROPIC_DEFAULT_*_MODEL slots are left unset — a missing one
# silently routes a subagent call to a nonexistent Anthropic model.
export ANTHROPIC_AUTH_TOKEN="${MOONSHOT_API_KEY}"
export KIMI_ANTHROPIC_URL="${KIMI_ANTHROPIC_URL:-https://api.moonshot.ai/anthropic}"
# KIMI_MODEL, not the ambient AGENT_MODEL: in this repo AGENT_MODEL means "the claude fleet
# model" (.env sets a claude-* id), and letting it bleed through routes a Claude model id to
# Moonshot's endpoint → 404 on every run. Same silent-model-override class PR #99 fixed in
# panelize. Override kimi's model with KIMI_MODEL (or per-run via the step's model input).
export AGENT_MODEL="${KIMI_MODEL:-kimi-k3}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-kimi-k3}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-kimi-k3}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-kimi-k3}"
export ANTHROPIC_DEFAULT_FABLE_MODEL="${ANTHROPIC_DEFAULT_FABLE_MODEL:-kimi-k3}"
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-kimi-k3}"
export ENABLE_TOOL_SEARCH="false"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-1048576}"
# Do NOT export ANTHROPIC_API_KEY at the script level — the runner's env dict
# sets it to "" per-run to override any ambient value.
export MCP_CONFIG_SRC="${MCP_CONFIG_SRC:-${PROJECT_DIR}/apps/kimi-agent/.mcp.json}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/kimi-agent}"
export AGENT_APP_DIR="${APP_DIR}"
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/skills}"
export GH_TOKEN="${GH_TOKEN:-}"

cd "${PROJECT_DIR}"
node "${PROJECT_DIR}/scripts/check-tsc.mjs" --native-only || exit 1
bunx turbo build --filter=kimi-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale kimi-agent 8017 3517 36017 61018

exec dapr run \
  --app-id kimi-agent \
  --app-port 8017 \
  --dapr-http-port 3517 \
  --dapr-grpc-port 36017 \
  --dapr-internal-grpc-port 61018 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8017 bun run src/index.ts
