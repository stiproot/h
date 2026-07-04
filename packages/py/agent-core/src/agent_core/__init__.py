"""agent-core — shared machinery for h Python agent services.

The base package is dependency-free (just the ReAct loop + LLM-client protocol).
Provider adapters live under ``agent_core.llm`` and the workflow toolset under
``agent_core.workflows``, each behind a pyproject extra (``dapr`` / ``anthropic``),
so importing the loop never forces an LLM SDK on a consumer.
"""

from agent_core.react_loop import (
    LLMClient,
    LLMTurn,
    ToolCall,
    ToolDispatch,
    run_react_loop,
)
from agent_core.skills import load_skill_instructions

__all__ = [
    "LLMClient",
    "LLMTurn",
    "ToolCall",
    "ToolDispatch",
    "load_skill_instructions",
    "run_react_loop",
]
