# syntax=docker/dockerfile:1
FROM oven/bun:1-alpine AS base

RUN apk add --no-cache nodejs

WORKDIR /app

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

COPY packages/js/core/ ./packages/js/core/
COPY packages/js/telemetry/ ./packages/js/telemetry/
COPY apps/workflow-mcp/ ./apps/workflow-mcp/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=workflow-mcp...

WORKDIR /app/apps/workflow-mcp

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
