"""The shared agentic ReAct loop for h Python agent services.

Pure orchestration — no LLM SDK imports. A service supplies an :class:`LLMClient`
adapter (which owns provider-specific message formatting) and an async ``dispatch``
that executes a single tool call; this module owns the generate -> call tools ->
repeat loop. Keeping it dependency-free means any service can share it without
inheriting a particular provider SDK (the adapters live under ``agent_core.llm``,
behind extras).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ToolCall:
    """A single tool invocation the model requested."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class LLMTurn:
    """One model response: either a final answer (``content``) or ``tool_calls``.

    ``raw`` carries the provider's own assistant-message object so an adapter can
    append it back verbatim (some SDKs require the exact message they emitted); the
    loop never inspects it.
    """

    content: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw: Any = None


@runtime_checkable
class LLMClient(Protocol):
    """Adapter over a provider SDK. Owns provider-specific message formatting so the
    loop stays provider-agnostic. See ``agent_core.llm`` for concrete adapters."""

    async def generate(self, messages: list[Any], tools: list[Any]) -> LLMTurn:
        """Call the model with the running ``messages`` and ``tools``; parse the reply."""
        ...

    def append_assistant(self, messages: list[Any], turn: LLMTurn) -> None:
        """Append the model's (tool-calling) assistant message to ``messages``."""
        ...

    def append_tool_result(self, messages: list[Any], call: ToolCall, result: str) -> None:
        """Append the result of ``call`` to ``messages`` in the provider's tool-result shape."""
        ...


# Executes one tool call and returns its result (stringified before it is fed back).
ToolDispatch = Callable[[str, dict[str, Any]], Awaitable[Any]]

DEFAULT_RESULT_CHAR_LIMIT = 8000
MAX_ITERATIONS_MESSAGE = "Agent reached max iterations without finishing."


async def run_react_loop(
    client: LLMClient,
    messages: list[Any],
    tools: list[Any],
    dispatch: ToolDispatch,
    *,
    max_iterations: int,
    label: str = "agent",
    result_char_limit: int = DEFAULT_RESULT_CHAR_LIMIT,
) -> tuple[str, int]:
    """Drive the model/tool loop until the model stops calling tools or the budget runs out.

    Returns ``(final_text, turns_used)``. Each turn: ask the model to ``generate``; if it
    returned no tool calls, that turn's ``content`` is the final answer; otherwise append
    the assistant message, run every requested tool via ``dispatch``, feed the (truncated)
    results back, and continue.
    """
    for turn in range(1, max_iterations + 1):
        logger.info("%s | turn %d", label, turn)
        result = await client.generate(messages, tools)

        if not result.tool_calls:
            return result.content or "", turn

        client.append_assistant(messages, result)
        for call in result.tool_calls:
            logger.info("%s |   -> %s", label, call.name)
            output = await dispatch(call.name, call.arguments)
            client.append_tool_result(messages, call, str(output)[:result_char_limit])

    return MAX_ITERATIONS_MESSAGE, max_iterations
