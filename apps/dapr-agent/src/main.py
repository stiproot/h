import logging
import os
from pathlib import Path

from agent_core import load_skill_instructions
from agent_server import WorkflowBabysitter, register_agent_routes, register_workflow_route
from fastapi import APIRouter, FastAPI

from infrastructure.dapr_agent_runner import DaprAgentRunner

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())

AGENT_BASE_DIR = Path(os.getenv("AGENT_BASE_DIR", "/workspace/dapr-agent"))
# Opt-in workflow orchestration: set WORKFLOWS_MCP_URL to let this agent construct/invoke/monitor
# workflows via workflow-mcp (needs H_SKILLS_DIR so it can load the orchestrator procedure).
WORKFLOWS_MCP_URL = os.getenv("WORKFLOWS_MCP_URL")

_SYSTEM_PROMPT = (
    "You are a workspace-scoped coding agent. "
    "All files and directories must be created relative to the current working directory. "
    "Never write to absolute paths outside it. "
    "Do not read from or reference files outside the current working directory."
)


def _system_prompt() -> str:
    base = os.getenv("AGENT_SYSTEM_PROMPT", _SYSTEM_PROMPT)
    if WORKFLOWS_MCP_URL:
        # Teach it the same procedure claude-agent / workflow-agent use, from the shared skill.
        base += "\n\nYou can also orchestrate workflows:\n\n" + load_skill_instructions(
            "workflow-orchestrator"
        )
    return base


_runner = DaprAgentRunner(
    model=os.getenv("AGENT_MODEL", "claude-haiku-4-5"),
    base_url=os.environ["ANTHROPIC_BASE_URL"],
    api_key=os.getenv("ANTHROPIC_API_KEY", ""),
    system_prompt=_system_prompt(),
    max_turns=int(os.getenv("AGENT_MAX_ITERATIONS", "20")),
    workflows_mcp_url=WORKFLOWS_MCP_URL,
)

app = FastAPI()

_router = APIRouter()
register_agent_routes(
    _router,
    _runner,
    lambda workflow_instance_id: AGENT_BASE_DIR / "workspaces" / workflow_instance_id,
    "dapr-agent",
)
# The standard workflow endpoint: submit-and-babysit (non-blocking) — makes this agent
# service a workflow entry point on the same contract as every other agent service.
register_workflow_route(_router, WorkflowBabysitter(agent_id="dapr-agent"))
app.include_router(_router)
