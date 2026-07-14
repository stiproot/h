# syntax=docker/dockerfile:1
FROM h-agent-base-py

WORKDIR /app

# Workspace manifests for dependency resolution + layer caching
COPY pyproject.toml uv.lock ./
COPY packages/py/agent-server/pyproject.toml ./packages/py/agent-server/
COPY apps/langgraph-agent/pyproject.toml ./apps/langgraph-agent/

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package langgraph-agent

# Workspace package + app source, then install the editable workspace packages
COPY packages/py/agent-server/ ./packages/py/agent-server/
COPY apps/langgraph-agent/src/ ./apps/langgraph-agent/src/

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package langgraph-agent

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/apps/langgraph-agent/src

EXPOSE 8000

# The non-root server (agent-svc) owns its code; identity + entrypoint come from the base.
RUN chown -R agent-svc:agent /app

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
