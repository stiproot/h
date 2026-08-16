# syntax=docker/dockerfile:1
FROM h-agent-base-bun

# claude CLI — the kimi agent runs claude against Moonshot's Anthropic-compatible endpoint.
RUN BUN_INSTALL=/usr/local bun install --global @anthropic-ai/claude-code

WORKDIR /app

# Workspace manifests for layer caching
COPY package.json bun.lock turbo.json ./
COPY packages/js/core/package.json ./packages/js/core/
COPY packages/js/engine-core/package.json ./packages/js/engine-core/
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
COPY apps/kimi-agent/package.json ./apps/kimi-agent/
COPY apps/workflow-svc/package.json ./apps/workflow-svc/
COPY apps/workflow-mcp/package.json ./apps/workflow-mcp/
COPY apps/dapr-mcp/package.json ./apps/dapr-mcp/
COPY apps/obs-mcp/package.json ./apps/obs-mcp/
COPY apps/stub-agent/package.json ./apps/stub-agent/

RUN --mount=type=cache,id=bun-store,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Source
COPY packages/js/ ./packages/js/
COPY apps/kimi-agent/ ./apps/kimi-agent/

# h skills at the agent-neutral path H_SKILLS_DIR points at.
COPY skills/ /h-skills/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=kimi-agent...

WORKDIR /app/apps/kimi-agent
RUN chown -R agent-svc:agent /app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8000/dapr/subscribe

CMD ["bun", "run", "src/index.ts"]
