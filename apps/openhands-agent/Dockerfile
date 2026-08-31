# syntax=docker/dockerfile:1
FROM h-agent-base-bun

# OpenHands CLI (arch-aware release asset) + tessl. Common tools + the process-identity model
# (users/group/sudoers/entrypoint) come from the base image.
RUN ARCH=$(uname -m) && case "$ARCH" in x86_64) OH_ARCH=x86_64 ;; aarch64|arm64) OH_ARCH=arm64 ;; *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; esac && \
    curl -fsSL "https://github.com/OpenHands/OpenHands-CLI/releases/latest/download/openhands-linux-${OH_ARCH}" \
      -o /usr/local/bin/openhands && \
    chmod 755 /usr/local/bin/openhands && \
    BUN_INSTALL=/usr/local bun install --global tessl

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
COPY apps/openhands-agent/ ./apps/openhands-agent/

# h skills at the agent-neutral path H_SKILLS_DIR points at. Compose bind-mounts ./.h/skills
# over this for live editing; k8s has no such mount, so the image must carry them —
# without it the setup step's `cp -r $H_SKILLS_DIR/.` has no source.
COPY .h/skills/ /h-skills/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=openhands-agent...

WORKDIR /app/apps/openhands-agent
# The non-root server (agent-svc) owns its built code; identity + entrypoint come from the base.
RUN chown -R agent-svc:agent /app

# The OpenHands CLI writes state under $HOME/.openhands, but it runs DROPPED as agent-cli
# (SUB_AGENT_UID) with HOME preserved as /home/agent-svc — which the base image leaves 0750
# owned by agent-svc, so the CLI cannot create the directory itself and dies with
# "PermissionError: '/home/agent-svc/.openhands'". The base solves the same problem for
# ~/.claude by keeping it group-writable; do the equivalent here. setgid so anything the CLI
# writes stays in the shared `agent` group and the server can still read it.
RUN install -d -o agent-svc -g agent -m 2770 /home/agent-svc/.openhands

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
