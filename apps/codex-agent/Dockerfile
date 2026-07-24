# syntax=docker/dockerfile:1
FROM h-agent-base-bun

# Codex CLI requires Node.js. Install Node 22.x from NodeSource (Debian's nodejs is 20.x,
# which lacks some APIs Codex depends on) then install the Codex CLI globally.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    node --version && \
    npm install -g --ignore-scripts @openai/codex

WORKDIR /app

# Workspace manifests for layer caching
COPY package.json bun.lock turbo.json ./
COPY packages/js/core/package.json ./packages/js/core/
COPY packages/js/core-dapr/package.json ./packages/js/core-dapr/
COPY packages/js/core-vercel/package.json ./packages/js/core-vercel/
COPY packages/js/agent-cli/package.json ./packages/js/agent-cli/
COPY packages/js/agent-server/package.json ./packages/js/agent-server/
COPY packages/js/git-core/package.json ./packages/js/git-core/
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

RUN --mount=type=cache,id=bun-store,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Source
COPY packages/js/ ./packages/js/
COPY apps/codex-agent/ ./apps/codex-agent/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=codex-agent...

WORKDIR /app/apps/codex-agent
RUN chown -R agent-svc:agent /app

# Container-private CODEX_HOME, ISOLATED from the host-shared workspace (issue #59): codex's
# app-server writes a SQLite state DB into CODEX_HOME, and a CODEX_HOME shared with host runs gets
# polluted by cross-uid state files (host uid writes them 0644 → the container user can't write →
# "readonly database" → fatal). A container-internal dir is only ever written by the container's
# own users. setgid + group-writable so BOTH the runner (agent-svc) and the dropped codex CLI
# (agent-cli, same 'agent' group) can use it; the runner seeds auth.json in from a read-only mount.
RUN mkdir -p /codex-home && chown agent-svc:agent /codex-home && chmod 2770 /codex-home

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
