# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# Workspace manifests for dependency resolution + layer caching
COPY pyproject.toml uv.lock ./
COPY packages/py/agent-server/pyproject.toml ./packages/py/agent-server/
COPY apps/dapr-claude-loop-agent/pyproject.toml ./apps/dapr-claude-loop-agent/

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package dapr-claude-loop-agent

# Workspace package + app source, then install the editable workspace packages
COPY packages/py/agent-server/ ./packages/py/agent-server/
COPY apps/dapr-claude-loop-agent/src/ ./apps/dapr-claude-loop-agent/src/

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package dapr-claude-loop-agent

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/apps/dapr-claude-loop-agent/src

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
