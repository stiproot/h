# syntax=docker/dockerfile:1
FROM h-agent-base-bun

# pi coding-agent CLI (npm) + its node runtime. Common tools + the process-identity model come from
# the base image.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent

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
COPY apps/pi-agent/ ./apps/pi-agent/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=pi-agent...

WORKDIR /app/apps/pi-agent
# The non-root server (agent-svc) owns its built code; identity + entrypoint come from the base.
RUN chown -R agent-svc:agent /app

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
