# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# workflow-agent is a uv workspace member; build against the root uv.lock (two-phase,
# like the other workspace agents). Workspace manifests first for layer caching.
COPY pyproject.toml uv.lock ./
COPY packages/py/agent-core/pyproject.toml ./packages/py/agent-core/
COPY apps/workflow-agent/pyproject.toml ./apps/workflow-agent/

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package workflow-agent

# Workspace package + app source, then install the editable workspace packages
COPY packages/py/agent-core/ ./packages/py/agent-core/
COPY apps/workflow-agent/src/ ./apps/workflow-agent/src/

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package workflow-agent

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/apps/workflow-agent/src

EXPOSE 8000

# --- process identity (docs/plans/agent-process-identity.md, baseline) ---
# In-process agent: no spawned CLI subprocess, so no SUB_AGENT_UID drop — the whole process runs
# non-root as AGENT_UID (its agentic loop runs at service privilege, a documented limitation of the
# in-process model). Still gets the non-root + AGENT_GID + entrypoint baseline like every agent.
ARG AGENT_UID=10001
ARG AGENT_GID=10001
ENV AGENT_UID=$AGENT_UID AGENT_GID=$AGENT_GID HOME=/home/agent-svc
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/* && \
    groupadd -g "$AGENT_GID" agent && \
    useradd -u "$AGENT_UID" -g "$AGENT_GID" -m -d /home/agent-svc agent-svc && \
    chown -R "$AGENT_UID:$AGENT_GID" /app /home/agent-svc
COPY docker/agent-entrypoint.sh /agent-entrypoint.sh
RUN chmod +x /agent-entrypoint.sh

ENTRYPOINT ["/agent-entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
