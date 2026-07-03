import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from infrastructure.claude_managed_runner import ClaudeManagedRunner
from presentation.http.run_router import create_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

_DEFAULT_SYSTEM = (
    "You are a helpful assistant with access to a calculator, text analysis, "
    "a datetime tool, and a text formatter. Use them to answer requests accurately. "
    "When you have the final answer, respond directly without calling any more tools."
)

_runner = ClaudeManagedRunner(
    model=os.getenv("AGENT_MODEL", "claude-sonnet-4-6"),
    system_prompt=os.getenv("AGENT_SYSTEM_PROMPT", _DEFAULT_SYSTEM),
    max_iterations=int(os.getenv("AGENT_MAX_ITERATIONS", "10")),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _runner.start()
    yield
    _runner.shutdown()


app = FastAPI(lifespan=lifespan)
app.include_router(create_router(_runner))
