"""Client for an agent service's standard workflow endpoint (submit-and-babysit).

POST /workflow is non-blocking: the agent schedules the run on workflow-svc, returns
{"instanceId", "watching"} immediately, and its babysitter supervises the instance
(terminal event or budget-terminate). See packages/js/agent-server/src/workflow-route.ts
and packages/py/agent-server/src/agent_server/workflow_route.py.
"""

from typing import Any

import httpx


def submit_workflow(agent_url: str, body: dict[str, Any]) -> Any:
    resp = httpx.post(f"{agent_url}/workflow", json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def list_watches(agent_url: str) -> Any:
    resp = httpx.get(f"{agent_url}/workflow/watches", timeout=10)
    resp.raise_for_status()
    return resp.json()
