import logging
import os
from pathlib import Path

from agent_server import AgentResponse
from langchain_core.messages import AIMessage
from langgraph.errors import GraphRecursionError

from domain.models import AgentRequest, GraphConfig
from infrastructure.graph_builder import build_react_agent

logger = logging.getLogger(__name__)

_MAX_ITERATIONS_MESSAGE = "Agent reached max iterations without a final answer."


def _last_text(messages) -> str:
    content = getattr(messages[-1], "content", "")
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


def _count_turns(messages) -> int:
    """One LLM call per AI message – matches the iteration count other agents report."""
    return sum(1 for m in messages if isinstance(m, AIMessage))


def _aggregate_usage(messages) -> dict:
    usage = {"input": 0, "output": 0}
    for m in messages:
        meta = getattr(m, "usage_metadata", None)
        if meta:
            usage["input"] += meta.get("input_tokens", 0)
            usage["output"] += meta.get("output_tokens", 0)
    return usage


class LangGraphRunner:
    """Outbound adapter: builds and runs a LangGraph ReAct agent (pure LangChain)."""

    def __init__(self, *, model: str, system_prompt: str, max_iterations: int) -> None:
        self._model = model
        self._system_prompt = system_prompt
        self._max_iterations = max_iterations

    async def start(self) -> None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY is required")
        if not os.environ.get("ANTHROPIC_BASE_URL"):
            raise RuntimeError("ANTHROPIC_BASE_URL is required")

    async def shutdown(self) -> None:
        return None

    async def run(self, request: AgentRequest, workspace: Path) -> AgentResponse:
        config = request.graph or GraphConfig()
        model = config.model or self._model
        system = request.system_prompt or config.system_prompt or self._system_prompt
        max_iterations = config.max_iterations or self._max_iterations
        session_id = request.session_id or request.workflow_instance_id or "default"

        agent = build_react_agent(
            tools=config.tools,
            model=model,
            system_prompt=system,
            workspace=workspace,
        )

        logger.info("langgraph-agent | task: %s", request.input[:120])
        # recursion_limit counts graph super-steps; a ReAct turn is roughly a model step
        # plus a tool step, so budget two steps per requested iteration.
        try:
            result = await agent.ainvoke(
                {"messages": [("user", request.input)]},
                config={"recursion_limit": max_iterations * 2},
            )
        except GraphRecursionError:
            logger.info("langgraph-agent | hit max iterations (%d)", max_iterations)
            return AgentResponse(
                output=_MAX_ITERATIONS_MESSAGE,
                session_id=session_id,
                model=model,
                turns=max_iterations,
            )

        messages = result["messages"]
        output = _last_text(messages)
        turns = _count_turns(messages)
        logger.info("langgraph-agent | done – %d turns, output %d chars", turns, len(output))
        return AgentResponse(
            output=output,
            session_id=session_id,
            model=model,
            turns=turns,
            usage=_aggregate_usage(messages),
        )
