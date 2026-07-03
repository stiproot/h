# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

COPY apps/workflow-agent/pyproject.toml apps/workflow-agent/uv.lock ./

RUN --mount=type=cache,id=uv-store,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY apps/workflow-agent/src/ ./src/

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/src

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
