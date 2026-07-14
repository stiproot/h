# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq git ca-certificates nodejs npm gosu sudo && \
    rm -rf /var/lib/apt/lists/* && \
    git config --system --add safe.directory '*' && \
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

# --- process identity (docs/plans/agent-process-identity.md) ---
# Non-root service (AGENT_UID) + dropped-CLI user (SUB_AGENT_UID), both in AGENT_GID. COMMON UIDs
# across all agents (shared .runs/worktrees/clone). High UIDs dodge oven/bun's `bun` (1000). The root
# entrypoint chowns the workspace + drops to AGENT_UID; the sudoers rule drops the CLI to SUB_AGENT_UID.
ARG AGENT_UID=10001
ARG SUB_AGENT_UID=10002
ARG AGENT_GID=10001
ENV AGENT_UID=$AGENT_UID AGENT_GID=$AGENT_GID SUB_AGENT_UID=$SUB_AGENT_UID HOME=/home/agent-svc
RUN groupadd -g "$AGENT_GID" agent && \
    useradd -u "$AGENT_UID" -g "$AGENT_GID" -m -d /home/agent-svc agent-svc && \
    useradd -u "$SUB_AGENT_UID" -g "$AGENT_GID" -m -d /home/agent-cli agent-cli && \
    echo 'agent-svc ALL=(agent-cli) NOPASSWD:SETENV: ALL' > /etc/sudoers.d/agent && \
    chmod 0440 /etc/sudoers.d/agent && \
    chown -R "$AGENT_UID:$AGENT_GID" /app /home/agent-svc
COPY docker/agent-entrypoint.sh /agent-entrypoint.sh
RUN chmod +x /agent-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/agent-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
