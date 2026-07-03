#!/bin/bash
set -euo pipefail

# Invoke the feature-request workflow: read a feature specification from a Markdown file, seed it as a
# plain-English task into the state store, then trigger the workflow-agent — which reasons it into an
# ephemeral workflow that worktrees the target repo, investigates the spec, and implements the change
# locally on that worktree (left as uncommitted working-tree changes).
#
# The spec is injected into the task with `jq --rawfile`, which JSON-escapes the file's content safely
# (multi-line Markdown with quotes/backslashes/`$` would break the dispatcher's `envsubst` path) — so
# this is a dedicated wrapper rather than a `payloads/<name>` config run through invoke-workflow-agent.sh.
#
# Usage: invoke-workflow-feature-request.sh <spec> [SLUG=<slug>]
#   <spec>      the feature request, in Markdown. Either a path to a .md file, or a bare name resolved
#               against scripts/payloads/domain/feature-requests/ (the gitignored home for these
#               specs) — with or without the .md suffix.
#   SLUG=...    optional branch/run slug; defaults to a sanitized form of the .md filename.
#
# Example:
#   invoke-workflow-feature-request.sh my-feature          # payloads/domain/feature-requests/my-feature.md
#   invoke-workflow-feature-request.sh ./specs/dark-mode.md               # branch feature/dark-mode
#   invoke-workflow-feature-request.sh dark-mode SLUG=ui-theme
#
# Prerequisites: the target repo pre-cloned into the shared workspace root
# (scripts/clone.sh); the task template at payloads/domain/feature-request-task.template.json
# (gitignored — see payloads/domain/README.md); claude-agent + workflow-agent running, GH_TOKEN in .env.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

AGENT_URL="${AGENT_URL:-http://localhost:8010}"          # workflow-agent app
DAPR_HTTP_PORT="${DAPR_HTTP_PORT:-3510}"                  # workflow-agent's Dapr sidecar
STATE_URL="http://localhost:${DAPR_HTTP_PORT}/v1.0/state/statestore"

[[ -f "${PROJECT_DIR}/.env" ]] && { set -a; source "${PROJECT_DIR}/.env"; set +a; }

FR_DIR="${SCRIPT_DIR}/payloads/domain/feature-requests"   # gitignored home for feature-request specs

# Resolve the spec arg: an existing path wins; otherwise try it as a bare name (with/without .md)
# under the feature-requests dir.
ARG="${1:-}"
SPEC_FILE=""
if [[ -n "$ARG" ]]; then
  for cand in "$ARG" "${FR_DIR}/${ARG}" "${FR_DIR}/${ARG}.md"; do
    [[ -f "$cand" ]] && { SPEC_FILE="$cand"; break; }
  done
fi
if [[ -z "$SPEC_FILE" ]]; then
  echo "Usage: $0 <spec> [SLUG=<slug>]"
  echo "  <spec> = a .md path, or a bare name under ${FR_DIR#"${PROJECT_DIR}/"}/"
  [[ -n "$ARG" ]] && echo "Could not resolve spec: ${ARG}"
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
for arg in "$@"; do
  case "$arg" in SLUG=*) SLUG="${arg#SLUG=}" ;; esac
done
if [[ -z "$SLUG" ]]; then
  base="$(basename "$SPEC_FILE")"; base="${base%.md}"
  SLUG="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
fi
[[ -z "$SLUG" ]] && { echo "Could not derive a slug from '${SPEC_FILE}' — pass SLUG=<slug>"; exit 1; }

TASK_FILE="${SCRIPT_DIR}/payloads/domain/feature-request-task.template.json"
[[ -f "$TASK_FILE" ]] || { echo "Missing ${TASK_FILE} — domain payloads are gitignored; see payloads/domain/README.md"; exit 1; }

# Render the task: substitute the slug, and splice the raw spec in at the __FEATURE_SPEC__ token.
# `--rawfile` loads the file as a JSON-safe string; `split` is a literal (non-regex) split, so the
# spec is concatenated verbatim with no regex/backref interpretation.
BODY="$(jq --arg slug "$SLUG" --rawfile spec "$SPEC_FILE" '
  .taskId  |= gsub("__SLUG__"; $slug)
  | .problem |= (gsub("__SLUG__"; $slug)
                 | split("__FEATURE_SPEC__")
                 | .[0] + $spec + (.[1] // ""))
' "$TASK_FILE")"

TASK_ID=$(jq -r '.taskId' <<<"$BODY")
echo "==> Feature request '${SPEC_FILE}' -> slug '${SLUG}' (branch feature/${SLUG})"
echo "==> Seeding task '${TASK_ID}' into the state store"

TASK_JSON=$(jq '{id:.taskId, status:"pending", problem:.problem, issueId:null, result:null, pluginFeedback:null}' <<<"$BODY")
curl -sf -X POST "$STATE_URL" -H "Content-Type: application/json" \
  -d "[{\"key\":\"task:${TASK_ID}\",\"value\":${TASK_JSON}}]" >/dev/null

# Append to the task index (read-modify-write).
INDEX=$(curl -s "${STATE_URL}/tasks:index"); [[ -z "$INDEX" || "$INDEX" == "null" ]] && INDEX="[]"
NEW_INDEX=$(jq --arg id "$TASK_ID" 'if index($id) then . else . + [$id] end' <<<"$INDEX")
curl -sf -X POST "$STATE_URL" -H "Content-Type: application/json" \
  -d "[{\"key\":\"tasks:index\",\"value\":${NEW_INDEX}}]" >/dev/null

echo "==> Triggering workflow-agent for '${TASK_ID}' (build → run → monitor)..."
curl -s --max-time 1800 -X POST "${AGENT_URL}/run" \
  -H "Content-Type: application/json" -d "{\"taskId\":\"${TASK_ID}\"}" | jq '.'
