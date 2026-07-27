#!/usr/bin/env bash
# Generates k8s/secrets/app-secrets.yaml from .env.
# Run this once before `tilt up`, and re-run if .env changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
OUT_FILE="$PROJECT_DIR/k8s/secrets/app-secrets.yaml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — copy .env.example and fill in values" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

# GNU base64 wraps at 76 columns; a wrapped value splits across lines and makes the
# emitted YAML invalid. `tr -d '\n'` is the portable un-wrap (GNU has -w0, BSD does not).
b64() { printf '%s' "${1:-}" | base64 | tr -d '\n'; }

mkdir -p "$(dirname "$OUT_FILE")"

cat > "$OUT_FILE" <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: h-secrets
  namespace: default
type: Opaque
data:
  ANTHROPIC_API_KEY: "$(b64 "${ANTHROPIC_API_KEY:-}")"
  CLAUDE_CODE_OAUTH_TOKEN: "$(b64 "${CLAUDE_CODE_OAUTH_TOKEN:-}")"
  ANTHROPIC_BASE_URL: "$(b64 "${ANTHROPIC_BASE_URL:-}")"
  AGENT_MODEL: "$(b64 "${AGENT_MODEL:-claude-haiku-4-5}")"
  LLM_API_KEY: "$(b64 "${LLM_API_KEY:-}")"
  LLM_BASE_URL: "$(b64 "${LLM_BASE_URL:-}")"
  LITELLM_API_KEY: "$(b64 "${LLM_API_KEY:-}")"
  TESSL_TOKEN: "$(b64 "${TESSL_TOKEN:-}")"
  TESSL_API_KEY: "$(b64 "${TESSL_API_KEY:-}")"
  GH_TOKEN: "$(b64 "${GH_TOKEN:-}")"
  NOTION_API_KEY: "$(b64 "${NOTION_API_KEY:-}")"
EOF

echo "Written: $OUT_FILE"
