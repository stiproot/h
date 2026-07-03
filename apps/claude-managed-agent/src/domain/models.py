from dataclasses import dataclass, field


@dataclass
class AgentRequest:
    input: str
    system_prompt: str | None = None
    session_id: str | None = None
    workflow_instance_id: str | None = None


@dataclass
class AgentResponse:
    output: str
    session_id: str
    model: str
    turns: int
    usage: dict = field(default_factory=lambda: {"input": 0, "output": 0})
