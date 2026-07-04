import logging
import uuid
from pathlib import Path

from agent_core import run_react_loop
from agent_core.llm.openai import OpenAIChatAdapter
from agent_server import AgentRequest, AgentResponse

from infrastructure.tools import TOOL_SCHEMAS, make_tool_fns

logger = logging.getLogger(__name__)


class DaprAgentRunner:
    """Outbound adapter: a thin wrapper over the shared ReAct loop (agent_core) driven by
    the OpenAIChatClient adapter. All this service owns is its config (model/prompt/tools)
    and the workspace-scoped tool implementations."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        system_prompt: str,
        max_turns: int,
    ) -> None:
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._system_prompt = system_prompt
        self._max_turns = max_turns

    async def run(self, request: AgentRequest, workspace: Path) -> AgentResponse:
        tool_fns = make_tool_fns(workspace)
        adapter = OpenAIChatAdapter(
            api_key=self._api_key, base_url=self._base_url, model=self._model
        )
        messages: list = [
            {"role": "system", "content": self._system_prompt},
            {"role": "user", "content": request.input},
        ]
        logger.info("dapr-agent | task: %s", request.input[:120])

        async def dispatch(name: str, args: dict) -> str:
            fn = tool_fns.get(name)
            if fn is None:
                return f"Unknown tool: {name}"
            return fn(**args)

        output, turns = await run_react_loop(
            adapter,
            messages,
            TOOL_SCHEMAS,
            dispatch,
            max_iterations=self._max_turns,
            label="dapr-agent",
        )
        return AgentResponse(
            output=output,
            session_id=str(uuid.uuid4()),
            model="dapr-agent",
            turns=turns,
            usage={"input": 0, "output": 0},
        )
