import logging

from agent_core import run_react_loop
from agent_core.llm.openai import OpenAIChatAdapter
from agent_core.workflows import open_workflow_tools

from domain.models import AgentResult

logger = logging.getLogger(__name__)


class WorkflowAgentRunner:
    """A thin wrapper over the shared ReAct loop (agent_core), specialised only by config:
    the workflow-mcp toolset + the orchestrator system prompt.

    The agent builds/looks-up a workflow for the task, saves it, runs it, waits for it to
    finish (via the await_workflow tool — now served by workflow-mcp itself), repairs and
    re-runs on failure, and returns the completed workflow's output. The loop mechanics and
    the await helper both live outside this service now.
    """

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        system_prompt: str,
        max_iterations: int,
        workflows_mcp_url: str,
    ) -> None:
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._system = system_prompt
        self._max_iterations = max_iterations
        self._mcp_url = workflows_mcp_url

    async def run(self, problem: str) -> AgentResult:
        # await_workflow is now one of the workflow-mcp tools, so it arrives in wt.tools —
        # no local schema/impl needed; dispatch routes every call to the MCP tool.
        adapter = OpenAIChatAdapter(
            api_key=self._api_key, base_url=self._base_url, model=self._model
        )
        messages: list = [
            {"role": "system", "content": self._system},
            {"role": "user", "content": problem},
        ]

        async with open_workflow_tools(self._mcp_url) as wt:

            async def dispatch(name: str, args: dict) -> str:
                if wt.handles(name):
                    return await wt.run(name, args)
                return f"Unknown tool: {name}"

            output, turns = await run_react_loop(
                adapter,
                messages,
                wt.tools,
                dispatch,
                max_iterations=self._max_iterations,
                label="workflow-agent",
            )
        return AgentResult(output=output, turns=turns)
