"""Task seeding via the workflow-agent sidecar's state API — sibling of the invoke scripts' curl.

Follows the flat-keyspace convention: task:<id> entries plus the tasks:index list, read-modify-
written the same way the shell scripts do it.
"""

from typing import Any

import httpx

from h_cli.config import STATE_URL


def seed_task(task_id: str, problem: str) -> None:
    """Write a pending task:<id> record and append the id to tasks:index (idempotent)."""
    task: dict[str, Any] = {
        "id": task_id,
        "status": "pending",
        "problem": problem,
        "issueId": None,
        "result": None,
        "pluginFeedback": None,
    }
    with httpx.Client(timeout=10) as client:
        client.post(STATE_URL, json=[{"key": f"task:{task_id}", "value": task}]).raise_for_status()
        index_resp = client.get(f"{STATE_URL}/tasks:index")
        index: list[str] = (
            index_resp.json() if index_resp.status_code == 200 and index_resp.content else []
        ) or []
        if task_id not in index:
            index.append(task_id)
        client.post(STATE_URL, json=[{"key": "tasks:index", "value": index}]).raise_for_status()
