"""Read-side client for workflow-svc's HTTP surface (saved workflows + instance status)."""

from typing import Any

import httpx

from h_cli.config import WORKFLOW_URL


def list_keys() -> list[str]:
    resp = httpx.get(f"{WORKFLOW_URL}/workflow/list", timeout=10)
    resp.raise_for_status()
    return resp.json()["keys"]


def get(key: str) -> Any:
    resp = httpx.get(f"{WORKFLOW_URL}/workflow/get/{key}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def status(instance_id: str) -> Any:
    resp = httpx.get(f"{WORKFLOW_URL}/workflow/status/{instance_id}", timeout=10)
    resp.raise_for_status()
    return resp.json()
