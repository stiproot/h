"""Trigger client for the workflow-agent (build/run → monitor a seeded task)."""

from typing import Any

import httpx

from h_cli.config import AGENT_URL


def run_task(task_id: str, timeout_secs: int = 1800) -> Any:
    """POST /run for a seeded task and block until the agent returns (long-poll, like scripts)."""
    resp = httpx.post(f"{AGENT_URL}/run", json={"taskId": task_id}, timeout=timeout_secs)
    resp.raise_for_status()
    return resp.json()
