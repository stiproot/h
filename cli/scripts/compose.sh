#!/bin/bash
# docker compose with deterministic env: .env is the EXCLUSIVE source for every key it defines.
#
# Compose interpolates ${VAR} from the process environment FIRST and the project .env second,
# so a var exported in the user's shell profile (e.g. GH_TOKEN) silently shadows an edited .env
# on every up/recreate. This wrapper strips every key defined in .env from the environment
# before invoking compose, so the file always wins; env not named in .env (HOME, PATH, DOCKER_*)
# passes through untouched.
#
# Usage: cli/scripts/compose.sh <any docker compose args>
#   e.g. cli/scripts/compose.sh --profile claude-agent up -d --force-recreate
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

unset_flags=()
if [[ -f .env ]]; then
  while IFS= read -r key; do
    unset_flags+=(-u "$key")
  done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*' .env)
fi

# H_COMPOSE=1 satisfies the x-h-compose-guard sentinel in docker-compose.yml — raw
# `docker compose` (no wrapper) fails interpolation there with a pointer to this script.
exec env ${unset_flags[@]+"${unset_flags[@]}"} H_COMPOSE=1 docker compose "$@"
