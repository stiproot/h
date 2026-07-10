"""Domain ports — the interfaces the pure core defines and the adapters implement.

Inbound adapters (presentation) and the composition root depend on these Protocols, never on
the concrete infrastructure classes, so the dependency arrow always points *into* the domain.
Protocols are structural: `infrastructure.WorkflowAgentRunner` / `StateStore` satisfy these
without importing them, and `main.py` wires the concrete instances in unchanged.
"""

from typing import Protocol

from domain.models import AgentResult


class ITaskRunner(Protocol):
    """Runs a task's problem statement to a result. Impl: infrastructure.WorkflowAgentRunner."""

    async def run(self, problem: str) -> AgentResult: ...


class ITaskStore(Protocol):
    """Reads and persists task state. Impl: infrastructure.StateStore."""

    async def list_task_ids(self) -> list[str]: ...

    async def get_task(self, task_id: str) -> dict | None: ...

    async def save_task(self, task: dict) -> None: ...
