import logging

from claude_agent_sdk import ClaudeAgentOptions
from diagrid.agent.claude_agents import DaprWorkflowAgentRunner

from domain.models import AgentRequest, AgentResponse
from infrastructure.tools import tools

logger = logging.getLogger(__name__)


class ClaudeManagedRunner:
    """Outbound adapter: wraps DaprWorkflowAgentRunner as an IAgentRunner port."""

    def __init__(self, *, model: str, system_prompt: str, max_iterations: int) -> None:
        options = ClaudeAgentOptions(system_prompt=system_prompt, model=model)
        self._model = model
        self._runner = DaprWorkflowAgentRunner(
            name="claude-managed-agent",
            options=options,
            tools=tools,
            max_iterations=max_iterations,
        )

    def start(self) -> None:
        self._runner.start()

    def shutdown(self) -> None:
        self._runner.shutdown()

    async def run(self, request: AgentRequest) -> AgentResponse:
        session_id = request.session_id or request.workflow_instance_id or "default"
        final_response = ""
        iterations = 0

        async for event in self._runner.run_async(
            user_message=request.input,
            session_id=session_id,
        ):
            event_type = event.get("type")
            if event_type == "workflow_completed":
                final_response = event.get("final_response", "")
                iterations = event.get("iterations", 0)
                logger.info("agent completed in %d iterations", iterations)
            elif event_type in ("workflow_failed", "workflow_error"):
                raise RuntimeError(f"Agent {event_type}: {event.get('error')}")

        return AgentResponse(
            output=final_response,
            session_id=session_id,
            model=self._model,
            turns=iterations,
        )
