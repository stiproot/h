from dataclasses import dataclass
from enum import StrEnum


class TaskStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    DONE = "done"
    FAILED = "failed"


@dataclass
class Task:
    """A unit of work the workflow-agent turns into a persisted, executed workflow."""

    id: str
    problem: str
    status: str = TaskStatus.PENDING.value
    issue_id: str | None = None
    result: str | None = None

    @classmethod
    def from_state(cls, data: dict) -> "Task":
        return cls(
            id=data["id"],
            problem=data.get("problem", ""),
            status=data.get("status", TaskStatus.PENDING.value),
            issue_id=data.get("issueId"),
            result=data.get("result"),
        )

    def to_state(self) -> dict:
        return {
            "id": self.id,
            "problem": self.problem,
            "status": self.status,
            "issueId": self.issue_id,
            "result": self.result,
        }


@dataclass
class AgentResult:
    output: str
    turns: int
