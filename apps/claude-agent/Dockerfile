# syntax=docker/dockerfile:1
FROM h-agent-base-bun

# claude CLI + tessl. Common tools + the process-identity model (the claude CLI runs unprivileged as
# agent-cli via the base's drop) come from the base image.
RUN BUN_INSTALL=/usr/local bun install --global @anthropic-ai/claude-code tessl

# AWS CLI v2 — required by ops plugins that inspect infrastructure over aws ssm and for SSO credential
# resolution from a mounted host ~/.aws session.
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/awscliv2.zip /tmp/aws

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
COPY apps/claude-agent/ ./apps/claude-agent/

# h skills at the agent-neutral path H_SKILLS_DIR points at. Compose bind-mounts ./skills
# over this for live editing; k8s has no such mount, so the image must carry them —
# without it the setup step's `cp -r $H_SKILLS_DIR/.` has no source.
COPY skills/ /h-skills/

RUN --mount=type=cache,id=turbo-store,target=/app/.turbo \
    bunx turbo build --filter=claude-agent...

RUN chmod +x /app/apps/claude-agent/.claude/hooks/publish-event.sh

WORKDIR /app/apps/claude-agent
# The non-root server (agent-svc) owns its built code; identity + entrypoint come from the base.
RUN chown -R agent-svc:agent /app

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]
