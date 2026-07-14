# syntax=docker/dockerfile:1
FROM h-agent-base-py

WORKDIR /app

COPY apps/claude-managed-agent/pyproject.toml apps/claude-managed-agent/uv.lock ./

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY apps/claude-managed-agent/src/ ./src/

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/src

EXPOSE 8000

# The non-root server (agent-svc) owns its code; identity + entrypoint come from the base.
RUN chown -R agent-svc:agent /app

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
