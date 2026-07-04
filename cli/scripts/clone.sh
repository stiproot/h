#!/bin/bash
set -euo pipefail

# Pre-clone the target repo into the shared workspace root, where worktree-cutting workflows'
# create-worktree steps cut per-run worktrees from it. A full clone (not shallow) so worktrees
# can branch.
#
# The clone's `origin` is normalised to the CANONICAL remote your tooling has on record.
#
# Usage: clone.sh
#   TARGET_REPO_URL=...            clone source (required — set it in .env).
#   TARGET_REPO_CANONICAL_URL=...  canonical remote that origin is normalised to afterwards,
#                                  regardless of how it was cloned (defaults to TARGET_REPO_URL).
#   TARGET_REPO_DIR=...            directory name under the workspace root (default "repo" —
#                                  the default sourceRepo of the /worktree route).
#   WORKSPACE_ROOT=...             shared workspace root on the host (default ../h-workspace)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

[[ -f "${PROJECT_DIR}/.env" ]] && { set -a; source "${PROJECT_DIR}/.env"; set +a; }

TARGET_REPO_URL="${TARGET_REPO_URL:?TARGET_REPO_URL is required — set it in .env}"
CANONICAL_REMOTE="${TARGET_REPO_CANONICAL_URL:-${TARGET_REPO_URL}}"
TARGET_REPO_DIR="${TARGET_REPO_DIR:-repo}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-${PROJECT_DIR}/../h-workspace}"
DEST="${WORKSPACE_ROOT}/${TARGET_REPO_DIR}"

# Point origin at the canonical remote (clean, no embedded token) so tessl resolves the recorded
# source. Auth for any fetch is handled separately via GH_TOKEN.
normalise_remote() {
  git -C "${DEST}" remote set-url origin "${CANONICAL_REMOTE}"
  echo "==> origin set to canonical ${CANONICAL_REMOTE}"
}

if [[ -d "${DEST}/.git" ]] && git -C "${DEST}" rev-parse HEAD >/dev/null 2>&1; then
  echo "==> Target repo already present at ${DEST}"
  normalise_remote
  exit 0
fi

mkdir -p "${WORKSPACE_ROOT}"
echo "==> Cloning ${TARGET_REPO_URL} -> ${DEST} (full clone)"
# Inject GH_TOKEN into the URL for the clone of a private https repo, mirroring git-core's in-process
# injection. The token is only used for the clone; origin is reset to the clean canonical URL after.
URL="${TARGET_REPO_URL}"
if [[ -n "${GH_TOKEN:-}" && "${URL}" == https://github.com/* ]]; then
  URL="https://x-access-token:${GH_TOKEN}@github.com/${URL#https://github.com/}"
fi
git clone "${URL}" "${DEST}"
normalise_remote
echo "==> Done. Worktree-cutting workflows will create worktrees under ${WORKSPACE_ROOT}/worktrees/"
