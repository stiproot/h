from pathlib import Path
from typing import Protocol, runtime_checkable

from agent_server.models import AgentRequest, AgentResponse


@runtime_checkable
class IAgentRunner(Protocol):
    async def run(self, request: AgentRequest, workspace: Path) -> AgentResponse: ...
