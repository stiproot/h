import logging
import uuid
from pathlib import Path

from agent_core import run_react_loop
from agent_core.llm.openai import OpenAIChatAdapter
from agent_core.workflows import WorkflowTools, open_workflow_tools
from agent_server import AgentRequest, AgentResponse

from infrastructure.tools import TOOL_SCHEMAS, make_tool_fns

logger = logging.getLogger(__name__)


class DaprAgentRunner:
    """Outbound adapter: a thin wrapper over the shared ReAct loop (agent_core). Owns only its
    config (model/prompt/tools) and the workspace-scoped tool implementations.

    When a workflows_mcp_url is configured (opt-in), it also connects to workflow-mcp and merges
    the workflow toolset in, so the agent can construct/invoke/monitor workflows alongside its
    local tools — the same machinery workflow-agent uses."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        system_prompt: str,
        max_turns: int,
        workflows_mcp_url: str | None = None,
    ) -> None:
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._system_prompt = system_prompt
        self._max_turns = max_turns
        self._workflows_mcp_url = workflows_mcp_url

    async def run(self, request: AgentRequest, workspace: Path) -> AgentResponse:
        # An empty cwd falls back to workspace, never Path("").
        cwd = Path(request.cwd) if request.cwd else workspace
        tool_fns = make_tool_fns(cwd)
        effective_model = request.model or self._model
        adapter = OpenAIChatAdapter(
            api_key=self._api_key, base_url=self._base_url, model=effective_model
        )
        messages: list = [
            {"role": "system", "content": self._system_prompt},
            {"role": "user", "content": request.input},
        ]
        logger.info("dapr-agent | task: %s", request.input[:120])

        if self._workflows_mcp_url:
            async with open_workflow_tools(self._workflows_mcp_url) as wt:
                output, turns = await self._loop(adapter, messages, tool_fns, wt)
        else:
            output, turns = await self._loop(adapter, messages, tool_fns, None)

        return AgentResponse(
            output=output,
            session_id=str(uuid.uuid4()),
            model=effective_model,
            turns=turns,
            usage={"input": 0, "output": 0},
        )

    async def _loop(
        self,
        adapter: OpenAIChatAdapter,
        messages: list,
        tool_fns: dict,
        wt: WorkflowTools | None,
    ) -> tuple[str, int]:
        tools = [*TOOL_SCHEMAS, *(wt.tools if wt else [])]

        async def dispatch(name: str, args: dict) -> str:
            if wt is not None and wt.handles(name):
                return await wt.run(name, args)
            fn = tool_fns.get(name)
            if fn is None:
                return f"Unknown tool: {name}"
            return fn(**args)

        return await run_react_loop(
            adapter, messages, tools, dispatch, max_iterations=self._max_turns, label="dapr-agent"
        )
