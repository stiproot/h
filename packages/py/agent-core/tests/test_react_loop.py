"""Tests for the pure ReAct loop. Run: `uv run --package agent-core pytest`."""

from __future__ import annotations

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


async def test_returns_content_without_tools() -> None:
    client = FakeClient([LLMTurn(content="done")])

    async def dispatch(name: str, args: dict) -> Any:
        raise AssertionError("dispatch should not be called")

    out, turns = await run_react_loop(client, [], [], dispatch, max_iterations=5)
    assert out == "done"
    assert turns == 1
    assert client.assistant_appends == 0


async def test_executes_tool_then_finishes() -> None:
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
    assert out == "finished"
    assert turns == 2
    assert calls == [("echo", {"x": 1})]
    assert client.assistant_appends == 1
    assert client.tool_results == ["tool-out"]


async def test_stops_at_max_iterations() -> None:
    client = FakeClient(
        [LLMTurn(tool_calls=[ToolCall(id="c", name="loop", arguments={})]) for _ in range(10)]
    )

    async def dispatch(name: str, args: dict) -> Any:
        return "x"

    out, turns = await run_react_loop(client, [], [], dispatch, max_iterations=3)
    assert out == MAX_ITERATIONS_MESSAGE
    assert turns == 3


async def test_truncates_tool_result() -> None:
    client = FakeClient(
        [
            LLMTurn(tool_calls=[ToolCall(id="c1", name="big", arguments={})]),
            LLMTurn(content="ok"),
        ]
    )

    async def dispatch(name: str, args: dict) -> Any:
        return "y" * 100

    await run_react_loop(client, [], [], dispatch, max_iterations=5, result_char_limit=10)
    assert client.tool_results == ["y" * 10]
