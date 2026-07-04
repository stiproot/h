"""Provider adapters that satisfy :class:`agent_core.react_loop.LLMClient`.

Each adapter imports its provider SDK, so import the submodule you need directly
(``from agent_core.llm.openai import OpenAIChatAdapter``) rather than eagerly here —
that keeps the ``dapr`` and ``anthropic`` extras independent.
"""
