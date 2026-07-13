# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq git ca-certificates gosu sudo && \
    rm -rf /var/lib/apt/lists/* && \
    git config --system --add safe.directory '*' && \
    ARCH=$(uname -m) && case "$ARCH" in x86_64) OH_ARCH=x86_64 ;; aarch64|arm64) OH_ARCH=arm64 ;; *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; esac && \
    curl -fsSL "https://github.com/OpenHands/OpenHands-CLI/releases/latest/download/openhands-linux-${OH_ARCH}" \
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

# --- process identity (docs/plans/agent-process-identity.md) ---
# Non-root service (AGENT_UID) + a distinct dropped-CLI user (SUB_AGENT_UID), both in AGENT_GID for
# the shared workspace. High UIDs avoid oven/bun's `bun` user (1000). The root entrypoint chowns the
# workspace and drops to AGENT_UID; the sudoers rule lets the server drop the CLI to SUB_AGENT_UID.
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
