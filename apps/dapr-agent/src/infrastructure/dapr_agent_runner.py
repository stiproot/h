import json
import logging
import uuid
from pathlib import Path

from agent_server import AgentRequest, AgentResponse
from dapr_agents import OpenAIChatClient

from infrastructure.tools import TOOL_SCHEMAS, make_tool_fns

logger = logging.getLogger(__name__)


class DaprAgentRunner:
    """Outbound adapter: runs a ReAct tool-use loop via dapr_agents.OpenAIChatClient
    (OpenAI wire protocol) pointed at the LiteLLM proxy."""

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
        output, turns = self._run_react_loop(request.input, workspace)
        return AgentResponse(
            output=output,
            session_id=str(uuid.uuid4()),
            model="dapr-agent",
            turns=turns,
            usage={"input": 0, "output": 0},
        )

    def _run_react_loop(self, task: str, cwd: Path) -> tuple[str, int]:
        tool_fns = make_tool_fns(cwd)
        client = OpenAIChatClient(
            api_key=self._api_key,
            base_url=self._base_url,
            model=self._model,
        )

        messages: list = [
            {"role": "system", "content": self._system_prompt},
            {"role": "user", "content": task},
        ]

        logger.info("dapr-agent | task: %s", task[:120])

        for turn in range(1, self._max_turns + 1):
            logger.info("dapr-agent | turn %d – calling LLM", turn)
            response = client.generate(messages=messages, tools=TOOL_SCHEMAS)
            msg = response.get_message()

            tool_calls = msg.get_tool_calls() if hasattr(msg, "get_tool_calls") else None

            if not tool_calls:
                content = msg.content or ""
                logger.info("dapr-agent | turn %d – final answer (%d chars)", turn, len(content))
                return content, turn

            logger.info("dapr-agent | turn %d – %d tool call(s)", turn, len(tool_calls))
            messages.append(msg)

            for tc in tool_calls:
                args_preview = json.dumps(tc.function.arguments_dict)[:120]
                logger.info("dapr-agent |   -> %s(%s)", tc.function.name, args_preview)
                fn = tool_fns.get(tc.function.name)
                if fn is None:
                    result = f"Unknown tool: {tc.function.name}"
                else:
                    result = fn(**tc.function.arguments_dict)
                result_preview = str(result)[:200].replace("\n", " ")
                logger.info("dapr-agent |   <- %s", result_preview)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": str(result)})

        return "Max turns reached without a final answer.", self._max_turns
