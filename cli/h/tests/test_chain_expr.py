"""The chain-expression parser's contract: grammar, positional scoping, and every error path.

parse_expr is pure (tokens in, structure out), so these tests are the full spec of the EXPR
grammar in docs/plans/chain-composition-surface.md §1.5 — no mocks, no CLI runner.
"""

import pytest

from h_cli.infrastructure.chain_expr import (
    ChainExpr,
    ExprError,
    MemberRef,
    WorkflowConfig,
    effective_config,
    parse_expr,
)

# --- topology -------------------------------------------------------------------------------


def test_single_chain_member() -> None:
    expr = parse_expr(["-w", "feature-pr"])
    assert expr.stages == ((MemberRef(key="feature-pr"),),)


def test_template_group_collects_operands_until_next_flag() -> None:
    expr = parse_expr(["-t", "implement", "verify", "create-pr", "-w", "pr-review"])
    assert expr.stages == (
        (MemberRef(templates=("implement", "verify", "create-pr")),),
        (MemberRef(key="pr-review"),),
    )


def test_sequential_adjacency_orders_stages() -> None:
    expr = parse_expr(["-w", "a", "-w", "b", "-t", "x", "y"])
    assert [member.label for member in expr.members] == ["a", "b", "x+y"]
    assert len(expr.stages) == 3


def test_parallel_joins_adjacent_members_into_one_stage() -> None:
    expr = parse_expr(["-w", "lint", "--parallel", "-w", "typecheck", "-w", "report"])
    assert expr.stages == (
        (MemberRef(key="lint"), MemberRef(key="typecheck")),
        (MemberRef(key="report"),),
    )


def test_parallel_chains_into_a_three_way_group() -> None:
    expr = parse_expr(["-w", "a", "--parallel", "-w", "b", "--parallel", "-t", "c", "d"])
    assert len(expr.stages) == 1
    assert [member.label for member in expr.stages[0]] == ["a", "b", "c+d"]


def test_parallel_group_then_sequential_tail() -> None:
    expr = parse_expr(["-w", "a", "--parallel", "-w", "b", "-w", "c", "-w", "d"])
    assert [[member.label for member in stage] for stage in expr.stages] == [
        ["a", "b"],
        ["c"],
        ["d"],
    ]


# --- positional flag scoping ----------------------------------------------------------------


def test_suffix_flags_bind_to_the_member_they_follow() -> None:
    expr = parse_expr(
        [
            "-t", "implement", "create-pr", "--agent", "claude", "--model", "opus",
            "-w", "pr-review", "--agent", "openhands", "--model", "deepseek", "--budget", "15m",
            "-w", "revise", "--fresh",
        ]
    )  # fmt: skip
    implement, review, revise = expr.members
    assert implement.config == WorkflowConfig(agents=("claude",), model="opus")
    assert review.config == WorkflowConfig(agents=("openhands",), model="deepseek", budget="15m")
    assert revise.config == WorkflowConfig(fresh=True)


def test_prefix_flags_set_chain_wide_defaults() -> None:
    expr = parse_expr(["--agent", "openhands", "--budget", "45m", "-w", "a", "-w", "b"])
    assert expr.defaults == WorkflowConfig(agents=("openhands",), budget="45m")
    assert all(member.config == WorkflowConfig() for member in expr.members)


def test_effective_config_member_overrides_default_field_by_field() -> None:
    defaults = WorkflowConfig(agents=("openhands",), model="deepseek", budget="45m")
    member = WorkflowConfig(agents=("claude",), budget="15m")
    assert effective_config(defaults, member) == WorkflowConfig(
        agents=("claude",), model="deepseek", budget="15m"
    )


def test_effective_config_kind_never_inherits_from_defaults() -> None:
    assert (
        effective_config(WorkflowConfig(), WorkflowConfig(kind="feature-pr")).kind == "feature-pr"
    )
    assert effective_config(WorkflowConfig(), WorkflowConfig()).kind is None


def test_kind_binds_per_member() -> None:
    expr = parse_expr(["-t", "implement", "create-pr", "--kind", "feature-pr"])
    assert expr.members[0].config.kind == "feature-pr"


def test_flags_scope_across_a_parallel_connector() -> None:
    expr = parse_expr(["-w", "a", "--fresh", "--parallel", "-w", "b", "--agent", "claude"])
    ((a, b),) = expr.stages
    assert a.config == WorkflowConfig(fresh=True)
    assert b.config == WorkflowConfig(agents=("claude",))


# --- errors: every grammar violation is a clear ExprError ------------------------------------


@pytest.mark.parametrize(
    ("tokens", "fragment"),
    [
        ([], "at least one workflow"),
        (["--agent", "x"], "at least one workflow"),  # prefix defaults but no workflows
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
        (["--kind", "feature-pr", "-w", "a"], "per-workflow only"),
        (["-w", "a", "--agent", "x", "--agent", "y"], "duplicate --agent"),
        (["-w", "a", "--fresh", "--fresh"], "duplicate --fresh"),
        (["--agent", "x", "--agent", "y", "-w", "a"], "duplicate --agent"),
        (["-w", "a", "--retry", "3"], "unknown token '--retry'"),
        (["-w", "a", "b"], "unexpected operand 'b'"),
        (["stray", "-w", "a"], "unexpected operand 'stray'"),
        (["-w", "a", "--parallel", "--agent", "x", "-w", "b"], "must follow a workflow"),
    ],
)
def test_grammar_violations(tokens: list[str], fragment: str) -> None:
    with pytest.raises(ExprError, match=fragment):
        parse_expr(tokens)


