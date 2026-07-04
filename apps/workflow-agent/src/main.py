import logging
import os

from agent_core import load_skill_instructions
from fastapi import FastAPI

from infrastructure.statestore import StateStore
from infrastructure.workflow_agent_runner import WorkflowAgentRunner
from presentation.http.cron_router import create_router
from telemetry import init_tracing

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())

DAPR_HTTP_PORT = os.getenv("DAPR_HTTP_PORT", "3500")
STATESTORE_NAME = os.getenv("STATESTORE_NAME", "statestore")
WORKFLOW_MCP_URL = os.getenv("WORKFLOW_MCP_URL", "http://localhost:8005/sse")

# The orchestration knowledge is a shared h-skill (skills/workflow-orchestrator), so claude-agent
# and any other agent can orchestrate with the same procedure. workflow-agent reads the same
# SKILL.md as its system prompt (single source of truth), prefixed with its role. Set
# AGENT_SYSTEM_PROMPT to override without touching the skill; else H_SKILLS_DIR must point at the
# h skills root (wired by the run script / compose).
_ROLE = (
    "You are the workflow-agent: an orchestrator service. Turn the user's task into a workflow, "
    "run it, monitor it, self-heal on failure, and return the result. Follow this procedure:\n\n"
)


def _system_prompt() -> str:
    override = os.getenv("AGENT_SYSTEM_PROMPT")
    if override:
        return override
    return _ROLE + load_skill_instructions("workflow-orchestrator")


_runner = WorkflowAgentRunner(
    model=os.getenv("AGENT_MODEL", "claude-sonnet-4-6"),
    base_url=os.environ["ANTHROPIC_BASE_URL"],
    api_key=os.getenv("ANTHROPIC_API_KEY", ""),
    system_prompt=_system_prompt(),
    max_iterations=int(os.getenv("AGENT_MAX_ITERATIONS", "25")),
    workflows_mcp_url=WORKFLOW_MCP_URL,
)
_store = StateStore(f"http://localhost:{DAPR_HTTP_PORT}/v1.0/state/{STATESTORE_NAME}")

app = FastAPI()
init_tracing(app, "workflow-agent")
app.include_router(create_router(_runner, _store))
