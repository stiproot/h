import logging
import os
from pathlib import Path

from agent_server import register_agent_routes
from fastapi import APIRouter, FastAPI

from infrastructure.dapr_agent_runner import DaprAgentRunner

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())

AGENT_BASE_DIR = Path(os.getenv("AGENT_BASE_DIR", "/workspace/dapr-agent"))

_SYSTEM_PROMPT = (
    "You are a workspace-scoped coding agent. "
    "All files and directories must be created relative to the current working directory. "
    "Never write to absolute paths outside it. "
    "Do not read from or reference files outside the current working directory."
)

_runner = DaprAgentRunner(
    model=os.getenv("AGENT_MODEL", "claude-haiku-4-5"),
    base_url=os.environ["ANTHROPIC_BASE_URL"],
    api_key=os.getenv("ANTHROPIC_API_KEY", ""),
    system_prompt=os.getenv("AGENT_SYSTEM_PROMPT", _SYSTEM_PROMPT),
    max_turns=int(os.getenv("AGENT_MAX_ITERATIONS", "20")),
)

app = FastAPI()

_router = APIRouter()
register_agent_routes(
    _router,
    _runner,
    lambda workflow_instance_id: AGENT_BASE_DIR / "workspaces" / workflow_instance_id,
    "dapr-agent",
)
app.include_router(_router)
