"""Guard: the direct substrate's --agent vocabulary stays in step with the service substrate's.

The whole claim of direct execution is that `--agent codex` means the SAME executor on both
substrates — the service path resolves it to a `run-codex` activity, the direct path to an
agent-cli strategy. That symmetry lives in two tables in two languages
(`AGENT_IDENTITY` in config.py, `AGENT_ALIASES` in direct-runtime's domain/agents.ts), so it is
exactly the kind of thing that drifts silently: add an agent to one and `--direct` either refuses
a name h otherwise supports, or offers one the runtime cannot run.

The sibling of test_agent_identity_sync.py (CLI ↔ engine) and test_kind_sync.py (CLI ↔ chain
kinds): same failure mode, the other substrate.
"""

import re
from pathlib import Path

import pytest

from h_cli.config import AGENT_IDENTITY

# cli/h/tests/ → cli/h/ → cli/ → repo root
_REPO_ROOT = Path(__file__).parents[3]
_DIRECT = _REPO_ROOT / "packages/js/direct-runtime/src/domain"
_AGENTS_TS = _DIRECT / "agents.ts"
_MODELS_TS = _DIRECT / "models.ts"
_STRATEGIES_TS = _REPO_ROOT / "packages/js/agent-cli/src/agents/event-shape.ts"

_skip_no_ts = pytest.mark.skipif(
    not _AGENTS_TS.exists(), reason="TS sources absent — Python-only checkout"
)

# Agents h runs ONLY as a service: no agent-cli strategy drives them, so direct execution
# cannot. Listed explicitly, because "missing from the direct table" must be a DECISION rather
# than an oversight — the refusal message in agents.ts names these too.
_SERVICE_ONLY = {"kimi", "kimi-agent"}


def _direct_aliases() -> set[str]:
    """The `--agent` names direct-runtime accepts (its AGENT_ALIASES map keys)."""
    block = re.search(r"AGENT_ALIASES[^{]*\{(.*?)\n\};", _AGENTS_TS.read_text(), re.S)
    assert block, "could not find AGENT_ALIASES in direct-runtime's agents.ts"
    return set(re.findall(r'^\s*"?([a-z0-9-]+)"?\s*:', block.group(1), re.M))


def _direct_agent_types() -> set[str]:
    """The canonical agents direct execution claims to run (DIRECT_AGENT_TYPES)."""
    block = re.search(r"DIRECT_AGENT_TYPES\s*=\s*\[(.*?)\]", _MODELS_TS.read_text(), re.S)
    assert block, "could not find DIRECT_AGENT_TYPES in direct-runtime's models.ts"
    return set(re.findall(r'"([a-z0-9-]+)"', block.group(1)))


def _agent_cli_strategies() -> set[str]:
    """The agent types agent-cli actually has a strategy for (event-shape.ts's STRATEGIES map)."""
    block = re.search(
        r"STRATEGIES:\s*Record<AgentType,\s*AgentStrategy>\s*=\s*\{(.*?)\n\};",
        _STRATEGIES_TS.read_text(),
        re.S,
    )
    assert block, "could not find the STRATEGIES map in agent-cli's event-shape.ts"
    return set(re.findall(r"^\s*([a-z0-9]+)\s*:", block.group(1), re.M))


@_skip_no_ts
def test_every_service_agent_is_runnable_or_declared_service_only() -> None:
    """Adding an agent to AGENT_IDENTITY forces a decision about the direct substrate."""
    missing = set(AGENT_IDENTITY) - _direct_aliases() - _SERVICE_ONLY
    assert not missing, (
        f"--agent names the service substrate accepts but direct execution does not: "
        f"{sorted(missing)}. Either add them to AGENT_ALIASES in "
        "packages/js/direct-runtime/src/domain/agents.ts (with a strategy behind them), or add "
        "them to _SERVICE_ONLY here and to the refusal message in agents.ts."
    )


@_skip_no_ts
def test_direct_never_offers_an_agent_h_does_not_know() -> None:
    """The reverse drift: a direct-only name would be accepted with --direct and refused without."""
    stray = _direct_aliases() - set(AGENT_IDENTITY)
    assert not stray, (
        f"direct execution accepts --agent names AGENT_IDENTITY does not: {sorted(stray)}. "
        "Add them to AGENT_IDENTITY in cli/h/src/h_cli/config.py so both substrates agree."
    )


@_skip_no_ts
def test_direct_agent_types_match_agent_cli_strategies() -> None:
    """Direct execution runs CLIs through agent-cli, so its canonical set is agent-cli's set.

    A new strategy that never reaches this table is a capability h has and cannot use; a table
    entry with no strategy is a promise the runtime breaks at the invoker layer.
    """
    assert _direct_agent_types() == _agent_cli_strategies(), (
        "DIRECT_AGENT_TYPES (direct-runtime/src/domain/models.ts) and agent-cli's STRATEGIES map "
        "disagree. A new agent-cli strategy must be added to both, plus AGENT_ALIASES and "
        "the INVOKERS map in infrastructure/agent-cli-agent.ts."
    )
