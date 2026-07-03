#!/bin/bash
# Fire-and-forget: publish Claude lifecycle event to Dapr pub/sub.
# $1 = hook type (PreToolUse | PostToolUse | Stop)
INPUT=$(cat)
PAYLOAD=$(printf '%s' "$INPUT" | jq \
  --arg hook "${1:-unknown}" \
  --arg wf "${WORKFLOW_INSTANCE_ID:-}" \
  '. + {hook: $hook, workflow_instance_id: $wf}')
curl -sf -X POST \
  "http://localhost:${DAPR_HTTP_PORT:-3500}/v1.0/publish/pubsub/claude-events" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" &
