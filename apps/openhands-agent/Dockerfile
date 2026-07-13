# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq git ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    git config --system --add safe.directory '*' && \
    curl -fsSL "https://github.com/OpenHands/OpenHands-CLI/releases/latest/download/openhands-linux-arm64" \
      -o /usr/local/bin/openhands && \
    chmod 755 /usr/local/bin/openhands && \
    BUN_INSTALL=/usr/local bun install --global tessl

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
COPY apps/workflow-svc/package.json ./apps/workflow-svc/
COPY apps/workflow-mcp/package.json ./apps/workflow-mcp/
COPY apps/dapr-mcp/package.json ./apps/dapr-mcp/
COPY apps/obs-mcp/package.json ./apps/obs-mcp/

RUN --mount=type=cache,id=bun-store,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Source
COPY packages/js/ ./packages/js/
COPY apps/openhands-agent/ ./apps/openhands-agent/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=openhands-agent...

WORKDIR /app/apps/openhands-agent

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
