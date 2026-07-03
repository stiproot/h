import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from agent_server import register_setup_route, register_subscribe_route
from fastapi import APIRouter, FastAPI

from infrastructure.langgraph_runner import LangGraphRunner
from infrastructure.preset_store import PresetStore
from presentation.http.run_router import register_langgraph_routes

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())

AGENT_BASE_DIR = Path(os.getenv("AGENT_BASE_DIR", "/workspace/langgraph-agent"))

_DEFAULT_SYSTEM = (
    "You are a workspace-scoped coding agent. "
    "All files and directories must be created relative to the current working directory. "
    "Never write to absolute paths outside it. "
    "Do not read from or reference files outside the current working directory. "
    "Use your tools to search for a relevant tessl skill, install it, read it, "
    "and implement whatever the user asks. When you have finished, respond with a summary."
)

_runner = LangGraphRunner(
    model=os.getenv("AGENT_MODEL", "claude-haiku-4-5"),
    system_prompt=os.getenv("AGENT_SYSTEM_PROMPT", _DEFAULT_SYSTEM),
    max_iterations=int(os.getenv("AGENT_MAX_ITERATIONS", "20")),
)
_presets = PresetStore(AGENT_BASE_DIR)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _runner.start()
    yield
    await _runner.shutdown()


app = FastAPI(lifespan=lifespan)


def _resolve_workspace_dir(workflow_instance_id: str) -> Path:
    return AGENT_BASE_DIR / "workspaces" / workflow_instance_id


_router = APIRouter()
register_langgraph_routes(_router, _runner, _resolve_workspace_dir, _presets)
register_setup_route(_router, _resolve_workspace_dir)
register_subscribe_route(_router)
app.include_router(_router)
