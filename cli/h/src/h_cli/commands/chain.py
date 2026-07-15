"""h chain — temporal composition: sequence workflows through the durable chain engine.

A chain is a registered policy the chain engine (workflow-svc) sequences on the cron tick,
mirroring the watcher engine. `h chain run` REGISTERS the chain and returns immediately — the
workflows run fire-and-forget and survive a closed laptop; `h chain list` inspects the durable
registry. State threads workflow-to-workflow IN THE ENGINE (it reads each workflow's validated
structured output — docs/plans/structured-workflow-outputs.md — into the chain's blackboard and
builds the next workflow's params), so the chained workflows stay chain-agnostic.

The workflow list is the chain EXPRESSION (docs/plans/chain-composition-surface.md §1.5),
hand-parsed from the tokens Typer doesn't consume (chain_expr.py — Typer must never declare the
EXPR flag names). Chain-level flags (--slug/--strategy/--max-iterations) and value hydration
(`-p key=value`, seeding the shared data) are ordinary Typer options — Typer consumes them
wherever they sit; everything workflow-scoped is positional in the expression:

    EXPR    := FLAG* STAGE STAGE*         # FLAGs before the first workflow = chain-wide defaults
    STAGE   := WF ( --parallel WF )*      # infix; parallel groups need the Phase-5 engine
    WF      := ( -w KEY | -t ATOM ATOM... ) FLAG*
    FLAG    := --agent A | --model M | --budget DUR | --fresh | --kind K
             | --capture DEST=SRC | --input DEST=SRC | --until PATH=VALUE

A `-t` group composes-on-fire: the templates overlay into ONE workflow, published under the
chain-scoped key `<slug>-w<N>`. Identity flags become fire-time params (§1.9): --agent maps to
{runActivity, agentId}, --model to the workflow kind's model params.
"""

from typing import Annotated, Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

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
from h_cli.params import parse_params

app = typer.Typer(
    no_args_is_help=True, help="Chain workflows into a pipeline (temporal composition)."
)
console = Console()
err_console = Console(stderr=True)

PER_WORKFLOW_BUDGET_MS = 45 * 60_000
_BUDGET_UNITS = {"m": 60_000, "h": 3_600_000}

KNOWN_KINDS = ("feature-pr", "pr-review", "revise")
# Well-known -w names → (kind, saved key fired). Each is a first-class standalone workflow with its
# own saved definition — `revise` fires the `revise` template (which reads the PR's review threads
# itself), no longer a re-fire of feature-pr's definition.
WELL_KNOWN: dict[str, tuple[str, str]] = {
    "feature-pr": ("feature-pr", "feature-pr"),
    "pr-review": ("pr-review", "pr-review"),
    "revise": ("revise", "revise"),
}
# kind → (instanceId prefix, fresh default). feature-pr and revise share the branch instance
# (feature-<slug>) — they operate on the same branch; revise re-runs it fresh.
KIND_FIRE: dict[str, tuple[str, bool]] = {
    "feature-pr": ("feature", False),
    "pr-review": ("pr-review", False),
    "revise": ("feature", True),
}
# kind → the model param slots its template exposes (--model sets them all).
KIND_MODEL_PARAMS: dict[str, tuple[str, ...]] = {
    "feature-pr": ("modelPlan", "modelImplement"),
    "revise": ("modelRevise",),
    "pr-review": ("modelReview",),
}
# Untrusted-input executors are FROZEN: --agent warns and keeps the published executor
# (docs/plans/reviewer-identity-security.md — never an error, never silent compliance).
FROZEN_EXECUTOR_KINDS = {"pr-review"}
# -t group kind inference: the terminal atom's declared output contract IS the threading contract.
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


