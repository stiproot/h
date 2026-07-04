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

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
