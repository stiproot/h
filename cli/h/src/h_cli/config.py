"""Env-derived settings — defaults mirror the cli/scripts siblings, overridable the same way.

The CLI is installed editable as a uv workspace member, so file-relative resolution reaches the
repo checkout: this file lives at cli/h/src/h_cli/config.py, making parents[3] the cli/ dir.
"""

import os
from pathlib import Path

_CLI_DIR = Path(__file__).resolve().parents[3]
_REPO_DIR = _CLI_DIR.parent

# Template source (strategy 2 — see cli/README.md) and the gitignored feature-spec home.
CHARTS_DIR = Path(os.getenv("H_CHARTS_DIR", str(_CLI_DIR / "charts")))

# --- Direct execution substrate -------------------------------------------------------------
# The runner binary the CLI spawns instead of firing a workflow through workflow-svc. It is a
# built workspace package, so `bun run build` is the one prerequisite direct execution has.
DIRECT_BIN = Path(
    os.getenv("H_DIRECT_BIN", str(_REPO_DIR / "packages/js/direct-runtime/dist/bin.js"))
)

# Run-ledger root. Defaults to the SAME directory the agent services write (host mode's
# AGENT_BASE_DIR sibling, which is the compose bind mount too), so a direct run shows up in
# `h runs`, obs-mcp and the viz beside service runs instead of in a private ledger.
AGENT_RUNS_DIR = Path(os.getenv("AGENT_RUNS_DIR", str(_REPO_DIR / "../h-workspace/.runs")))

# Where per-agent worktrees are cut for a delegated write task.
DIRECT_WORKTREES_DIR = Path(os.getenv("H_DIRECT_WORKTREES_DIR", str(_REPO_DIR / "../h-worktrees")))

# The repo's .env — the same file compose and the run scripts feed the agent services from. A
# direct run reads it too, so the substrate does not need its own credential setup.
DOTENV_PATH = Path(os.getenv("H_DOTENV", str(_REPO_DIR / ".env")))
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
    "openhands-agent": "http://localhost:8004",
    "pi-agent": "http://localhost:8015",
    "codex-agent": "http://localhost:8016",
    "kimi-agent": "http://localhost:8017",
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
    "openhands": ("run-openhands", "openhands-agent"),
    "openhands-agent": ("run-openhands", "openhands-agent"),
    "pi": ("run-pi", "pi-agent"),
    "pi-agent": ("run-pi", "pi-agent"),
    "codex": ("run-codex", "codex-agent"),
    "codex-agent": ("run-codex", "codex-agent"),
    "kimi": ("run-kimi", "kimi-agent"),
    "kimi-agent": ("run-kimi", "kimi-agent"),
}

# The model param slots publish-mode templates expose (chain's KIND_MODEL_PARAMS, unioned).
# `--model` is execution machinery (like `--agent`): it sets these slots on `h workflow run`.
MODEL_PARAM_SLOTS: tuple[str, ...] = (
    "modelPlan",
    "modelImplement",
    "modelReview",
    "modelRevise",
    "modelAnswer",
)

# Saved keys whose executor is pinned: --agent is warned-and-ignored, never applied. review-pr's
# executor is the loop's consistent reviewer (claude-agent). Under the trust model this pin is an
# operational default, not a security boundary (a
# minimal-surface reviewer returns as a per-run trust profile if untrusted repos do).
FROZEN_EXECUTOR_KEYS: frozenset[str] = frozenset({"review-pr"})


# The executor a chart template's BAKED models were chosen for — `agentId` in
# cli/charts/workflows/values.yaml. Templates bake claude model ids (implement.models.plan =
# claude-sonnet-4-6, …) because claude is the chart's default executor.
DEFAULT_TEMPLATE_AGENT_ID = "claude-agent"


def baked_models_suit(agent: str) -> bool:
    """True when `agent` is the executor a template's baked models were chosen for.

    A baked model BELONGS TO its executor: `claude-sonnet-4-6` is meaningless to an
    openhands-agent pointed at DeepSeek, which rejects it outright
    (`LLMBadRequestError: … but you passed claude-sonnet-4-6`, hit live 2026-07-27 — the run
    exited 0 with empty output, so the cause was invisible). `--agent` and `--model` are
    independent axes, so switching executor without also switching model is a guaranteed
    failure that LOOKS like a valid command.

    panelize.py already encodes this rule for roster branches ("a baked model belongs to the
    original executor; each branch falls back to its own AGENT_MODEL"); this is the same rule
    for a SINGLE `--agent`.
    """
    identity = AGENT_IDENTITY.get(agent)
    return identity is not None and identity[1] == DEFAULT_TEMPLATE_AGENT_ID


def agent_identity_params(agent: str) -> dict[str, str] | None:
    """A user-facing `--agent` name → the {runActivity, agentId} fire-time params a published
    template's identity slots consume, or None if the name is unknown. The single expansion both
    `h workflow run` and `h chain run` use, so `--agent` means the SAME thing in both."""
    identity = AGENT_IDENTITY.get(agent)
    if identity is None:
        return None
    return {"runActivity": identity[0], "agentId": identity[1]}
