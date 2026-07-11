#!/bin/bash
set -euo pipefail

# Invoke the feature-request workflow via the CHART strategy: render the workflow definition from
# cli/charts/workflows/templates/feature.yaml with helm (deterministic construction), seed a task
# that carries the rendered definition, and trigger the workflow-agent — whose job narrows to
# run + monitor + self-heal instead of constructing the steps itself.
#
# This co-exists with invoke-workflow-feature-request.sh (the jq/task-template strategy, where the
# workflow-agent reasons the steps into existence). Same spec resolution, same slug rules, same
# seeding/trigger plumbing — only the construction strategy differs.
#
# Rendered YAML is the canonical artifact; it is converted to JSON as a final processing step at
# the wire boundary only (see cli/scripts/_render.sh).
#
# Usage: invoke-workflow-feature-helm.sh <spec> [SLUG=<slug>] [--render-only]
#   <spec>          the feature request, in Markdown. Either a path to a .md file, or a bare name
#                   resolved against cli/scripts/payloads/domain/feature-requests/ (with or
#                   without the .md suffix).
#   SLUG=...        optional branch/run slug; defaults to a sanitized form of the .md filename.
#   --render-only   print the rendered workflow definition (YAML) and exit — no seeding, no run.
#
# feature never opens a PR: the run leaves uncommitted working-tree changes. To take a feature to a
# PR, compose it explicitly — `h template compose feature create-pr` (there is no --pr flag).
#
# Org-specific defaults (e.g. feature.clonePath, model ids) go in the gitignored
# cli/charts/workflows/values.local.yaml, merged automatically by render_workflow.
#
# Prerequisites: helm on PATH; the target repo pre-cloned into the shared workspace root
# (cli/scripts/clone.sh); claude-agent + workflow-agent running; GH_TOKEN in .env if private.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

AGENT_URL="${AGENT_URL:-http://localhost:8010}"          # workflow-agent app
DAPR_HTTP_PORT="${DAPR_HTTP_PORT:-3510}"                  # workflow-agent's Dapr sidecar
STATE_URL="http://localhost:${DAPR_HTTP_PORT}/v1.0/state/statestore"

[[ -f "${PROJECT_DIR}/.env" ]] && { set -a; source "${PROJECT_DIR}/.env"; set +a; }

source "${SCRIPT_DIR}/_render.sh"

FR_DIR="${SCRIPT_DIR}/payloads/domain/feature-requests"   # gitignored home for feature-request specs

# Resolve the spec arg: an existing path wins; otherwise try it as a bare name (with/without .md)
# under the feature-requests dir.
ARG="${1:-}"
SPEC_FILE=""
if [[ -n "$ARG" && "$ARG" != --* ]]; then
  for cand in "$ARG" "${FR_DIR}/${ARG}" "${FR_DIR}/${ARG}.md"; do
    [[ -f "$cand" ]] && { SPEC_FILE="$cand"; break; }
  done
fi
if [[ -z "$SPEC_FILE" ]]; then
  echo "Usage: $0 <spec> [SLUG=<slug>] [--render-only]"
  echo "  <spec> = a .md path, or a bare name under ${FR_DIR#"${PROJECT_DIR}/"}/"
  [[ -n "$ARG" && "$ARG" != --* ]] && echo "Could not resolve spec: ${ARG}"
  if [[ -d "$FR_DIR" ]]; then
    echo "Available feature requests:"
    ls "$FR_DIR"/*.md 2>/dev/null | sed 's#.*/##; s/\.md$//' | sed 's/^/  - /'
  fi
  exit 1
fi
shift

# Slug: explicit SLUG=... wins; otherwise derive from the .md filename. Sanitize to a git-branch-safe
# token (lowercase, runs of non-alphanumerics collapsed to '-', trimmed).
SLUG=""
RENDER_ONLY=0
for arg in "$@"; do
  case "$arg" in
    SLUG=*) SLUG="${arg#SLUG=}" ;;
    --render-only) RENDER_ONLY=1 ;;
  esac
done
if [[ -z "$SLUG" ]]; then
  base="$(basename "$SPEC_FILE")"; base="${base%.md}"
  SLUG="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
fi
[[ -z "$SLUG" ]] && { echo "Could not derive a slug from '${SPEC_FILE}' — pass SLUG=<slug>"; exit 1; }

# Render the workflow definition from the chart. YAML is the artifact of record here.
DEF_YAML="$(render_workflow feature --set "feature.slug=${SLUG}" --set-file "feature.spec=${SPEC_FILE}")"

if [[ $RENDER_ONLY -eq 1 ]]; then
  printf '%s\n' "$DEF_YAML"
  exit 0
fi

# Final processing step: today's wire format (workflow-mcp run_workflow) is JSON.
DEF_JSON="$(printf '%s\n' "$DEF_YAML" | yaml_to_json)"

TASK_ID="feature-helm-${SLUG}"
echo "==> Feature request '${SPEC_FILE}' -> slug '${SLUG}' (branch feature/${SLUG}, chart-rendered)"
echo "==> Seeding task '${TASK_ID}' into the state store"

# The task carries the pre-built definition; the workflow-agent runs it verbatim and monitors.
TASK_JSON=$(jq -n --arg id "$TASK_ID" --arg def "$DEF_JSON" '{
  id: $id,
  status: "pending",
  problem: ("Run the pre-built workflow definition below EXACTLY as provided — do not add, remove, reorder, or rewrite steps, and do not save_workflow it. Call run_workflow with the instanceId and steps from the JSON under ===WORKFLOW DEFINITION===, then await_workflow on the returned instanceId (on TIMEOUT, call await_workflow again with the SAME instanceId). When COMPLETED, return the implement step'\''s output verbatim.\n\n===WORKFLOW DEFINITION===\n" + $def),
  issueId: null,
  result: null,
  pluginFeedback: null
}')
curl -sf -X POST "$STATE_URL" -H "Content-Type: application/json" \
  -d "[{\"key\":\"task:${TASK_ID}\",\"value\":${TASK_JSON}}]" >/dev/null

# Append to the task index (read-modify-write).
INDEX=$(curl -s "${STATE_URL}/tasks:index"); [[ -z "$INDEX" || "$INDEX" == "null" ]] && INDEX="[]"
NEW_INDEX=$(jq --arg id "$TASK_ID" 'if index($id) then . else . + [$id] end' <<<"$INDEX")
curl -sf -X POST "$STATE_URL" -H "Content-Type: application/json" \
  -d "[{\"key\":\"tasks:index\",\"value\":${NEW_INDEX}}]" >/dev/null

echo "==> Triggering workflow-agent for '${TASK_ID}' (run → monitor)..."
curl -s --max-time 1800 -X POST "${AGENT_URL}/run" \
  -H "Content-Type: application/json" -d "{\"taskId\":\"${TASK_ID}\"}" | jq '.'
