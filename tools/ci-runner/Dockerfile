# Self-hosted GitHub Actions runner for h.
#
# Why: GitHub bills hosted-runner minutes only, so self-hosted jobs keep running when the
# Actions spending limit is exhausted — and the h-builds-h loop must never stall on a
# billing cycle. Pattern lifted from trxy-v2's tools/ci-runner (validated there through a
# real billing lapse). See tools/ci-runner/README.md for the runbook.
#
# Base MUST track ubuntu-latest (24.04 noble): actions/cache keys are `${{ runner.os }}-…`
# = `Linux-…` on both runner types, so hosted and self-hosted runs share cache entries —
# a different glibc would poison restored native modules.
#
# myoung34/github-runner handles the runner lifecycle we would otherwise hand-roll:
# PAT → registration-token exchange, labels, graceful de-registration on SIGTERM.
FROM myoung34/github-runner:ubuntu-noble

# Single place to bump the toolchain. Keep these in sync with:
#   BUN_VERSION  -> .github/workflows/guards.yml `env.BUN_VERSION`
#   NODE_MAJOR   -> the scripts/*.mjs guards run under node; any supported major works
#   UV_VERSION   -> no repo pin exists; bump alongside the host's uv
#   HELM_VERSION -> h-cli chart tests render via helm; client-side templating only
ARG NODE_MAJOR=22
ARG BUN_VERSION=1.3.11
ARG UV_VERSION=0.11.26
ARG HELM_VERSION=v3.16.4

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# Base OS tooling. build-essential: bun/uv native module builds; make: the repo's
# Makefile IS the CI entrypoint for the Python half (make lint-py / make test-py).
RUN apt-get update && apt-get install -yq --no-install-recommends \
      ca-certificates curl wget gnupg git jq unzip zip xz-utils \
      file rsync openssh-client sudo build-essential make \
 && rm -rf /var/lib/apt/lists/*

# Node — the content guards are node scripts (scripts/check-*.mjs), run before/beside bun.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
 && apt-get install -yq nodejs \
 && rm -rf /var/lib/apt/lists/*

# Bun, pinned to guards.yml's BUN_VERSION. CI's oven-sh/setup-bun installs its own copy
# per the workflow pin; this image copy is the floor for anything running outside a job.
ENV BUN_INSTALL=/usr/local/bun
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && ln -s "${BUN_INSTALL}/bin/bun" /usr/local/bin/bun \
 && ln -s "${BUN_INSTALL}/bin/bun" /usr/local/bin/bunx

# uv — installs its own managed Python (>=3.12) on first sync; no apt python needed.
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" \
      | env UV_INSTALL_DIR=/usr/local/bin sh

# Helm — h-cli's chart-render and golden tests SKIP silently without it (the guards.yml
# comment documents the green-by-absence trap); the runner must always have it.
RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /tmp \
 && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
 && rm -rf /tmp/linux-amd64

# ImageOS is read by setup actions (cache paths); hosted ubuntu-24.04 sets ubuntu24.
# The tool-cache dir is a named volume so setup-bun/setup-uv downloads survive jobs.
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    ImageOS=ubuntu24
# Created here (not just declared) so a fresh named volume seeds with the right
# ownership. Jobs run as ROOT (myoung34 default); root ownership is correct, and the
# per-container bun cache also removes the cross-uid poisoned-cache class entirely
# (CLAUDE.md "tsc launcher no-op" gotcha) — nothing here shares the host's ~/.bun.
RUN mkdir -p /opt/hostedtoolcache /home/runner/bun-cache /home/runner/uv-cache

# Fail the IMAGE BUILD on a missing tool rather than a job at 2am.
RUN set -e; \
    for t in git curl jq unzip rsync bash make node npm bun uv helm; do \
      command -v "$t" >/dev/null || { echo "MISSING TOOL: $t"; exit 1; }; \
    done; \
    echo "--- toolchain ---"; \
    node --version; bun --version; uv --version; helm version --short
