# syntax=docker/dockerfile:1
FROM h-agent-base-py

WORKDIR /app

# Workspace manifests for dependency resolution + layer caching
COPY pyproject.toml uv.lock ./
COPY packages/py/agent-server/pyproject.toml ./packages/py/agent-server/
COPY packages/py/agent-core/pyproject.toml ./packages/py/agent-core/
COPY apps/dapr-agent/pyproject.toml ./apps/dapr-agent/

RUN --mount=type=cache,id=uv-store,sharing=locked,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package dapr-agent

# Workspace packages + app source, then install the editable workspace packages
COPY packages/py/agent-server/ ./packages/py/agent-server/
COPY packages/py/agent-core/ ./packages/py/agent-core/
COPY apps/dapr-agent/src/ ./apps/dapr-agent/src/

RUN --mount=type=cache,id=uv-store,sharing=locked,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package dapr-agent

# tessl CLI (Node.js binary) is mounted at runtime via docker-compose volume:
#   - ${TESSL_BIN:-/usr/local/bin/tessl}:/usr/local/bin/tessl:ro
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/apps/dapr-agent/src

EXPOSE 8006

# The non-root server (agent-svc) owns its code; identity + entrypoint come from the base.
RUN chown -R agent-svc:agent /app

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8006"]
