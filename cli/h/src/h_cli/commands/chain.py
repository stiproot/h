"""h chain — temporal composition: sequence workflows through the durable chain engine.

A chain is a registered policy the chain engine (workflow-svc) sequences on the cron tick,
mirroring the watcher engine. `h chain run` REGISTERS the chain and returns immediately — the
workflows run fire-and-forget and survive a closed laptop; `h chain list` inspects the durable
registry. State threads workflow-to-workflow IN THE ENGINE (it parses each workflow's
`===MARKER===` output into the chain's blackboard and builds the next workflow's params), so the
chained workflows stay chain-agnostic.

The workflow list is the chain EXPRESSION (docs/plans/chain-composition-surface.md §1.5),
hand-parsed from the tokens Typer doesn't consume (chain_expr.py — Typer must never declare the
EXPR flag names). Chain-identity flags (--slug/--spec/--issue/--strategy/--max-iterations) are
ordinary options; everything workflow-scoped is positional in the expression:

    EXPR    := FLAG* STAGE STAGE*         # FLAGs before the first workflow = chain-wide defaults
    STAGE   := WF ( --parallel WF )*      # infix; parallel groups need the Phase-5 engine
    WF      := ( -w KEY | -t ATOM ATOM... ) FLAG*
    FLAG    := --agent A | --model M | --budget DUR | --fresh | --kind K

A `-t` group composes-on-fire: the templates overlay into ONE workflow, published under the
chain-scoped key `<slug>-w<N>`. Identity flags become fire-time params (§1.9): --agent maps to
{runActivity, agentId}, --model to the workflow kind's model params.
"""

from typing import Annotated, Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

from h_cli.commands.feature import _resolve_spec
from h_cli.commands.template import compose_templates
from h_cli.config import AGENT_IDENTITY, agent_identity_params
from h_cli.infrastructure import workflow_svc
from h_cli.infrastructure.chain_expr import (
    ExprError,
    WorkflowConfig,
    WorkflowRef,
    effective_config,
    parse_expr,
)

app = typer.Typer(
    no_args_is_help=True, help="Chain workflows into a pipeline (temporal composition)."
)
console = Console()
err_console = Console(stderr=True)

PER_WORKFLOW_BUDGET_MS = 45 * 60_000
_BUDGET_UNITS = {"m": 60_000, "h": 3_600_000}

KNOWN_KINDS = ("feature-pr", "pr-review", "revise")
# Well-known -w names → (kind, key fired). `revise` is a workflow NAME, not a saved key: it
# re-fires the implement workflow's definition fresh (its key is rewritten after resolution).
WELL_KNOWN: dict[str, tuple[str, str]] = {
    "feature-pr": ("feature-pr", "feature-pr"),
    "pr-review": ("pr-review", "pr-review"),
    "revise": ("revise", "feature-pr"),
}
# kind → (instanceId prefix, fresh default). feature-pr and revise share the branch instance
# (feature-<slug>); revise re-runs it fresh.
KIND_FIRE: dict[str, tuple[str, bool]] = {
    "feature-pr": ("feature", False),
    "pr-review": ("pr-review", False),
    "revise": ("feature", True),
}
# kind → the model param slots its template exposes (--model sets them all).
KIND_MODEL_PARAMS: dict[str, tuple[str, ...]] = {
    "feature-pr": ("modelPlan", "modelImplement"),
    "revise": ("modelPlan", "modelImplement"),
    "pr-review": ("modelReview",),
}
# Untrusted-input executors are FROZEN: --agent warns and keeps the published executor
# (docs/plans/reviewer-identity-security.md — never an error, never silent compliance).
FROZEN_EXECUTOR_KINDS = {"pr-review"}
# -t group kind inference: the terminal atom's closing marker IS the threading contract.
TERMINAL_ATOM_KIND = {"create-pr": "feature-pr"}

DEFAULT_EXPR = ["-w", "feature-pr", "-w", "pr-review", "-w", "revise"]


def _fail(message: str) -> None:
    err_console.print(f"[red]{message}[/red]")
    raise typer.Exit(1)


def _warn(message: str) -> None:
    err_console.print(f"[yellow]warning:[/yellow] {message}")


def _guarded(fn: Any) -> Any:
    try:
        return fn()
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {err}")
        err_console.print("Is workflow-svc running, and are the chained workflows published?")
        raise typer.Exit(1) from err


def _budget_ms(raw: str) -> int:
    """A validated budget token (chain_expr enforced the format) → milliseconds."""
    unit = _BUDGET_UNITS.get(raw[-1:], 1)
    digits = raw[:-1] if raw[-1:] in _BUDGET_UNITS else raw
    return int(digits) * unit


