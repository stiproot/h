# syntax=docker/dockerfile:1
# Shared base for the uv:python in-process agents (dapr-agent, langgraph, workflow-agent,
# dapr-claude-loop, claude-managed). Bakes the BASELINE process-identity model
# (docs/plans/agent-process-identity.md): non-root service user only — no CLI drop, because these
# agents run their agentic loop in-process (no subprocess to drop). Agents `FROM h-agent-base-py`.
# Build before the agent images:
#   docker build -f docker/agent-base-py.Dockerfile -t h-agent-base-py .   (or: make agent-bases)
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# gosu drops the server (root -> AGENT_UID) in the entrypoint. No sudo/agent-cli — no CLI subprocess.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=10001
ARG AGENT_GID=10001
ENV AGENT_UID=$AGENT_UID AGENT_GID=$AGENT_GID HOME=/home/agent-svc
RUN groupadd -g "$AGENT_GID" agent && \
    useradd -u "$AGENT_UID" -g "$AGENT_GID" -m -d /home/agent-svc agent-svc
COPY docker/agent-entrypoint.sh /agent-entrypoint.sh
RUN chmod +x /agent-entrypoint.sh
ENTRYPOINT ["/agent-entrypoint.sh"]
