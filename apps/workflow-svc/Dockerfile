# syntax=docker/dockerfile:1
FROM oven/bun:1-alpine AS base

RUN apk add --no-cache nodejs && \
    BUN_INSTALL=/usr/local bun install --global tessl

WORKDIR /app

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
COPY apps/workflow-svc/package.json ./apps/workflow-svc/
COPY apps/workflow-mcp/package.json ./apps/workflow-mcp/
COPY apps/dapr-mcp/package.json ./apps/dapr-mcp/
COPY apps/obs-mcp/package.json ./apps/obs-mcp/

RUN --mount=type=cache,id=bun-store,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY packages/js/core/ ./packages/js/core/
COPY packages/js/core-dapr/ ./packages/js/core-dapr/
COPY packages/js/telemetry/ ./packages/js/telemetry/
COPY apps/workflow-svc/ ./apps/workflow-svc/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=workflow-svc...

WORKDIR /app/apps/workflow-svc

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