def _identity_params(kind: str, cfg: WorkflowConfig, label: str) -> dict[str, str]:
    """FLAG identity → the fire-time params the workflow's template consumes (§1.9)."""
    params: dict[str, str] = {}
    if cfg.agent:
        if kind in FROZEN_EXECUTOR_KINDS:
            _warn(
                f"--agent '{cfg.agent}' ignored on '{label}': the {kind} executor is frozen "
                "(untrusted-input security invariant — docs/plans/reviewer-identity-security.md); "
                "keeping the published executor"
            )
        else:
            identity = agent_identity_params(cfg.agent)
            if identity is None:
                _fail(
                    f"unknown --agent '{cfg.agent}' — known: "
                    + ", ".join(sorted(set(AGENT_IDENTITY)))
                )
                raise AssertionError("unreachable")
            params.update(identity)
    if cfg.model:
        for name in KIND_MODEL_PARAMS[kind]:
            params[name] = cfg.model
    return params


def _check_identity_slots(key: str, cfg: WorkflowConfig, kind: str) -> None:
    """A saved workflow published before fire-time identity has no param slots — fail loud on
    --agent (it would silently fire the baked identity), warn on --model (accepted limitation)."""
    stored = _guarded(lambda: workflow_svc.get(key))
    defaults = stored.get("params") or {}
    if cfg.agent and kind not in FROZEN_EXECUTOR_KINDS and "runActivity" not in defaults:
        _fail(
            f"saved workflow '{key}' has no identity param slots (published before fire-time "
            f"identity) — republish it (`h template compose ... --save {key}` or "
            f"`h workflow publish`) to make --agent work"
        )
    if cfg.model:
        missing = [name for name in KIND_MODEL_PARAMS[kind] if name not in defaults]
        if missing:
            _warn(
                f"'{key}' has no {'/'.join(missing)} slot(s) — --model may be ignored "
                "(publish with model defaults in values to open the slots)"
            )


def _resolve_workflow(
    workflow: WorkflowRef, cfg: WorkflowConfig, slug: str, index: int
) -> dict[str, Any]:
    """A parsed workflow → the engine's ChainWorkflow {kind, key, instanceId, fresh, params?}."""
    if workflow.key:
        if workflow.key in WELL_KNOWN and not cfg.kind:
            kind, key = WELL_KNOWN[workflow.key]
        else:
            key = workflow.key
            if cfg.kind is None:
                _fail(
                    f"-w '{workflow.key}' is not a well-known workflow name "
                    f"({', '.join(WELL_KNOWN)}) — follow it with --kind "
                    f"(one of: {', '.join(KNOWN_KINDS)}) so the engine knows its threading "
                    "contract"
                )
            kind = cfg.kind or ""
    else:
        inferred = cfg.kind or TERMINAL_ATOM_KIND.get(workflow.templates[-1])
        if inferred is None:
            _fail(
                f"cannot infer the workflow kind for `-t {' '.join(workflow.templates)}` — "
                "end the group with create-pr (its ===PR=== marker is the feature-pr contract) "
                "or pass --kind"
            )
        kind = inferred or ""
        key = f"{slug}-w{index}"
    if kind not in KNOWN_KINDS:
        _fail(f"unknown --kind '{kind}' — known: {', '.join(KNOWN_KINDS)}")

    params = _identity_params(kind, cfg, workflow.label)
    if workflow.key is None:
        # Compose-on-fire: overlay the group's templates into one definition and publish it under
        # the chain-scoped key (idempotent — re-firing the chain republishes the same key).
        merged = compose_templates(list(workflow.templates))
        _guarded(lambda: workflow_svc.save(key, merged["steps"], params=merged.get("params")))
        console.print(f"==> composed [{' ⊕ '.join(workflow.templates)}] published as '{key}'")
    elif params:
        _check_identity_slots(key, cfg, kind)
    if cfg.budget:
        _warn(
            f"per-workflow --budget on '{workflow.label}' is not yet enforced "
            "(per-workflow watch lands with the engine's next slice); ignored"
        )

    prefix, fresh_default = KIND_FIRE[kind]
    entry: dict[str, Any] = {
        "kind": kind,
        "key": key,
        "instanceId": f"{prefix}-{slug}",
        "fresh": cfg.fresh or fresh_default,
    }
    if params:
        entry["params"] = params
    return entry


