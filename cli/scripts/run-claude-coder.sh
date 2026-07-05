#!/bin/bash
set -euo pipefail

# claude-coder — the STRIPPED claude-agent instance for the h-builds-h loop
# (docs/plans/h-builds-h.md): it executes feature runs whose specs originate from untrusted
# issue text, so its MCP surface is the hosted `github` server ONLY (.mcp.coder.json — no
# workflows, no dapr, no obs, no notion) and its env carries no Linear/Notion secrets.
# Same app code and image as claude-agent; only configuration differs.

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
export AGENT_BASE_DIR="${AGENT_BASE_DIR:-${PROJECT_DIR}/../h-workspace/claude-coder}"
export AGENT_APP_DIR="${APP_DIR}"
export H_SKILLS_DIR="${H_SKILLS_DIR:-${PROJECT_DIR}/skills}"
# The coder's GitHub credential: a fine-grained PAT with contents:write + pull_requests:write
# + issues:read ONLY (it must not be able to file or edit issues). Falls back to GH_TOKEN for
# owner-repo trials where one identity does everything.
export GH_TOKEN="${GH_CODER_TOKEN:-${GH_TOKEN:-}}"
# Git transport strategy for /clone + /worktree (git-core GitAuth): "ssh" pushes/fetches over
# an ssh remote (GIT_SSH_KEY_PATH names a key; empty = ambient ssh config/agent), default pat.
export GIT_AUTH="${GIT_AUTH:-}"
export GIT_SSH_KEY_PATH="${GIT_SSH_KEY_PATH:-}"
# github MCP only — the agent that executes untrusted specs gets no control-plane tools.
export MCP_CONFIG_SRC="${APP_DIR}/.mcp.coder.json"

cd "${PROJECT_DIR}"
bunx turbo build --filter=claude-agent

cd "${APP_DIR}"

source "${SCRIPT_DIR}/_lib.sh"
stop_stale claude-coder 8014 3514 36014 61015

exec dapr run \
  --app-id claude-coder \
  --app-port 8014 \
  --dapr-http-port 3514 \
  --dapr-grpc-port 36014 \
  --dapr-internal-grpc-port 61015 \
  --placement-host-address localhost:50006 \
  --scheduler-host-address localhost:50007 \
  --resources-path "${PROJECT_DIR}/dapr/local" \
  --config "${PROJECT_DIR}/dapr/local/appconfig.yaml" \
  --log-level info \
  -- env APP_PORT=8014 bun run src/index.ts
