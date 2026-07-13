"""Env-derived CLI configuration, agent identity tables, and agent URL registry.

Defaults mirror the cli/scripts siblings and are overridable via environment variables. The agent
identity/URL lookup tables map user-facing --agent names to their service endpoints and fire-time
{runActivity, agentId} parameter pairs."""

import os
from pathlib import Path

_CLI_DIR = Path(__file__).resolve().parents[3]

# Template source (strategy 2 — see cli/README.md) and the gitignored feature-spec home.
CHARTS_DIR = Path(os.getenv("H_CHARTS_DIR", str(_CLI_DIR / "charts")))
FEATURE_SPECS_DIR = Path(
    os.getenv("H_FEATURE_SPECS_DIR", str(_CLI_DIR / "scripts/payloads/domain/feature-requests"))
)

WORKFLOW_URL = os.getenv("WORKFLOW_URL", "http://localhost:8003")  # workflow-svc app
AGENT_URL = os.getenv("AGENT_URL", "http://localhost:8010")  # workflow-agent app
DAPR_HTTP_PORT = os.getenv("DAPR_HTTP_PORT", "3510")  # workflow-agent's Dapr sidecar
STATE_URL = f"http://localhost:{DAPR_HTTP_PORT}/v1.0/state/statestore"

# Agent-service registry for --agent flags: app ports as pinned by cli/scripts/run-*.sh
# (the full map is in README.md). Any of these can host the standard POST /workflow
# submit-and-babysit endpoint; a full http(s) URL is also accepted wherever a name is.
AGENT_URLS = {
    "claude-agent": "http://localhost:8002",
    "claude-coder": "http://localhost:8014",
    "openhands-agent": "http://localhost:8004",
    "pi-agent": "http://localhost:8015",
    "dapr-agent": "http://localhost:8006",
    "dapr-claude-loop-agent": "http://localhost:8007",
    "langgraph-agent": "http://localhost:8009",
    "workflow-agent": "http://localhost:8010",
}


def resolve_agent_url(agent: str) -> str | None:
    """An http(s) URL passes through; otherwise look the name up in the registry."""
    if agent.startswith(("http://", "https://")):
        return agent
    return AGENT_URLS.get(agent)


# Fire-time identity mapping (chain-composition-surface §1.9): a user-facing --agent name → the
# {runActivity, agentId} param pair a published template's identity slots consume. An explicit
# table, deliberately not a naming convention (run-dapr-agent's agentId is 'dapr-agent', not
# 'dapr-agent-agent'). Only agents whose run activity takes the shared {cwd,model,task} input
# belong here — extend as more agents earn a run-* activity.
AGENT_IDENTITY: dict[str, tuple[str, str]] = {
    "claude": ("run-claude", "claude-agent"),
    "claude-agent": ("run-claude", "claude-agent"),
    "claude-coder": ("run-claude-coder", "claude-coder"),
    "openhands": ("run-openhands", "openhands-agent"),
    "openhands-agent": ("run-openhands", "openhands-agent"),
    "pi": ("run-pi", "pi-agent"),
    "pi-agent": ("run-pi", "pi-agent"),
}

# The model param slots publish-mode templates expose (chain's KIND_MODEL_PARAMS, unioned).
# `--model` is execution machinery (like `--agent`): it sets these slots on `h workflow run`.
MODEL_PARAM_SLOTS: tuple[str, ...] = ("modelPlan", "modelImplement", "modelReview")

# Saved keys whose executor is frozen by the untrusted-input security invariant
# (docs/plans/reviewer-identity-security.md): --agent is warned-and-ignored, never applied.
FROZEN_EXECUTOR_KEYS: frozenset[str] = frozenset({"pr-review"})


def agent_identity_params(agent: str) -> dict[str, str] | None:
    """A user-facing `--agent` name → the {runActivity, agentId} fire-time params a published
    template's identity slots consume, or None if the name is unknown. The single expansion both
    `h workflow run` and `h chain run` use, so `--agent` means the SAME thing in both."""
    identity = AGENT_IDENTITY.get(agent)
    if identity is None:
        return None
    return {"runActivity": identity[0], "agentId": identity[1]}