def _check_output_mappings(
    entry: dict[str, Any], declared: dict[str, Any] | None, label: str
) -> None:
    """Registration-time validation (structured-workflow-outputs §1, consumer 3): every --capture
    source field and the --until path must exist in the workflow's declared outputs schema, so a
    broken thread fails HERE, not mid-chain. --input maps blackboard keys (dynamic) — not
    checkable."""
    refs = list((entry.get("captures") or {}).values())
    if entry.get("until"):
        refs.append(entry["until"]["path"])
    if not refs:
        return
    if not isinstance(declared, dict) or not declared:
        _fail(
            f"'{label}' uses --capture/--until but its workflow declares no outputs schema — "
            "republish the template with an outputs declaration (structured-workflow-outputs plan)"
        )
        raise AssertionError("unreachable")
    properties = declared.get("properties")
    known = sorted(properties) if isinstance(properties, dict) else []
    missing = [ref for ref in refs if ref.split(".")[0] not in known]
    if missing:
        _fail(
            f"'{label}': the declared outputs schema has no field(s) {', '.join(missing)} — "
            f"declared: {', '.join(known) or '(none)'}"
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
                "end the group with create-pr (its structured pr output is the feature-pr "
                "contract) "
                "or pass --kind"
            )
        kind = inferred or ""
        key = f"{slug}-w{index}"
    if kind not in KNOWN_KINDS:
        _fail(f"unknown --kind '{kind}' — known: {', '.join(KNOWN_KINDS)}")

    params = _identity_params(kind, cfg, workflow.label)
    declared_outputs: dict[str, Any] | None = None
    if workflow.key is None:
        # Compose-on-fire: overlay the group's templates into one definition and publish it under
        # the chain-scoped key (idempotent — re-firing the chain republishes the same key).
        merged = compose_templates(list(workflow.templates))
        declared_outputs = merged.get("outputs")
        _guarded(
            lambda: workflow_svc.save(
                key, merged["steps"], params=merged.get("params"), outputs=declared_outputs
            )
        )
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
    # Structured-output mappings (structured-workflow-outputs §4): each declared half replaces its
    # side of the kind's coded contract in the engine; validated against the workflow's declared
    # outputs schema at registration so a broken thread never fires.
    if cfg.captures:
        entry["captures"] = dict(cfg.captures)
    if cfg.inputs:
        entry["inputs"] = dict(cfg.inputs)
    if cfg.until:
        path, _, expected = cfg.until.partition("=")
        entry["until"] = {"path": path, "equals": expected}
    if entry.get("captures") or entry.get("until"):
        if declared_outputs is None and workflow.key is not None:
            stored = _guarded(lambda: workflow_svc.get(key))
            declared_outputs = stored.get("outputs") if isinstance(stored, dict) else None
        _check_output_mappings(entry, declared_outputs, workflow.label)
    return entry


@app.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def run(
    ctx: typer.Context,
    slug: Annotated[
        str | None,
        typer.Option(help="Chain slug — the branch token (feature/<slug>) and chain id."),
    ] = None,
    param: Annotated[
        list[str] | None,
        typer.Option(
            "--param",
            "-p",
            help="Template value key=value that hydrates the chain (seeds the shared data "
            "threaded to every workflow); '@path' splices a file, e.g. -p spec=@s.md -p "
            "issueNumber=24. Content values ride -p; flags are machinery.",
        ),
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

      --capture BB=FIELD --input PARAM=BB --until PATH=VALUE   structured-output threading for
                        the workflow they follow (per-workflow only): capture a declared output
                        FIELD onto blackboard key BB; feed blackboard key BB in as PARAM; stop a
                        loop when the structured field at PATH equals VALUE. Validated against the
                        workflow's declared outputs schema at registration.

      --parallel        joins adjacent workflows into a parallel group (needs the Phase-5 engine)

    Template VALUES ride `-p key=value` (hydrating inline, uniform with `h workflow run`);
    `-t` hydrates STRUCTURE, `-p` hydrates values, the rest is machinery.

    Default expression: -w feature-pr -w pr-review -w revise (a feature to a reviewed PR).
    Example:  h chain run --slug dark-mode -p spec=@dark-mode.md \\
                  -t feature verify create-pr --agent claude \\
                  -w pr-review --model deepseek  -w revise --fresh
    """
    if strategy not in ("sequential", "loop-until-clean"):
        _fail(
            f"strategy '{strategy}' not implemented — 'sequential' or 'loop-until-clean' "
            "(parallel is deferred until a multi-reviewer chain needs it)."
        )
    if not slug:
        _fail("--slug is required")
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

    workflows: list[dict[str, Any]] = []
    for index, workflow in enumerate(expr.workflows):
        cfg = effective_config(expr.defaults, workflow.config)
        workflows.append(_resolve_workflow(workflow, cfg, slug, index))
    # Chain-level -p values seed the shared data blackboard, threaded to every workflow. slug is the
    # chain's identity; the engine threads durable refs (e.g. the PR number) to revise, which reads
    # the review itself. Each workflow fires its own saved definition — no key rewriting.
    data: dict[str, Any] = {"slug": slug, **parse_params(param or [])}
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
