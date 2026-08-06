# syntax=docker/dockerfile:1
FROM h-agent-base-bun

# pi coding-agent CLI (npm) + its node runtime. Common tools + the process-identity model come from
# the base image. pi requires Node >=22.19 (its bundled undici calls webidl APIs missing on Node 20 —
# Debian's `nodejs` is 20.x, which crashes the CLI on load), so install Node 22.x from NodeSource
# rather than the distro package.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    node --version && \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# pi writes its session state to ~/.pi/agent/sessions. The CLI runs dropped to agent-cli, which
# can't create ~/.pi under agent-svc's 0750 home (no group write) — and pi, unlike claude, has no
# setup step that would pre-create it. So provision ~/.pi group-writable + setgid here (the pi
# analogue of setup provisioning claude's ~/.claude); umask 002 keeps the session subdirs g+w.
RUN mkdir -p /home/agent-svc/.pi && chown agent-svc:agent /home/agent-svc/.pi && chmod 2775 /home/agent-svc/.pi

WORKDIR /app

# Workspace manifests for layer caching
COPY package.json bun.lock turbo.json ./
COPY packages/js/core/package.json ./packages/js/core/
COPY packages/js/core-dapr/package.json ./packages/js/core-dapr/
COPY packages/js/core-vercel/package.json ./packages/js/core-vercel/
COPY packages/js/agent-cli/package.json ./packages/js/agent-cli/
COPY packages/js/agent-server/package.json ./packages/js/agent-server/
COPY packages/js/git-core/package.json ./packages/js/git-core/
COPY packages/js/workflow-core/package.json ./packages/js/workflow-core/
COPY packages/js/run-ledger/package.json ./packages/js/run-ledger/
COPY packages/js/local-runtime/package.json ./packages/js/local-runtime/
COPY packages/js/logger/package.json ./packages/js/logger/
COPY packages/js/telemetry/package.json ./packages/js/telemetry/
COPY apps/claude-agent/package.json ./apps/claude-agent/
COPY apps/openhands-agent/package.json ./apps/openhands-agent/
COPY apps/pi-agent/package.json ./apps/pi-agent/
COPY apps/codex-agent/package.json ./apps/codex-agent/
COPY apps/workflow-svc/package.json ./apps/workflow-svc/
COPY apps/workflow-mcp/package.json ./apps/workflow-mcp/
COPY apps/dapr-mcp/package.json ./apps/dapr-mcp/
COPY apps/obs-mcp/package.json ./apps/obs-mcp/
COPY apps/kimi-agent/package.json ./apps/kimi-agent/
COPY apps/stub-agent/package.json ./apps/stub-agent/

RUN --mount=type=cache,id=bun-store,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Source
COPY packages/js/ ./packages/js/
COPY apps/pi-agent/ ./apps/pi-agent/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=pi-agent...

WORKDIR /app/apps/pi-agent
# The non-root server (agent-svc) owns its built code; identity + entrypoint come from the base.
RUN chown -R agent-svc:agent /app

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
