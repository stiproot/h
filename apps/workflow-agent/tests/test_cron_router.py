from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from domain.models import AgentResult
from presentation.http.cron_router import create_router


class FakeRunner:
    async def run(self, problem: str) -> AgentResult:
        raise AssertionError("an empty cron tick must not run a task")


class FakeStore:
    async def list_task_ids(self) -> list[str]:
        return []

    async def get_task(self, task_id: str) -> dict | None:
        raise AssertionError("an empty cron tick must not load a task")

    async def save_task(self, task: dict) -> None:
        raise AssertionError("an empty cron tick must not save a task")


def test_instrumented_cron_tick_handles_included_router() -> None:
    app = FastAPI()
    FastAPIInstrumentor.instrument_app(app)
    app.include_router(create_router(FakeRunner(), FakeStore()))

    response = TestClient(app).post("/cron-tick")

    assert response.status_code == 200
    assert response.json() == {"processed": []}
