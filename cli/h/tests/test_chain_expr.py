"""The chain-expression parser's contract: grammar, positional scoping, and every error path.

parse_expr is pure (tokens in, structure out), so these tests are the full spec of the EXPR
grammar — no mocks, no CLI runner.
"""

import pytest

from h_cli.infrastructure.chain_expr import (
    BOOL_FLAGS,
    COMMAND_FLAGS,
    CONNECTOR,
    MAP_FLAGS,
    ROSTER_FLAGS,
    VALUE_FLAGS,
    WORKFLOW_INTRODUCERS,
    ChainExpr,
    ExprError,
    MemberRef,
    WorkflowConfig,
    effective_config,
    parse_expr,
)

# --- topology -------------------------------------------------------------------------------


def test_single_chain_member() -> None:
    expr = parse_expr(["-w", "implement-pr"])
    assert expr.stages == ((MemberRef(key="implement-pr"),),)


def test_template_group_collects_operands_until_next_flag() -> None:
    expr = parse_expr(["-t", "implement", "verify", "create-pr", "-w", "review-pr"])
    assert expr.stages == (
        (MemberRef(templates=("implement", "verify", "create-pr")),),
        (MemberRef(key="review-pr"),),
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
            "-w", "review-pr", "--agent", "openhands", "--model", "deepseek", "--budget", "15m",
            "-w", "revise-pr", "--fresh",
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
    # budget is excluded from chain-wide defaults merging (it has two distinct meanings by
    # position — see effective_config). A suffix budget stays on the member; a prefix budget
    # lives only on expr.defaults and is read directly at the budgetMs site in chain.py.
    defaults = WorkflowConfig(agents=("openhands",), model="deepseek")
    member = WorkflowConfig(agents=("claude",), budget="15m")
    assert effective_config(defaults, member) == WorkflowConfig(
        agents=("claude",), model="deepseek", budget="15m"
    )


def test_budget_does_not_inherit_from_chain_wide_defaults() -> None:
    """Prefix budget is chain wall-clock, suffix is member watch — they must not bleed."""
    defaults = WorkflowConfig(budget="1h")
    member = WorkflowConfig()
    assert effective_config(defaults, member).budget is None


def test_effective_config_kind_never_inherits_from_defaults() -> None:
    assert (
        effective_config(WorkflowConfig(), WorkflowConfig(kind="implement-pr")).kind
        == "implement-pr"
    )
    assert effective_config(WorkflowConfig(), WorkflowConfig()).kind is None


def test_kind_binds_per_member() -> None:
    expr = parse_expr(["-t", "implement", "create-pr", "--kind", "implement-pr"])
    assert expr.members[0].config.kind == "implement-pr"


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
        (["--kind", "implement-pr", "-w", "a"], "per-workflow only"),
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
            "implement-pr",
            "--capture",
            "prNumber=pr",
            "--capture",
            "prUrl=url",
            "-w",
            "review-pr",
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
        parse_expr(["--capture", "a=b", "-w", "implement-pr"])
    with pytest.raises(ExprError, match="per-workflow only"):
        parse_expr(["--until", "verdict=CLEAN", "-w", "implement-pr"])


def test_mapping_flags_validate_the_assignment_shape() -> None:
    with pytest.raises(ExprError, match="destination=source"):
        parse_expr(["-w", "implement-pr", "--capture", "justakey"])
    with pytest.raises(ExprError, match="PATH=VALUE"):
        parse_expr(["-w", "review-pr", "--until", "CLEAN"])


def test_duplicate_capture_destination_is_rejected() -> None:
    with pytest.raises(ExprError, match="duplicate --capture destination 'prNumber'"):
        parse_expr(["-w", "implement-pr", "--capture", "prNumber=pr", "--capture", "prNumber=url"])


# --- the --agent roster ---------------------------------


def test_agent_roster_collects_operands_until_next_flag() -> None:
    expr = parse_expr(
        ["-w", "review-pr", "--agent", "claude", "codex", "openhands", "--fresh", "-w", "revise-pr"]
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
        parse_expr(["--agent", "claude", "codex", "-w", "review-pr"])


# --- Phase-6 composition flags -----------------


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
            parse_expr([flag, value, "-w", "implement-pr"])


def test_stage_and_max_fires_reject_non_integers() -> None:
    with pytest.raises(ExprError, match="bad --stage"):
        parse_expr(["-w", "a", "--stage", "first"])
    with pytest.raises(ExprError, match="bad --max-fires"):
        parse_expr(["-w", "a", "--cron", "* * * * *", "--max-fires", "lots"])


def test_a_command_flag_typed_into_the_expression_says_where_it_belongs() -> None:
    # The papercut: --strategy after the `--` separator used to report only "unknown token",
    # listing every expression flag and leaving the reader to notice theirs wasn't among them.
    with pytest.raises(ExprError, match="is a command flag, not an expression flag"):
        parse_expr(["-w", "review-pr", "--strategy", "loop-until-clean"])
    with pytest.raises(ExprError, match="put it BEFORE the workflow list"):
        parse_expr(["-w", "review-pr", "--max-iterations", "5"])


def test_an_actually_unknown_flag_still_lists_the_grammar() -> None:
    with pytest.raises(ExprError, match="unknown token '--nope'"):
        parse_expr(["-w", "a", "--nope"])


def test_command_flags_and_expression_flags_are_disjoint() -> None:
    """click consumes a DECLARED option wherever it appears in argv, which would destroy the
    positional scoping the whole grammar rests on. The module docstring states this rule; this
    asserts it."""
    expression = {
        *WORKFLOW_INTRODUCERS,
        CONNECTOR,
        *ROSTER_FLAGS,
        *VALUE_FLAGS,
        *MAP_FLAGS,
        *BOOL_FLAGS,
    }
    assert expression & set(COMMAND_FLAGS) == set()


def test_command_flags_match_the_real_typer_command() -> None:
    """COMMAND_FLAGS is a copy of the Typer signature, so it can drift. Read the actual command
    and assert the two agree — adding a `h chain run` option without updating the list (or, worse,
    adding one that collides with an expression flag) fails here."""
    import click
    import typer.main

    from h_cli.commands.chain import app

    command = typer.main.get_command(app)
    run = command.commands["run"] if isinstance(command, click.Group) else command
    declared = {opt for param in run.params for opt in getattr(param, "opts", [])}
    declared -= {"--help"}
    assert declared == set(COMMAND_FLAGS)
