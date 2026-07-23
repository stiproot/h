#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/codex-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
# Auth: leave OPENAI_API_KEY empty and set CODEX_AUTH_MODE=chatgpt to run on a ChatGPT
# (Plus/Pro/Team) subscription. CODEX_HOME is a DEDICATED h-managed dir (NOT the user's ~/.codex):
# seed it once with `cli/scripts/seed-codex-auth.sh` (copies ~/.codex/auth.json in), and the
# codex-runner writes config.toml (h's MCP servers) here each run. Keeping it separate from
# ~/.codex means h runs never pollute the user's personal codex config. See docs/plans/codex-chatgpt-auth.md.
export CODEX_AUTH_MODE="${CODEX_AUTH_MODE:-}"
# h's canonical MCP set (same servers claude-agent provisions); the runner translates it to codex TOML.
export MCP_CONFIG_SRC="${MCP_CONFIG_SRC:-${PROJECT_DIR}/apps/claude-agent/.mcp.local.json}"
# Model: a ChatGPT-account plan rejects explicit API model ids, so in chatgpt mode default to
# empty (codex uses the account's own default model); API-key mode keeps o4-mini. An explicit
# CODEX_MODEL always wins in either mode.
if [ "${CODEX_AUTH_MODE}" = "chatgpt" ]; then
  export AGENT_MODEL="${CODEX_MODEL:-}"
else
  export AGENT_MODEL="${CODEX_MODEL:-o4-mini}"
fi
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/codex-agent}"
# CODEX_HOME is a DEDICATED h-managed dir (sibling of AGENT_BASE_DIR — the shared workspace's
# codex-home), so it must resolve AFTER AGENT_BASE_DIR is set. Host: <workspace>/codex-home;
# compose sets it explicitly to /workspace/codex-home.
export CODEX_HOME="${CODEX_HOME:-$(dirname "${AGENT_BASE_DIR}")/codex-home}"
export AGENT_APP_DIR="${APP_DIR}"
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/skills}"

cd "${PROJECT_DIR}"
node "${PROJECT_DIR}/scripts/check-tsc.mjs" --native-only || exit 1
bunx turbo build --filter=codex-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale codex-agent 8016 3516 36016 61017

exec dapr run \
  --app-id codex-agent \
  --app-port 8016 \
  --dapr-http-port 3516 \
  --dapr-grpc-port 36016 \
  --dapr-internal-grpc-port 61017 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8016 bun run src/index.ts
