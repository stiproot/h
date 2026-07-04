"""The run ledger captures "what an agent did" for every run as durable, inspectable artifacts.

A ``{AGENT_RUNS_DIR}/<group>/<agentId>-<ts>/`` directory holds ``summary.json``, ``output.txt`` and
``events.jsonl``; a compact record is mirrored into the Dapr statestore under ``run:<runId>`` plus a
``runs:index`` list, so runs are queryable through dapr-mcp. Mirrors the TypeScript ``run-ledger``
in ``packages/js/agent-server``.

Everything is best-effort: observability must never break a run, so failures are swallowed and the
on-disk files remain the source of truth.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from agent_server.models import AgentRequest, AgentResponse


def _runs_dir(explicit: str | None, workspace: Path) -> Path:
    if explicit:
        return Path(explicit)
    # workspace = AGENT_BASE_DIR/workspaces/<key>; runs root is a sibling of AGENT_BASE_DIR.
    return workspace.parent.parent.parent / ".runs"


def record_run(
    *,
    agent_id: str,
    request: AgentRequest,
    response: AgentResponse | None,
    workspace: Path,
    status: str,
    error: str | None = None,
    runs_dir: str | None = None,
    dapr_http_port: str | None = None,
) -> str:
    """Write the run-ledger artifacts and mirror a compact record to the statestore.

    Returns the runId (also suitable for AgentResponse.run_id)."""
    group = request.workflow_instance_id or request.workspace_id or "adhoc"
    ts = int(time.time() * 1000)
    run_id = f"{group}:{agent_id}:{ts}"
    base = _runs_dir(runs_dir, workspace)
    run_dir = base / group / f"{agent_id}-{ts}"
    started_at = datetime.fromtimestamp(ts / 1000, tz=UTC).isoformat()
    ended_at = datetime.now(tz=UTC).isoformat()

    output = response.output if response else ""
    summary = {
        "runId": run_id,
        "agentId": agent_id,
        "workflowInstanceId": request.workflow_instance_id,
        "workspaceId": request.workspace_id,
        "workspacePath": str(workspace),
        "status": status,
        "model": response.model if response else None,
        "turns": response.turns if response else None,
        "tokens": response.usage if response else None,
        "costUsd": response.cost_usd if response else None,
        "toolCalls": response.tool_calls if response else None,
        "sessionId": response.session_id if response else None,
        "startedAt": started_at,
        "endedAt": ended_at,
        "durationMs": int(datetime.fromisoformat(ended_at).timestamp() * 1000) - ts,
        "inputPreview": (request.input or "")[:280],
        "error": error,
    }

    try:
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
        (run_dir / "output.txt").write_text(output)
        # Python loop agents have no JSONL event protocol; record one result event so the artifact
        # shape matches the CLI agents. Per-turn synthesis can be layered in later.
        (run_dir / "events.jsonl").write_text(
            json.dumps({"type": "result", "status": status, "turns": summary["turns"]}) + "\n"
        )
    except Exception:
        pass  # best-effort

    _mirror_to_statestore(
        dapr_http_port, run_id, {**summary, "dir": str(run_dir), "outputPreview": output[:280]}
    )
    return run_id


def _mirror_to_statestore(dapr_http_port: str | None, run_id: str, record: dict) -> None:
    port = dapr_http_port or os.getenv("DAPR_HTTP_PORT")
    if not port:
        return
    base = f"http://localhost:{port}/v1.0/state/statestore"
    key = f"run:{run_id}"
    try:
        _post_json(base, [{"key": key, "value": record}])
        index = _get_json(f"{base}/runs:index")
        index = index if isinstance(index, list) else []
        if key not in index:
            _post_json(base, [{"key": "runs:index", "value": [*index, key]}])
    except Exception:
        pass  # best-effort: the on-disk ledger is the source of truth


def _post_json(url: str, body: object) -> None:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5).read()


def _get_json(url: str) -> object:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except Exception:
        return None