def test_budget_accepts_minutes_hours_and_bare_ms() -> None:
    for raw in ("45m", "2h", "60000"):
        expr = parse_expr(["-w", "a", "--budget", raw])
        assert expr.members[0].config.budget == raw


def test_members_property_flattens_stages_in_order() -> None:
    expr = parse_expr(["-w", "a", "--parallel", "-w", "b", "-w", "c"])
    assert isinstance(expr, ChainExpr)
    assert [member.label for member in expr.members] == ["a", "b", "c"]


def test_capture_and_input_accumulate_per_workflow() -> None:
    expr = parse_expr(
        # fmt: off
        [
            "-w",
            "feature-pr",
            "--capture",
            "prNumber=pr",
            "--capture",
            "prUrl=url",
            "-w",
            "pr-review",
            "--input",
            "pr=prNumber",
            "--until",
            "verdict=CLEAN",
        ]
        # fmt: on
    )
    first, second = expr.members
    assert first.config.captures == (("prNumber", "pr"), ("prUrl", "url"))
    assert second.config.inputs == (("pr", "prNumber"),)
    assert second.config.until == "verdict=CLEAN"


def test_mapping_flags_are_per_workflow_only() -> None:
    with pytest.raises(ExprError, match="per-workflow only"):
        parse_expr(["--capture", "a=b", "-w", "feature-pr"])
    with pytest.raises(ExprError, match="per-workflow only"):
        parse_expr(["--until", "verdict=CLEAN", "-w", "feature-pr"])


def test_mapping_flags_validate_the_assignment_shape() -> None:
    with pytest.raises(ExprError, match="destination=source"):
        parse_expr(["-w", "feature-pr", "--capture", "justakey"])
    with pytest.raises(ExprError, match="PATH=VALUE"):
        parse_expr(["-w", "pr-review", "--until", "CLEAN"])


def test_duplicate_capture_destination_is_rejected() -> None:
    with pytest.raises(ExprError, match="duplicate --capture destination 'prNumber'"):
        parse_expr(["-w", "feature-pr", "--capture", "prNumber=pr", "--capture", "prNumber=url"])


# --- the --agent roster (docs/plans/panels-as-a-modifier.md) ---------------------------------


def test_agent_roster_collects_operands_until_next_flag() -> None:
    expr = parse_expr(
        ["-w", "pr-review", "--agent", "claude", "codex", "openhands", "--fresh", "-w", "revise"]
    )
    review, revise = expr.members
    assert review.config.agents == ("claude", "codex", "openhands")
    assert review.config.fresh is True
    assert revise.config == WorkflowConfig()


def test_single_agent_stays_a_one_tuple() -> None:
    expr = parse_expr(["-w", "a", "--agent", "codex"])
    assert expr.members[0].config.agents == ("codex",)


def test_effective_config_roster_overrides_default_wholesale() -> None:
    defaults = WorkflowConfig(agents=("openhands",))
    member = WorkflowConfig(agents=("claude", "codex"))
    assert effective_config(defaults, member).agents == ("claude", "codex")
    assert effective_config(defaults, WorkflowConfig()).agents == ("openhands",)


def test_agent_roster_is_per_workflow_only_in_the_prefix() -> None:
    with pytest.raises(ExprError, match="roster is per-workflow only"):
        parse_expr(["--agent", "claude", "codex", "-w", "pr-review"])


# --- Phase-6 composition flags (docs/plans/inline-chain-cron-composition.md) -----------------


def test_stage_cron_max_fires_id_bind_per_workflow() -> None:
    expr = parse_expr(
        # fmt: off
        [
            "-t",
            "gather",
            "--stage",
            "0",
            "--cron",
            "*/30 * * * *",
            "--max-fires",
            "20",
            "--id",
            "metrics",
            "--inline",
        ]
        # fmt: on
    )
    cfg = expr.members[0].config
    assert cfg.stage == "0"
    assert cfg.cron == "*/30 * * * *"
    assert cfg.max_fires == "20"
    assert cfg.id == "metrics"
    assert cfg.inline is True


def test_inline_may_be_a_chain_wide_default() -> None:
    expr = parse_expr(["--inline", "-t", "a", "-t", "b"])
    assert expr.defaults.inline is True
    assert all(effective_config(expr.defaults, member.config).inline for member in expr.members)


def test_stage_cron_max_fires_id_are_per_workflow_only() -> None:
    for flag, value in (("--stage", "0"), ("--cron", "* * * * *"), ("--id", "x")):
        with pytest.raises(ExprError, match="per-workflow only"):
            parse_expr([flag, value, "-w", "feature-pr"])


def test_stage_and_max_fires_reject_non_integers() -> None:
    with pytest.raises(ExprError, match="bad --stage"):
        parse_expr(["-w", "a", "--stage", "first"])
    with pytest.raises(ExprError, match="bad --max-fires"):
        parse_expr(["-w", "a", "--cron", "* * * * *", "--max-fires", "lots"])
