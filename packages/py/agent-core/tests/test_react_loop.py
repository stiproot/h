"""Tests for the pure ReAct loop. Run directly: `uv run --package agent-core python
packages/py/agent-core/tests/test_react_loop.py` (no test runner required)."""

from __future__ import annotations

import asyncio
from typing import Any

from agent_core.react_loop import (
    MAX_ITERATIONS_MESSAGE,
    LLMTurn,
    ToolCall,
    run_react_loop,
)


class FakeClient:
    """Scripted LLMClient: yields the given turns in order, records append calls."""

    def __init__(self, turns: list[LLMTurn]) -> None:
        self._turns = list(turns)
        self.assistant_appends = 0
        self.tool_results: list[str] = []

    async def generate(self, messages: list[Any], tools: list[Any]) -> LLMTurn:
        return self._turns.pop(0)

    def append_assistant(self, messages: list[Any], turn: LLMTurn) -> None:
        self.assistant_appends += 1
        messages.append({"role": "assistant"})

    def append_tool_result(self, messages: list[Any], call: ToolCall, result: str) -> None:
        self.tool_results.append(result)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})


async def _returns_content_without_tools() -> None:
    client = FakeClient([LLMTurn(content="done")])

    async def dispatch(name: str, args: dict) -> Any:
        raise AssertionError("dispatch should not be called")

    out, turns = await run_react_loop(client, [], [], dispatch, max_iterations=5)
    assert out == "done", out
    assert turns == 1, turns
    assert client.assistant_appends == 0


async def _executes_tool_then_finishes() -> None:
    calls: list[tuple[str, dict]] = []
    client = FakeClient(
        [
            LLMTurn(tool_calls=[ToolCall(id="c1", name="echo", arguments={"x": 1})]),
            LLMTurn(content="finished"),
        ]
    )

    async def dispatch(name: str, args: dict) -> Any:
        calls.append((name, args))
        return "tool-out"

    out, turns = await run_react_loop(client, [], [], dispatch, max_iterations=5)
    assert out == "finished", out
    assert turns == 2, turns
    assert calls == [("echo", {"x": 1})], calls
    assert client.assistant_appends == 1
    assert client.tool_results == ["tool-out"], client.tool_results


async def _stops_at_max_iterations() -> None:
    client = FakeClient(
        [LLMTurn(tool_calls=[ToolCall(id="c", name="loop", arguments={})]) for _ in range(10)]
    )

    async def dispatch(name: str, args: dict) -> Any:
        return "x"

    out, turns = await run_react_loop(client, [], [], dispatch, max_iterations=3)
    assert out == MAX_ITERATIONS_MESSAGE, out
    assert turns == 3, turns


async def _truncates_tool_result() -> None:
    client = FakeClient(
        [
            LLMTurn(tool_calls=[ToolCall(id="c1", name="big", arguments={})]),
            LLMTurn(content="ok"),
        ]
    )

    async def dispatch(name: str, args: dict) -> Any:
        return "y" * 100

    await run_react_loop(client, [], [], dispatch, max_iterations=5, result_char_limit=10)
    assert client.tool_results == ["y" * 10], client.tool_results


async def main() -> None:
    await _returns_content_without_tools()
    await _executes_tool_then_finishes()
    await _stops_at_max_iterations()
    await _truncates_tool_result()
    print("agent_core.react_loop: all tests passed")


if __name__ == "__main__":
    asyncio.run(main())
