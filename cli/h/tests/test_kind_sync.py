"""Guard: ChainMemberKind (TS engine) stays in sync with KNOWN_KINDS + the parallel dicts (CLI).

Catches the failure mode described in the hardening-audit: a novel kind added to chain.model.ts
without updating chain.py (or vice-versa) is silently unreachable from `h chain run`.
"""

import re
from pathlib import Path

import pytest

from h_cli.commands.chain import (
    FROZEN_EXECUTOR_KINDS,
    KIND_FIRE,
    KIND_MODEL_PARAMS,
    KNOWN_KINDS,
    TERMINAL_ATOM_KIND,
    WELL_KNOWN,
)
from h_cli.config import MODEL_PARAM_SLOTS

# cli/h/tests/ → cli/h/ → cli/ → repo root
_REPO_ROOT = Path(__file__).parents[3]
_CHAIN_MODEL = _REPO_ROOT / "apps/workflow-svc/src/domain/models/chain.model.ts"


def test_known_kinds_matches_engine_literal() -> None:
    """KNOWN_KINDS must equal the ChainMemberKind Schema.Literal in the TS engine."""
    if not _CHAIN_MODEL.exists():
        pytest.skip(f"TS source not found at {_CHAIN_MODEL} — skipping in Python-only checkout")

    text = _CHAIN_MODEL.read_text()
    m = re.search(r"ChainMemberKind\s*=\s*Schema\.Literal\(([^)]+)\)", text)
    assert m, f"Could not find ChainMemberKind = Schema.Literal(...) in {_CHAIN_MODEL}"

    engine_kinds = set(re.findall(r'"([^"]+)"', m.group(1)))
    assert engine_kinds == set(KNOWN_KINDS), (
        f"KNOWN_KINDS in chain.py ({sorted(KNOWN_KINDS)}) does not match "
        f"ChainMemberKind in chain.model.ts ({sorted(engine_kinds)}). "
        "Add the missing kind to BOTH sides."
    )


def test_kind_dicts_are_complete() -> None:
    """WELL_KNOWN, KIND_FIRE, KIND_MODEL_PARAMS keys must equal KNOWN_KINDS.
    TERMINAL_ATOM_KIND values and FROZEN_EXECUTOR_KINDS must be subsets of KNOWN_KINDS."""
    kinds = set(KNOWN_KINDS)

    assert set(WELL_KNOWN.keys()) == kinds, (
        f"WELL_KNOWN keys {sorted(WELL_KNOWN)} != KNOWN_KINDS {sorted(kinds)}"
    )
    assert set(KIND_FIRE.keys()) == kinds, (
        f"KIND_FIRE keys {sorted(KIND_FIRE)} != KNOWN_KINDS {sorted(kinds)}"
    )
    assert set(KIND_MODEL_PARAMS.keys()) == kinds, (
        f"KIND_MODEL_PARAMS keys {sorted(KIND_MODEL_PARAMS)} != KNOWN_KINDS {sorted(kinds)}"
    )
    # TERMINAL_ATOM_KIND maps atom→kind; values are kind names, not dict keys
    stray_values = set(TERMINAL_ATOM_KIND.values()) - kinds
    assert not stray_values, f"TERMINAL_ATOM_KIND has values not in KNOWN_KINDS: {stray_values}"
    stray_frozen = FROZEN_EXECUTOR_KINDS - kinds
    assert not stray_frozen, f"FROZEN_EXECUTOR_KINDS has entries not in KNOWN_KINDS: {stray_frozen}"


def test_model_param_slots_is_union_of_kind_model_params() -> None:
    """MODEL_PARAM_SLOTS must equal the union of all KIND_MODEL_PARAMS tuples.

    A missing slot silently drops --model / --fallback-model for that workflow kind
    (the live bug that prompted this test: modelRevise was missing).
    """
    expected = set().union(*KIND_MODEL_PARAMS.values())
    assert set(MODEL_PARAM_SLOTS) == expected, (
        f"MODEL_PARAM_SLOTS {sorted(MODEL_PARAM_SLOTS)} != "
        f"union(KIND_MODEL_PARAMS.values()) {sorted(expected)}. "
        "Add the missing slot(s) to MODEL_PARAM_SLOTS in config.py."
    )
