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
# ~/.codex means h runs never pollute the user's personal codex config (see the codex gotcha in CLAUDE.md).
export CODEX_AUTH_MODE="${CODEX_AUTH_MODE:-}"
# Self-detect ChatGPT-plan auth (trxy trial 1b finding, 2026-07-25): a headless launcher
# (up-host.sh, a cron, an agent session) rarely carries the interactive shell's exports, and a
# missing mode fails every codex run late and cryptically. If no API key and no explicit mode
# but a `codex login` credential exists, chatgpt mode is the only thing that can work — infer it.
if [ -z "$OPENAI_API_KEY" ] && [ -z "$CODEX_AUTH_MODE" ] && [ -f "$HOME/.codex/auth.json" ]; then
  export CODEX_AUTH_MODE=chatgpt
  echo "run-codex-agent: inferred CODEX_AUTH_MODE=chatgpt (~/.codex/auth.json present, no OPENAI_API_KEY)"
fi
# h's canonical MCP set (same servers claude-agent provisions); the runner translates it to codex TOML.
export MCP_CONFIG_SRC="${MCP_CONFIG_SRC:-${PROJECT_DIR}/apps/claude-agent/.mcp.host.json}"
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
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/.h/skills}"

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
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8016 bun run src/index.ts
