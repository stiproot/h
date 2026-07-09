"""The chain-expression parser's contract: grammar, positional scoping, and every error path.

parse_expr is pure (tokens in, structure out), so these tests are the full spec of the EXPR
grammar in docs/plans/chain-composition-surface.md §1.5 — no mocks, no CLI runner.
"""

import pytest

from h_cli.infrastructure.chain_expr import (
    ChainExpr,
    ExprError,
    Hop,
    HopConfig,
    effective_config,
    parse_expr,
)

# --- topology -------------------------------------------------------------------------------


def test_single_workflow_hop() -> None:
    expr = parse_expr(["-w", "feature-pr"])
    assert expr.stages == ((Hop(workflow="feature-pr"),),)


def test_template_group_collects_operands_until_next_flag() -> None:
    expr = parse_expr(["-t", "feature", "verify", "create-pr", "-w", "pr-review"])
    assert expr.stages == (
        (Hop(templates=("feature", "verify", "create-pr")),),
        (Hop(workflow="pr-review"),),
    )


def test_sequential_adjacency_orders_stages() -> None:
    expr = parse_expr(["-w", "a", "-w", "b", "-t", "x", "y"])
    assert [h.label for h in expr.hops] == ["a", "b", "x+y"]
    assert len(expr.stages) == 3


def test_parallel_joins_adjacent_hops_into_one_stage() -> None:
    expr = parse_expr(["-w", "lint", "--parallel", "-w", "typecheck", "-w", "report"])
    assert expr.stages == (
        (Hop(workflow="lint"), Hop(workflow="typecheck")),
        (Hop(workflow="report"),),
    )


def test_parallel_chains_into_a_three_way_group() -> None:
    expr = parse_expr(["-w", "a", "--parallel", "-w", "b", "--parallel", "-t", "c", "d"])
    assert len(expr.stages) == 1
    assert [h.label for h in expr.stages[0]] == ["a", "b", "c+d"]


def test_parallel_group_then_sequential_tail() -> None:
    expr = parse_expr(["-w", "a", "--parallel", "-w", "b", "-w", "c", "-w", "d"])
    assert [[h.label for h in stage] for stage in expr.stages] == [["a", "b"], ["c"], ["d"]]


# --- positional flag scoping ----------------------------------------------------------------


def test_suffix_flags_bind_to_the_hop_they_follow() -> None:
    expr = parse_expr(
        [
            "-t", "feature", "create-pr", "--agent", "claude", "--model", "opus",
            "-w", "pr-review", "--agent", "openhands", "--model", "deepseek", "--budget", "15m",
            "-w", "revise", "--fresh",
        ]
    )  # fmt: skip
    implement, review, revise = expr.hops
    assert implement.config == HopConfig(agent="claude", model="opus")
    assert review.config == HopConfig(agent="openhands", model="deepseek", budget="15m")
    assert revise.config == HopConfig(fresh=True)


def test_prefix_flags_set_chain_wide_defaults() -> None:
    expr = parse_expr(["--agent", "openhands", "--budget", "45m", "-w", "a", "-w", "b"])
    assert expr.defaults == HopConfig(agent="openhands", budget="45m")
    assert all(h.config == HopConfig() for h in expr.hops)


def test_effective_config_hop_overrides_default_field_by_field() -> None:
    defaults = HopConfig(agent="openhands", model="deepseek", budget="45m")
    hop = HopConfig(agent="claude", budget="15m")
    assert effective_config(defaults, hop) == HopConfig(
        agent="claude", model="deepseek", budget="15m"
    )


def test_effective_config_kind_never_inherits_from_defaults() -> None:
    assert effective_config(HopConfig(), HopConfig(kind="feature-pr")).kind == "feature-pr"
    assert effective_config(HopConfig(), HopConfig()).kind is None


def test_kind_binds_per_hop() -> None:
    expr = parse_expr(["-t", "feature", "create-pr", "--kind", "feature-pr"])
    assert expr.hops[0].config.kind == "feature-pr"


def test_flags_scope_across_a_parallel_connector() -> None:
    expr = parse_expr(["-w", "a", "--fresh", "--parallel", "-w", "b", "--agent", "claude"])
    ((a, b),) = expr.stages
    assert a.config == HopConfig(fresh=True)
    assert b.config == HopConfig(agent="claude")


# --- errors: every grammar violation is a clear ExprError ------------------------------------


@pytest.mark.parametrize(
    ("tokens", "fragment"),
    [
        ([], "at least one hop"),
        (["--agent", "x"], "at least one hop"),  # prefix defaults but no hops
        (["-w"], "-w needs a saved-workflow key"),
        (["-w", "--fresh"], "-w needs a saved-workflow key"),
        (["-t", "-w", "a"], "-t needs at least one template"),
        (["-t"], "-t needs at least one template"),
        (["--parallel", "-w", "a"], "infix connector"),
        (["-w", "a", "--parallel"], "infix connector"),
        (["-w", "a", "--parallel", "--parallel", "-w", "b"], "infix connector"),
        (["--agent", "x", "--parallel", "-w", "a", "-w", "b"], "infix connector"),
        (["-w", "a", "--agent"], "--agent needs a value"),
        (["-w", "a", "--budget", "-w"], "--budget needs a value"),
        (["-w", "a", "--budget", "soon"], "bad --budget"),
        (["--kind", "feature-pr", "-w", "a"], "per-hop only"),
        (["-w", "a", "--agent", "x", "--agent", "y"], "duplicate --agent"),
        (["-w", "a", "--fresh", "--fresh"], "duplicate --fresh"),
        (["--agent", "x", "--agent", "y", "-w", "a"], "duplicate --agent"),
        (["-w", "a", "--retry", "3"], "unknown token '--retry'"),
        (["-w", "a", "b"], "unexpected operand 'b'"),
        (["stray", "-w", "a"], "unexpected operand 'stray'"),
        (["-w", "a", "--parallel", "--agent", "x", "-w", "b"], "must follow a hop"),
    ],
)
def test_grammar_violations(tokens: list[str], fragment: str) -> None:
    with pytest.raises(ExprError, match=fragment):
        parse_expr(tokens)


def test_budget_accepts_minutes_hours_and_bare_ms() -> None:
    for raw in ("45m", "2h", "60000"):
        expr = parse_expr(["-w", "a", "--budget", raw])
        assert expr.hops[0].config.budget == raw


def test_hops_property_flattens_stages_in_order() -> None:
    expr = parse_expr(["-w", "a", "--parallel", "-w", "b", "-w", "c"])
    assert isinstance(expr, ChainExpr)
    assert [h.label for h in expr.hops] == ["a", "b", "c"]
