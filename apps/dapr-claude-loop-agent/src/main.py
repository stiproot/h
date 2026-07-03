import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from agent_server import register_agent_routes
from fastapi import APIRouter, FastAPI

from infrastructure.claude_loop_runner import ClaudeLoopRunner

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())

AGENT_BASE_DIR = Path(os.getenv("AGENT_BASE_DIR", "/workspace/dapr-claude-loop-agent"))

_DEFAULT_SYSTEM = (
    "You are a workspace-scoped coding agent. "
    "All files and directories must be created relative to the current working directory. "
    "Never write to absolute paths outside it. "
    "Do not read from or reference files outside the current working directory. "
    "Use your tools to search for a relevant tessl skill, install it, read it, "
    "and implement whatever the user asks. When you have finished, respond with a summary."
)

_runner = ClaudeLoopRunner(
    model=os.getenv("AGENT_MODEL", "claude-haiku-4-5"),
    system_prompt=os.getenv("AGENT_SYSTEM_PROMPT", _DEFAULT_SYSTEM),
    max_iterations=int(os.getenv("AGENT_MAX_ITERATIONS", "20")),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _runner.start()
    yield
    await _runner.shutdown()


app = FastAPI(lifespan=lifespan)

_router = APIRouter()
register_agent_routes(
    _router,
    _runner,
    lambda workflow_instance_id: AGENT_BASE_DIR / "workspaces" / workflow_instance_id,
    "dapr-claude-loop-agent",
)
app.include_router(_router)
