from typing import Protocol, runtime_checkable

from domain.models import AgentRequest, AgentResponse


@runtime_checkable
class IAgentRunner(Protocol):
    async def run(self, request: AgentRequest) -> AgentResponse: ...
