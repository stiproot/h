import logging
import os
from pathlib import Path
from typing import Any

import anthropic
from agent_server import AgentRequest, AgentResponse

from infrastructure.tools import TOOL_SCHEMAS, execute_tool

logger = logging.getLogger(__name__)


def _serialize_block(block) -> dict:
    if block.type == "text":
        return {"type": "text", "text": block.text}
    if block.type == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    return block.model_dump(exclude_none=True)


class ClaudeLoopRunner:
    """Outbound adapter: runs the Claude agentic loop directly via the Anthropic SDK."""

    def __init__(self, *, model: str, system_prompt: str, max_iterations: int) -> None:
        self._model = model
        self._system_prompt = system_prompt
        self._max_iterations = max_iterations
        self._client: anthropic.AsyncAnthropic | None = None

    async def start(self) -> None:
        self._client = anthropic.AsyncAnthropic(
            api_key=os.environ["ANTHROPIC_API_KEY"],
            base_url=os.getenv("ANTHROPIC_BASE_URL") or None,
        )

    async def shutdown(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None

    async def run(self, request: AgentRequest, workspace: Path) -> AgentResponse:
        assert self._client is not None, "Runner not started"
        system = request.system_prompt or self._system_prompt
        session_id = request.session_id or request.workflow_instance_id or "default"
        output, turns = await self._run_loop(request.input, system, workspace)
        return AgentResponse(
            output=output,
            session_id=session_id,
            model=self._model,
            turns=turns,
        )

    async def _run_loop(self, task: str, system: str, workspace: Path) -> tuple[str, int]:
        messages: list[dict[str, Any]] = [{"role": "user", "content": task}]

        logger.info("dapr-claude-loop-agent | task: %s", task[:120])

        for iteration in range(1, self._max_iterations + 1):
            logger.info("dapr-claude-loop-agent | turn %d – calling LLM", iteration)
            response = await self._client.messages.create(
                model=self._model,
                max_tokens=8096,
                system=system,
                tools=TOOL_SCHEMAS,
                messages=messages,
            )

            if response.stop_reason == "end_turn":
                text = next((b.text for b in response.content if hasattr(b, "text")), "")
                logger.info(
                    "dapr-claude-loop-agent | turn %d – final answer (%d chars)",
                    iteration,
                    len(text),
                )
                return text, iteration

            if response.stop_reason == "tool_use":
                messages.append(
                    {
                        "role": "assistant",
                        "content": [_serialize_block(b) for b in response.content],
                    }
                )
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        args_preview = str(block.input)[:120]
                        logger.info(
                            "dapr-claude-loop-agent |   -> %s(%s)", block.name, args_preview
                        )
                        result = execute_tool(block.name, block.input, workspace)
                        result_preview = str(result)[:200].replace("\n", " ")
                        logger.info("dapr-claude-loop-agent |   <- %s", result_preview)
                        tool_results.append(
                            {"type": "tool_result", "tool_use_id": block.id, "content": result}
                        )
                messages.append({"role": "user", "content": tool_results})
                continue

            break

        return "Agent reached max iterations without a final answer.", self._max_iterations
