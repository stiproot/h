"""LLMClient adapter over ``dapr_agents.OpenAIChatClient`` (OpenAI wire protocol).

Requires the ``dapr`` extra (``agent-core[dapr]``). Pointed at an Anthropic-compatible
endpoint (e.g. a LiteLLM proxy) via ``base_url`` + ``api_key`` — the same wiring the
Python agents used before this adapter existed.
"""

from __future__ import annotations

import asyncio
from typing import Any

from dapr_agents import OpenAIChatClient

from agent_core.react_loop import LLMTurn, ToolCall


class OpenAIChatAdapter:
    """Bridges ``OpenAIChatClient`` to the provider-agnostic loop.

    ``generate`` is synchronous in the SDK, so it runs on a worker thread to avoid
    blocking the event loop.
    """

    def __init__(self, *, api_key: str, base_url: str, model: str) -> None:
        self._client = OpenAIChatClient(api_key=api_key, base_url=base_url, model=model)

    async def generate(self, messages: list[Any], tools: list[Any]) -> LLMTurn:
        response = await asyncio.to_thread(self._client.generate, messages, tools=tools)
        msg = response.get_message()
        raw_calls = msg.get_tool_calls() if hasattr(msg, "get_tool_calls") else None
        calls = [
            ToolCall(id=tc.id, name=tc.function.name, arguments=tc.function.arguments_dict)
            for tc in (raw_calls or [])
        ]
        return LLMTurn(content=msg.content, tool_calls=calls, raw=msg)

    def append_assistant(self, messages: list[Any], turn: LLMTurn) -> None:
        # OpenAI-protocol clients require the exact assistant message they emitted
        # (it carries the tool_calls the following tool messages answer).
        messages.append(turn.raw)

    def append_tool_result(self, messages: list[Any], call: ToolCall, result: str) -> None:
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
