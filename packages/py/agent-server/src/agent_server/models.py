from dataclasses import dataclass, field


@dataclass
class AgentRequest:
    input: str
    system_prompt: str | None = None
    session_id: str | None = None
    workflow_instance_id: str | None = None
    # Stable workspace key. When set, the workspace dir keys on it instead of workflow_instance_id.
    workspace_id: str | None = None


@dataclass
class AgentResponse:
    output: str
    session_id: str
    model: str
    turns: int
    usage: dict = field(default_factory=lambda: {"input": 0, "output": 0})
    # Total LLM cost in USD, when the agent reports it.
    cost_usd: float | None = None
    # Number of tool calls made during the run (best-effort).
    tool_calls: int | None = None
    # Identifier of the run-ledger record for this run.
    run_id: str | None = None
