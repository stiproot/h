#!/usr/bin/env bash
# Toggle h's CI fleet between GitHub-hosted and the self-hosted runner.
#
#   tools/ci-runner/toggle.sh on       # start + register the runner, point workflows at it
#   tools/ci-runner/toggle.sh off      # point workflows back at hosted, stop + de-register
#   tools/ci-runner/toggle.sh status   # visibility, RUNNER_LABEL, registered runners, container
#
# No token lives in this repo: everything authenticates with the shell's exported GH_TOKEN
# (PAT with Administration:read+write on the repo — the same requirement as compose.yml).
#
# SAFETY GATE: `on` REFUSES while the repo is PUBLIC. A fork of a public repo can open a PR
# whose `pull_request` job runs the FORK'S code on this runner — on the dev box. That is why
# the runner was unlinked before the repo went public; re-attach only after making the repo
# private again (or pass --force-public and own the risk, with fork-PR approval locked down
# in Settings → Actions to "require approval for all outside collaborators").
set -euo pipefail

REPO="stiproot/h"
LABEL="h-dev"
API="https://api.github.com/repos/${REPO}"
COMPOSE=(docker compose -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/compose.yml")

[ -n "${GH_TOKEN:-}" ] || { echo "ERROR: export GH_TOKEN (PAT with Administration RW on ${REPO}) first" >&2; exit 1; }

gh_api() { # METHOD PATH [JSON_BODY] — prints body, returns curl's exit; HTTP status on fd 3 via _STATUS
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -w '\n%{http_code}' -X "$method" -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" "${API}${path}")
  [ -n "$body" ] && args+=(-d "$body")
  local out; out="$(curl "${args[@]}")"
  _STATUS="${out##*$'\n'}"
  printf '%s' "${out%$'\n'*}"
}

visibility() { gh_api GET "" | python3 -c "import json,sys; print(json.load(sys.stdin)['visibility'])"; }

runners() {
  gh_api GET "/actions/runners" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['total_count'])
for r in d['runners']:
    print(f\"  {r['id']}  {r['name']}  {r['status']}  {','.join(l['name'] for l in r['labels'])}\")"
}

runner_label() {
  gh_api GET "/actions/variables/RUNNER_LABEL" >/dev/null || true
  if [ "$_STATUS" = "200" ]; then
    gh_api GET "/actions/variables/RUNNER_LABEL" | python3 -c "import json,sys; print(json.load(sys.stdin)['value'])"
  else
    echo "(unset — workflows run on ubuntu-latest)"
  fi
}

cmd_status() {
  echo "repo:          ${REPO} ($(visibility))"
  echo "RUNNER_LABEL:  $(runner_label)"
  echo "registered runners:"
  runners | sed '1s/^/  count: /'
  echo "container:"
  docker ps -a --filter name=h-runner-1 --format '  {{.Names}}  {{.Status}}' || true
}

cmd_on() {
  local force="${1:-}"
  local vis; vis="$(visibility)"
  if [ "$vis" != "private" ] && [ "$force" != "--force-public" ]; then
    echo "REFUSED: ${REPO} is ${vis} — fork PRs would run untrusted code on this runner." >&2
    echo "Make the repo private first, or re-run with --force-public (see header warning)." >&2
    exit 1
  fi
  [ "$vis" != "private" ] && echo "WARNING: attaching a self-hosted runner to a ${vis} repo — fork-PR code can reach this machine." >&2

  echo "starting runner container…"
  "${COMPOSE[@]}" up -d runner
  echo -n "waiting for registration"
  for _ in $(seq 1 30); do
    if runners | tail -n +2 | grep -q "h-runner-1.*online"; then echo " — online"; break; fi
    echo -n "."; sleep 2
  done
  runners | tail -n +2 | grep -q "h-runner-1.*online" || { echo; echo "ERROR: runner never came online — docker logs h-runner-1" >&2; exit 1; }

  # Point the workflows here LAST, so no job queues for a label with no live runner.
  gh_api GET "/actions/variables/RUNNER_LABEL" >/dev/null || true
  if [ "$_STATUS" = "200" ]; then
    gh_api PATCH "/actions/variables/RUNNER_LABEL" "{\"name\":\"RUNNER_LABEL\",\"value\":\"${LABEL}\"}" >/dev/null
  else
    gh_api POST "/actions/variables" "{\"name\":\"RUNNER_LABEL\",\"value\":\"${LABEL}\"}" >/dev/null
  fi
  echo "RUNNER_LABEL=${LABEL} — fleet is SELF-HOSTED."
}

cmd_off() {
  # Point workflows back at hosted FIRST, so nothing new lands on the runner while it drains.
  gh_api DELETE "/actions/variables/RUNNER_LABEL" >/dev/null || true
  case "$_STATUS" in 204|404) ;; *) echo "ERROR: variable delete returned $_STATUS" >&2; exit 1;; esac
  echo "RUNNER_LABEL deleted — workflows fall back to ubuntu-latest."

  echo "stopping runner container (de-registers on SIGTERM)…"
  "${COMPOSE[@]}" stop runner || true
  "${COMPOSE[@]}" down || true

  # Verify nothing stays registered; force-remove any stale entry (the state GitHub's
  # public-repo warning keys on is THIS list, not the container).
  local stale
  stale="$(gh_api GET "/actions/runners" | python3 -c "
import json, sys
for r in json.load(sys.stdin)['runners']:
    print(r['id'])")"
  for id in $stale; do
    echo "force-removing stale runner registration $id"
    gh_api DELETE "/actions/runners/${id}" >/dev/null || true
  done
  echo "registered runners now: $(runners | head -1) — fleet is GITHUB-HOSTED."
}

case "${1:-}" in
  on) cmd_on "${2:-}" ;;
  off) cmd_off ;;
  status) cmd_status ;;
  *) echo "usage: $0 on [--force-public] | off | status" >&2; exit 2 ;;
esac
