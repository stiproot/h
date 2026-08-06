#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_DIR}/apps/claude-agent"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a; source "${PROJECT_DIR}/.env"; set +a
fi

# Auth: either a pay-as-you-go API key, or a Claude Max/Pro subscription token
# (generate once with `claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN). Exactly one
# is required. An empty ANTHROPIC_API_KEY is left unset so it can't shadow the token.
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  export ANTHROPIC_API_KEY
elif [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  unset ANTHROPIC_API_KEY || true
  export CLAUDE_CODE_OAUTH_TOKEN
else
  echo "Set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN for a Max/Pro plan (run: claude setup-token)" >&2
  exit 1
fi
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}"
export AGENT_MODEL="${AGENT_MODEL:-claude-haiku-4-5}"
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/claude-agent}"
export AGENT_APP_DIR="${APP_DIR}"
# Root-level h skills (harness skill source), reusable by any agent — delivered to the agent's
# ~/.claude/skills/ by a workflow setup step. Lives at the repo root, not inside an agent app.
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/skills}"
export TESSL_TOKEN="${TESSL_API_KEY:-}"
export GH_TOKEN="${GH_TOKEN:-}"
# Git transport strategy for /clone + /worktree (git-core GitAuth): "ssh" | "pat" (default).
export GIT_AUTH="${GIT_AUTH:-}"
export GIT_SSH_KEY_PATH="${GIT_SSH_KEY_PATH:-}"
export NOTION_API_KEY="${NOTION_API_KEY:-}"
export MCP_CONFIG_SRC="${AGENT_APP_DIR}/.mcp.host.json"

cd "${PROJECT_DIR}"
# Toolchain guard: fail loud if turbo/native bins are hollow (cross-uid-poisoned bun cache)
# instead of dying cryptically at `bunx turbo build`. See the `Toolchain guard` gotcha in CLAUDE.md.
node "${PROJECT_DIR}/scripts/check-tsc.mjs" --native-only || exit 1
bunx turbo build --filter=claude-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale claude-agent 8002 3502 36002 61002

exec dapr run \
  --app-id claude-agent \
  --app-port 8002 \
  --dapr-http-port 3502 \
  --dapr-grpc-port 36002 \
  --dapr-internal-grpc-port 61002 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/host" \
  --config "${PROJECT_DIR}/dapr/host/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8002 bun run src/index.ts