@app.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def run(
    ctx: typer.Context,
    slug: Annotated[
        str | None,
        typer.Option(help="Chain slug — the branch token (feature/<slug>) and chain id."),
    ] = None,
    spec: Annotated[
        str | None,
        typer.Option(help="Feature spec: a .md path, or a bare name under the spec home."),
    ] = None,
    issue: Annotated[
        int | None, typer.Option("--issue", help="GitHub issue this chain implements (Closes #N).")
    ] = None,
    strategy: Annotated[
        str,
        typer.Option(
            help="Chain strategy: 'sequential' (run the workflows once) or 'loop-until-clean' "
            "(repeat pr-review→revise until the review is CLEAN or --max-iterations)."
        ),
    ] = "sequential",
    max_iterations: Annotated[
        int,
        typer.Option(
            "--max-iterations",
            help="loop-until-clean only: cap on review→revise cycles before the chain finalizes.",
        ),
    ] = 3,
) -> None:
    """Register a chain with the durable engine; it sequences the workflows fire-and-forget.

    The workflow list is the chain EXPRESSION — everything after the chain-identity flags:

      -w KEY            fire this saved workflow (well-known names: feature-pr, pr-review, revise)

      -t ATOM ATOM...   overlay these templates into ONE workflow (composed and published on fire)

      --agent A --model M --budget DUR --fresh --kind K   bind to the workflow they FOLLOW;
                        before the first workflow they set chain-wide defaults (a prefix --budget is
                        the whole-chain wall clock: <n>m, <n>h, or milliseconds)

      --parallel        joins adjacent workflows into a parallel group (needs the Phase-5 engine)

    Default expression: -w feature-pr -w pr-review -w revise (a feature to a reviewed PR).
    Example:  h chain run --slug dark-mode --spec dark-mode.md \\
                  -t feature verify create-pr --agent claude \\
                  -w pr-review --model deepseek  -w revise --fresh
    """
    if strategy not in ("sequential", "loop-until-clean"):
        _fail(
            f"strategy '{strategy}' not implemented — 'sequential' or 'loop-until-clean' "
            "(parallel is deferred until a multi-reviewer chain needs it)."
        )
    if not slug or not spec:
        _fail("--slug and --spec are required")
        raise AssertionError("unreachable")

    tokens = list(ctx.args)
    if not any(token in ("-w", "-t") for token in tokens):
        tokens += DEFAULT_EXPR  # bare prefix flags (e.g. a chain budget) keep the default chain
    try:
        expr = parse_expr(tokens)
    except ExprError as err:
        _fail(str(err))
        raise AssertionError("unreachable")
    for stage in expr.stages:
        if len(stage) > 1:
            _fail(
                "--parallel groups need the 'parallel' chain strategy, which is not in the "
                "engine yet (workflow-composition Phase 5) — sequence the workflows for now."
            )

    spec_text = _resolve_spec(spec).read_text()
    workflows: list[dict[str, Any]] = []
    for index, workflow in enumerate(expr.workflows):
        cfg = effective_config(expr.defaults, workflow.config)
        workflows.append(_resolve_workflow(workflow, cfg, slug, index))
    # A revise workflow re-fires the implement workflow's INSTANCE, so it must fire that same
    # definition — including a composed-on-fire derived key, not just the published 'feature-pr'.
    implement_key = next(
        (entry["key"] for entry in workflows if entry["kind"] == "feature-pr"), None
    )
    if implement_key:
        for entry in workflows:
            if entry["kind"] == "revise":
                entry["key"] = implement_key

    data: dict[str, Any] = {"slug": slug, "spec": spec_text}
    if issue is not None:
        data["issueNumber"] = str(issue)
    body: dict[str, Any] = {
        "slug": slug,
        "workflows": workflows,
        "data": data,
        "strategy": strategy,
    }
    chain_budget = expr.defaults.budget
    body["budgetMs"] = (
        _budget_ms(chain_budget) if chain_budget else len(workflows) * PER_WORKFLOW_BUDGET_MS
    )

    if strategy == "loop-until-clean":
        # The loop body is pr-review→revise: the review workflow is the predicate (CLEAN stops the
        # loop), and the last workflow loops back to it. Require both, in order.
        kinds = [entry["kind"] for entry in workflows]
        if "pr-review" not in kinds:
            _fail("loop-until-clean needs a 'pr-review' workflow (the predicate).")
        start = kinds.index("pr-review")
        if start >= len(workflows) - 1:
            _fail("loop-until-clean needs a workflow after 'pr-review' (e.g. 'revise') to loop.")
        body["loop"] = {"startCursor": start, "maxIterations": max_iterations}

    result = _guarded(lambda: workflow_svc.chain_run(body))

    labels = [workflow.label for workflow in expr.workflows]
    console.print(
        f"==> chain '{result['chainId']}' registered [{' -> '.join(labels)}] "
        f"(branch feature/{slug}, strategy={strategy})"
    )
    console.print("    the chain engine sequences the workflows on the cron tick; non-blocking.")
    console.print(f"    watch it: h chain list  (or h workflow status feature-{slug})")
    console.print_json(data=result)


@app.command("list")
def list_() -> None:
    """List registered chains + the scan heartbeat (the durable chain registry)."""
    try:
        result = workflow_svc.chain_list()
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {err}")
        err_console.print("Is workflow-svc running? (make dev-tab)")
        raise typer.Exit(1) from err
    chains = result.get("chains", [])
    table = Table("chain", "status", "workflow", "outcome", title=f"chains ({len(chains)})")
    for c in chains:
        workflows = c.get("workflows", [])
        cursor = c.get("cursor", 0)
        kind = workflows[cursor]["kind"] if 0 <= cursor < len(workflows) else "-"
        table.add_row(
            c.get("chainId", ""),
            c.get("status", ""),
            f"{cursor + 1}/{len(workflows)} ({kind})",
            c.get("outcome") or "-",
        )
    console.print(table)
    heartbeat = result.get("heartbeat")
    if heartbeat:
        console.print(
            f"[dim]scan heartbeat: {heartbeat.get('at')} (enabled={heartbeat.get('enabled')})[/dim]"
        )
