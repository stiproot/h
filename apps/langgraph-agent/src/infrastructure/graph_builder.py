import os
from pathlib import Path

from langchain_anthropic import ChatAnthropic
from langgraph.prebuilt import create_react_agent

from infrastructure.tools import resolve_tools


def build_react_agent(*, tools: list[str] | None, model: str, system_prompt: str, workspace: Path):
    """Compile a LangGraph ReAct agent from config.

    The agent<->tools loop is fixed by `create_react_agent`; this function is the seam
    where config drives the topology (model, tool selection, prompt). It can grow into a
    fuller nodes/edges builder without changing the request shape.
    """
    llm = ChatAnthropic(
        model=model,
        base_url=os.environ["ANTHROPIC_BASE_URL"],
        api_key=os.environ["ANTHROPIC_API_KEY"],
        max_tokens=8192,
    )
    bound_tools = resolve_tools(tools, workspace)
    return create_react_agent(llm, bound_tools, prompt=system_prompt)
