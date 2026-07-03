from dataclasses import dataclass

from agent_server import AgentRequest as BaseAgentRequest


@dataclass
class GraphConfig:
    tools: list[str] | None = None
    system_prompt: str | None = None
    model: str | None = None
    max_iterations: int | None = None


@dataclass
class AgentRequest(BaseAgentRequest):
    graph: GraphConfig | None = None
