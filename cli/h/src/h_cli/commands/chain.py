"""h chain — temporal composition: sequence workflows through the durable chain engine.

A chain is a registered policy the chain engine (workflow-svc) sequences on the cron tick,
mirroring the watcher engine. `h chain run` REGISTERS the chain and returns immediately — the
workflows run fire-and-forget and survive a closed laptop; `h chain list` inspects the durable
registry. State threads workflow-to-workflow IN THE ENGINE (it reads each workflow's validated
structured output — into the chain's chain data and
builds the next workflow's params), so the chained workflows stay chain-agnostic.

The workflow list is the chain EXPRESSION,
hand-parsed from the tokens Typer doesn't consume (chain_expr.py — Typer must never declare the
EXPR flag names). Chain-level flags (--slug/--strategy/--max-iterations) and value hydration
(`-p key=value`, seeding the shared data) are ordinary Typer options — Typer consumes them
wherever they sit; everything workflow-scoped is positional in the expression:

    EXPR    := FLAG* STAGE STAGE*         # FLAGs before the first workflow = chain-wide defaults
    STAGE   := WF ( --parallel WF )*      # infix --parallel joins WFs into ONE concurrent stage
    WF      := ( -w KEY | -t ATOM ATOM... ) FLAG*
    FLAG    := --agent A A* | --model M | --budget DUR | --fresh | --inline | --kind K
             | --stage N | --cron CADENCE | --max-fires N | --id NAME
             | --capture DEST=SRC | --input DEST=SRC | --until PATH=VALUE

A `-t` group composes-on-fire: the templates overlay into ONE workflow, published under the
chain-scoped key `<slug>-w<N>` by default, or EMBEDDED in the chain row with `--inline` (D1).
Concurrency is stages: --parallel
(or an explicit --stage N) groups members into one concurrent stage the engine joins
before advancing. A `--cron`
member self-arms a recurrence (forces inline) the chain only OBSERVES via wf:resolved (D2/D4);
`--id` gives a member a chain data namespace so a downstream reads its capture via a dotted
`--input PARAM=id.field` (D5). Identity flags become fire-time params (§1.9): --agent maps to
{runActivity, agentId}, --model to the workflow kind's model params.

`--agent` with SEVERAL names is a panel ROSTER: the member
is panelized — its contract-carrying step is replicated into a parallel step group, one branch
per roster agent, and a pinned judge synthesizes under the member's own contract, so every seam
downstream (loop-until-clean, captures, the watcher) is unchanged. A roster forces
compose-on-fire (a -w key renders its chart template, or falls back to the stored definition);
write kinds (implement-pr, revise) reject a roster — N writers can't share one branch — use
--parallel stage composition for those.
"""

from collections import Counter
from pathlib import Path
from typing import Annotated, Any

import httpx
import typer
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from h_cli.commands._local_journal import journal_preflight as _journal_preflight
from h_cli.commands.template import compose_templates, template_name_for_key, template_role
from h_cli.commands.workflow import LOCAL_STEP_TIMEOUT_MS
from h_cli.config import (
    AGENT_IDENTITY,
    AGENT_RUNS_DIR,
    LOCAL_WORKTREES_DIR,
    agent_identity_params,
    baked_models_suit,
    chart_root_for,
)
from h_cli.infrastructure import local_runtime, workflow_svc
from h_cli.infrastructure.chain_expr import (
    ExprError,
    MemberRef,
    WorkflowConfig,
    effective_config,
    parse_expr,
)
from h_cli.infrastructure.local_runtime import LocalRunError, group_id, repo_root
from h_cli.infrastructure.panelize import PanelizeError, panelize, roster_pairs
from h_cli.params import parse_params

# The ChainMember fields the local substrate understands. Everything else on a registered member
# is engine machinery — `key` (a store to resolve), `instanceId`/`fresh` (Dapr instance mechanics),
# `cron` (a recurrence with no engine here) — and is dropped rather than silently ignored.
_LOCAL_MEMBER_FIELDS = frozenset(
    {"kind", "steps", "params", "stage", "id", "captures", "inputs", "until"}
)

app = typer.Typer(
    no_args_is_help=True, help="Chain workflows into a pipeline (temporal composition)."
)
console = Console()
err_console = Console(stderr=True)

PER_WORKFLOW_BUDGET_MS = 45 * 60_000
_BUDGET_RE_LOCAL = __import__("re").compile(r"^\d+[mh]?$")
_BUDGET_UNITS = {"m": 60_000, "h": 3_600_000}

KNOWN_KINDS = ("implement-pr", "review-pr", "revise-pr", "answer")
# Well-known -w names → (kind, saved key fired). Each is a first-class standalone workflow with its
# own saved definition — `revise-pr` fires the `revise-pr` template (which reads the PR's
# review threads itself), no longer a re-fire of implement-pr's definition. `answer` is the
# bare "answer this task" member (the panelizable degenerate case,
# panels-as-a-modifier — successor of the
# retired agent-panel): reads `task` off the chain data, captures `answer`; an --agent roster
# panelizes it at fire time. Coded threading contracts live in
# workflow-svc/domain/chain-members.ts (a novel kind is added on both sides, per chain.model.ts).
WELL_KNOWN: dict[str, tuple[str, str]] = {
    "implement-pr": ("implement-pr", "implement-pr"),
    "review-pr": ("review-pr", "review-pr"),
    "revise-pr": ("revise-pr", "revise-pr"),
    "answer": ("answer", "answer"),
}
# kind → (instanceId prefix, fresh default). implement-pr and revise share the branch instance
# (feature-<slug>) — they operate on the same branch; revise re-runs it fresh. answer cuts no
# branch; its prefix only names a LONE sequential member's instance (a parallel member's instance
# is engine-derived, <chainId>-w<index>), and it re-runs fresh so each chain gets a fresh answer.
KIND_FIRE: dict[str, tuple[str, bool]] = {
    "implement-pr": ("implement", False),
    "review-pr": ("review-pr", False),
    "revise-pr": ("implement", True),
    "answer": ("answer", True),
}
# kind → the model param slots its template exposes (--model sets them all).
KIND_MODEL_PARAMS: dict[str, tuple[str, ...]] = {
    "implement-pr": ("modelPlan", "modelImplement"),
    "revise-pr": ("modelRevise",),
    "review-pr": ("modelReview",),
    "answer": ("modelAnswer",),
}
# kind → every param its coded contract can supply at fire time — the REQUIRED keys plus the
# optional passthroughs, mirroring chain-members.ts buildParams (a novel kind updates BOTH
# sides, per chain.model.ts; test_kind_sync pins the required halves). `repo` is withRepo's
# conditional add and is handled separately (supplied only when the chain data seeds it).
KIND_CONTRACT_SUPPLIES: dict[str, frozenset[str]] = {
    "implement-pr": frozenset({"slug", "spec", "issueNumber", "clonePath", "verifyCmd"}),
    "review-pr": frozenset({"pr", "spec"}),
    "revise-pr": frozenset({"pr", "slug", "clonePath"}),
    "answer": frozenset({"task"}),
}
# Params that legitimately resolve EMPTY without a defaults-block entry (the clonePath class,
# member-input-validation's false-positive rule): `plugins` gates the optional plugin-install
# setup step — empty deliberately means "install none".
ALWAYS_OPTIONAL_PARAMS = frozenset({"plugins"})
# Untrusted-input executors are FROZEN: a SINGLE --agent warns and keeps the published executor
# . A ROSTER
# is the explicit relaxation:
# the panelists run as named, the pin migrates to the synthesis judge
# (panelize.JUDGE_ACTIVITY, claude).
FROZEN_EXECUTOR_KINDS = {"review-pr"}
# Write kinds share ONE branch/worktree per member — a roster of N writers would clobber it; the
# isolated form of "N implementations" is --parallel stage composition (the two-substrate table,
# panels-as-a-modifier).
WRITE_KINDS = frozenset({"implement-pr", "revise-pr"})
# -t group kind inference: the terminal atom's declared output contract IS the threading contract.
TERMINAL_ATOM_KIND = {"create-pr": "implement-pr"}

DEFAULT_EXPR = ["-w", "implement-pr", "-w", "review-pr", "-w", "revise-pr"]


def _fail(message: str) -> None:
    # escape(): the [red] tags are ours, the message is DATA. A member label like "[answer]" is
    # valid rich markup for an unknown style, which rich SWALLOWS — the error would drop the very
    # thing it names. Same reason every interpolation below is escaped.
    err_console.print(f"[red]{escape(message)}[/red]")
    raise typer.Exit(1)


def _warn(message: str) -> None:
    err_console.print(f"[yellow]warning:[/yellow] {escape(message)}")


def _guarded(fn: Any) -> Any:
    try:
        return fn()
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {escape(str(err))}")
        err_console.print("Is workflow-svc running, and are the chained workflows published?")
        raise typer.Exit(1) from err


def _budget_ms(raw: str) -> int:
    """A validated budget token (chain_expr enforced the format) → milliseconds."""
    unit = _BUDGET_UNITS.get(raw[-1:], 1)
    digits = raw[:-1] if raw[-1:] in _BUDGET_UNITS else raw
    return int(digits) * unit


def _identity_params(kind: str, cfg: WorkflowConfig, label: str) -> dict[str, str]:
    """FLAG identity → the fire-time params the workflow's template consumes (§1.9).

    Single-agent only — a roster (len > 1) takes the panelize path in _resolve_workflow, where
    identity is baked per branch instead of riding params."""
    params: dict[str, str] = {}
    agent = cfg.agents[0] if cfg.agents else None
    if agent:
        if kind in FROZEN_EXECUTOR_KINDS:
            _warn(
                f"--agent '{agent}' ignored on '{label}': the {kind} executor is frozen "
                "; "
                "keeping the published executor"
            )
        else:
            identity = agent_identity_params(agent)
            if identity is None:
                _fail(
                    f"unknown --agent '{agent}' — known: " + ", ".join(sorted(set(AGENT_IDENTITY)))
                )
                raise AssertionError("unreachable")
            params.update(identity)
            # A baked model belongs to the executor it was chosen for. When the user reassigns
            # the executor without also naming a model, clear the model param slots so the
            # saved default is overridden — the new executor's default model may not suit the
            # template's task, and the runner-side `||` fixes handle "" correctly.
            # An explicit --model still wins below.
            if not cfg.model and not baked_models_suit(agent):
                for name in KIND_MODEL_PARAMS[kind]:
                    params[name] = ""
    if cfg.model:
        for name in KIND_MODEL_PARAMS[kind]:
            params[name] = cfg.model
    return params


def _panel_definition(key: str, local: bool = False) -> dict[str, Any]:
    """A -w roster member's definition. Restructuring forces compose-on-fire, so prefer the chart
    template of the same name — `outputs` AND `panelSynthesis` flow from the render — falling
    back to the stored definition for keys that are not templates (generic synthesis prose).

    On the local substrate there is no store to fall back to, so a key with no template fails
    loud rather than reaching for a service that is the whole point of not needing."""
    template_name = template_name_for_key(key)
    if chart_root_for(template_name) is not None:
        return compose_templates([template_name])
    if local:
        _fail(
            f"-w '{key}' has no chart template, and --local cannot read the saved-workflow "
            "store — compose it with -t atoms instead, or drop --local"
        )
    stored = _guarded(lambda: workflow_svc.get(key))
    if not isinstance(stored, dict) or not stored.get("steps"):
        _fail(f"saved workflow '{key}' has no steps to panelize")
        raise AssertionError("unreachable")
    return stored


def _apply_roster(
    merged: dict[str, Any], roster: tuple[str, ...], label: str, model_override: str | None = None
) -> dict[str, Any]:
    """Panelize the composed definition with the roster: each name resolves through
    AGENT_IDENTITY to its run activity; any shape violation fails loud at registration.

    When *model_override* is set (from `--model`), it is applied to every branch step input.
    Otherwise the baked model is stripped and a warning is emitted noting the fallback."""
    try:
        baked_model = ""
        for step in merged.get("steps") or []:
            inp = step.get("input") or {}
            if inp.get("outputContract") and inp.get("model"):
                baked_model = inp["model"]
                break
        result = panelize(
            merged, roster_pairs(roster, AGENT_IDENTITY), model_override=model_override
        )
        if baked_model and not model_override:
            roster_str = ", ".join(roster)
            _warn(
                f"panelized '{label}' — model '{baked_model}' stripped from branches; "
                f"each panelist uses its own AGENT_MODEL (roster: {roster_str})"
            )
        return result
    except PanelizeError as err:
        _fail(f"cannot panelize '{label}': {err}")
        raise AssertionError("unreachable")


def _check_identity_slots(key: str, cfg: WorkflowConfig, kind: str) -> None:
    """A saved workflow published before fire-time identity has no param slots — fail loud on
    --agent (it would silently fire the baked identity), warn on --model (accepted limitation)."""
    stored = _guarded(lambda: workflow_svc.get(key))
    defaults = stored.get("params") or {}
    if cfg.agents and kind not in FROZEN_EXECUTOR_KINDS and "runActivity" not in defaults:
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
    broken thread fails HERE, not mid-chain. --input maps chain data keys (dynamic) — not
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


def _member_input_gaps(
    definition: dict[str, Any],
    kind: str,
    inputs: dict[str, str] | None,
    fire_params: dict[str, str],
    repo_seeded: bool,
) -> list[str]:
    """Registration-time INPUT validation — the input
    half of the asymmetry _check_output_mappings closes for outputs: every `{{params.X}}` the
    member's definition references must be satisfiable at fire time, else the run dies minutes
    later inside an activity with an error about something else entirely (the live case:
    `-w plan --kind answer` drops `slug` → `fatal: 'feature/' is not a valid branch name`).

    A param is satisfied by: an entry in the definition's `params:` defaults block (present at
    ALL — an empty default like `clonePath: ""` is the template author declaring the param
    optional; a required content param like plan's `slug` is deliberately absent from the
    block); the member's declared `--input` names (which REPLACE the kind contract's input
    half — exactly how the live case lost `slug`); else the kind contract's supplied keys;
    the member's own non-empty fire params (identity/model); `repo` when the chain data seeds
    it (withRepo); and the ALWAYS_OPTIONAL set. Chain `-p` seeds do NOT satisfy on their own —
    a seed only becomes a param through the contract or a declared --input, which is the exact
    trap this guards. Conservative by design: an undeterminable definition skips (never block
    a valid chain on a guess). Runs BEFORE any publish, so a refused chain leaves NO durable
    footprint."""
    import json as _json
    import re as _re

    referenced = set(
        _re.findall(r"\{\{params\.([A-Za-z0-9_]+)\}\}", _json.dumps(definition.get("steps") or []))
    )
    block = set((definition.get("params") or {}).keys())
    declared_inputs = set((inputs or {}).keys())
    supplied = declared_inputs if declared_inputs else set(KIND_CONTRACT_SUPPLIES.get(kind, ()))
    if repo_seeded:
        supplied |= {"repo"}
    supplied |= {k for k, v in fire_params.items() if v != ""}
    return sorted(referenced - block - supplied - ALWAYS_OPTIONAL_PARAMS)


def _fail_member_inputs(
    label: str, kind: str, inputs: dict[str, str] | None, missing: list[str]
) -> None:
    tokens = ", ".join("{{params." + m + "}}" for m in missing)
    contract = ", ".join(sorted(KIND_CONTRACT_SUPPLIES.get(kind, ()))) or "(nothing)"
    declared = ", ".join(sorted((inputs or {}).keys())) or "(none)"
    fixes = " ".join(f"--input {m}={m}" for m in missing)
    _fail(
        f"member '{label}' (kind: {kind}) references {tokens}, which nothing supplies.\n"
        f"  the '{kind}' kind's contract provides: {contract}\n"
        f"  you declared:                          {declared}\n"
        f"  fix: add {fixes} (the source must exist on the chain data — seed it with -p if "
        "needed); note a declared --input REPLACES the kind contract's inputs"
    )


def _resolve_workflow(
    member: MemberRef,
    cfg: WorkflowConfig,
    slug: str,
    index: int,
    stage: int,
    uses_stages: bool,
    in_parallel: bool,
    repo_seeded: bool,
    local: bool = False,
) -> dict[str, Any]:
    """A parsed member → the engine's ChainMember. Emits `key` (published) XOR `steps` (inline,
    D1), plus optional `stage`/`id`/`cron` for the Phase-6 composition surface. Validates the
    member's INPUTS against its definition before any publish side effect."""
    if member.key:
        if member.key in WELL_KNOWN and not cfg.kind:
            kind, key = WELL_KNOWN[member.key]
        else:
            key = member.key
            if cfg.kind is None:
                _fail(
                    f"-w '{member.key}' is not a well-known workflow name "
                    f"({', '.join(WELL_KNOWN)}) — follow it with --kind "
                    f"(one of: {', '.join(KNOWN_KINDS)}) so the engine knows its threading "
                    "contract"
                )
            kind = cfg.kind or ""
    else:
        inferred = cfg.kind or TERMINAL_ATOM_KIND.get(member.templates[-1])
        if inferred is None:
            _fail(
                f"cannot infer the workflow kind for `-t {' '.join(member.templates)}` — "
                "end the group with create-pr (its structured pr output is the implement-pr "
                "contract) "
                "or pass --kind"
            )
        kind = inferred or ""
        key = f"{slug}-w{index}"
    if kind not in KNOWN_KINDS:
        _fail(f"unknown --kind '{kind}' — known: {', '.join(KNOWN_KINDS)}")

    # A roster (several --agent names) panelizes the member
    #:
    # read/judge kinds only. When --model is given alongside a roster, it is applied to every
    # branch step input; without it each panelist falls back to its own AGENT_MODEL.
    roster = cfg.agents if len(cfg.agents) > 1 else ()
    if roster:
        if kind in WRITE_KINDS:
            _fail(
                f"a roster on '{member.label}' ({kind}) is not supported — write kinds share "
                "one branch/worktree, so N writers would clobber it; compose N members with "
                "--parallel (isolated instances) instead"
            )

    # A cron member self-arms an embedded recurrence (D1/D2), so it MUST be inline; --inline opts
    # any composed member into embedded storage. Both need `-t` templates — a saved -w key can't
    # be inlined (EXCEPT a roster member: panelizing restructures it, so it is composed either
    # way and may embed).
    # Local execution has no saved-workflow store to resolve a key against, so EVERY member
    # embeds its steps — the same compose-on-fire rule `h workflow run --local` follows.
    inline = cfg.inline or bool(cfg.cron) or local
    if local and cfg.cron:
        _fail(
            f"--cron on '{member.label}' needs the cron engine — drop --local (a member cannot "
            "self-arm a recurrence on a substrate with no engine to service it)"
        )
    if local and cfg.budget:
        _fail(
            f"--budget on '{member.label}' needs the watcher engine — drop --local (no watcher "
            "engine exists on the local substrate to enforce the wall-clock budget)"
        )
    if cfg.max_fires and not cfg.cron:
        _fail(f"--max-fires on '{member.label}' needs --cron (it's the cron's fire budget)")
    if cfg.budget and cfg.cron:
        _fail(
            f"--budget on '{member.label}' cannot combine with --cron — a cron member's "
            "recurrence is owned by the cron engine (the chain only observes "
            "wf:<member>.resolved and never re-fires it), so there is no per-member "
            "wall clock to enforce"
        )
    if inline and member.key is not None and not roster and not local:
        _fail(
            f"--inline/--cron member '{member.label}' must be composed with -t — an inline "
            "member embeds its own steps (a saved -w key can't be embedded)"
        )

    # Roster identity is baked per branch by panelize, never a runActivity param.
    params = {} if roster else _identity_params(kind, cfg, member.label)
    declared_outputs: dict[str, Any] | None = None
    steps: list[Any] | None = None
    key_field: str | None = None
    merged: dict[str, Any] | None = None
    if member.key is None:
        merged = compose_templates(list(member.templates))
    elif roster or local:
        merged = _panel_definition(key, local=local)
    if merged is not None:
        if roster:
            merged = _apply_roster(merged, roster, member.label, model_override=cfg.model)
            judge_note = " (judge: claude-agent)" if kind in FROZEN_EXECUTOR_KINDS else ""
            model_note = f" (model: {cfg.model})" if cfg.model else ""
            console.print(
                f"==> panelized '{escape(member.label)}' — roster: {escape(', '.join(roster))}"
                f"{judge_note}{model_note}"
            )
        source = " ⊕ ".join(member.templates) if member.key is None else member.key
        declared_outputs = merged.get("outputs")
        merged_params = merged.get("params") or {}
        # Input validation BEFORE the publish below — a refused chain must leave no durable
        # footprint.
        declared_inputs = dict(cfg.inputs) if cfg.inputs else None
        gaps = _member_input_gaps(merged, kind, declared_inputs, params, repo_seeded)
        if gaps:
            _fail_member_inputs(member.label, kind, declared_inputs, gaps)
        if inline:
            # Inline storage (D1): embed the composed steps in the chain row — nothing published.
            # The template's param defaults ride the member's params (no saved def to merge from).
            steps = merged["steps"]
            params = {**merged_params, **params}
            tag = " (cron)" if cfg.cron else ""
            console.print(f"==> composed [{source}] embedded inline{tag}", markup=False)
        else:
            # Publish-default: overlay + publish under the chain-scoped key (idempotent re-fire).
            key_field = f"{slug}-w{index}"
            _guarded(
                lambda: workflow_svc.save(
                    key_field,
                    merged["steps"],
                    params=merged_params or None,
                    outputs=declared_outputs,
                )
            )
            console.print(f"==> composed [{source}] published as '{key_field}'", markup=False)
    else:
        key_field = key
        if params:
            _check_identity_slots(key, cfg, kind)
    prefix, fresh_default = KIND_FIRE[kind]
    entry: dict[str, Any] = {"kind": kind}
    if steps is not None:
        entry["steps"] = steps
    else:
        entry["key"] = key_field
    # instanceId: the well-known per-kind instance (feature/revise share the feature/<slug> branch)
    # for a SEQUENTIAL saved member; an inline or parallel member gets a unique engine-derived
    # instance (<chainId>-w<index>) so concurrent members never collide on the same branch worktree.
    if not inline and not in_parallel:
        entry["instanceId"] = f"{prefix}-{slug}"
    entry["fresh"] = cfg.fresh or fresh_default
    if cfg.budget:
        entry["watch"] = {"maxDurationMs": _budget_ms(cfg.budget)}
    # stage: emitted on every member once the chain uses stages (a --parallel group or an explicit
    # --stage); a purely sequential chain omits it (the engine defaults a member's stage to index).
    if uses_stages:
        entry["stage"] = stage
    # id (D5): the member's chain data namespace, needed where concurrent captures could clobber —
    # a parallel member, or an explicit --id (a downstream reads it back via a dotted `id.field`
    # --input). A lone sequential member threads flat (no namespace), so its inputs stay flat keys.
    if cfg.id or in_parallel:
        entry["id"] = cfg.id or member.label
    if cfg.cron:
        cron_obj: dict[str, Any] = {"cadence": cfg.cron}
        if cfg.max_fires:
            cron_obj["maxFires"] = int(cfg.max_fires)
        entry["cron"] = cron_obj
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
        if declared_outputs is None and member.key is not None:
            stored = _guarded(lambda: workflow_svc.get(key))
            declared_outputs = stored.get("outputs") if isinstance(stored, dict) else None
        _check_output_mappings(entry, declared_outputs, member.label)

    # Input validation for a saved -w member (the composed path validated pre-publish above):
    # prefer the chart template's hermetic render (no wire call), falling back to the stored
    # definition — an UNDETERMINABLE definition (no template, fetch failed) skips validation
    # rather than block a valid chain (member-input-validation's false-positive rule).
    if merged is None:
        template_name = template_name_for_key(key)
        definition: dict[str, Any] | None
        try:
            if chart_root_for(template_name) is not None:
                definition = compose_templates([template_name])
            else:
                stored_def = workflow_svc.get(key)
                definition = stored_def if isinstance(stored_def, dict) else None
        except Exception:
            definition = None
        if definition is not None:
            declared_inputs = dict(cfg.inputs) if cfg.inputs else None
            gaps = _member_input_gaps(definition, kind, declared_inputs, params, repo_seeded)
            if gaps:
                _fail_member_inputs(member.label, kind, declared_inputs, gaps)
    return entry


@app.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def run(
    ctx: typer.Context,
    slug: Annotated[
        str | None,
        typer.Option(
            help="Chain slug — the branch token (feature/<slug>) and chain id. Seeds the data "
            "key 'slug' at LOWEST precedence (issue #82): an --after parent's captured slug "
            "overrides it at activation, and an explicit -p slug=... overrides both."
        ),
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
    local: Annotated[
        bool,
        typer.Option(
            "--local",
            help="Sequence the chain on the LOCAL substrate: every member is composed on the fly "
            "and executed in this process, stage by stage, driving the agent CLIs as local "
            "children. Same threading and the same loop; blocking instead of engine-sequenced, so "
            "flags that need an engine are refused.",
        ),
    ] = False,
    with_setup: Annotated[
        bool,
        typer.Option(
            "--with-setup",
            help="--local only: run each member's setup steps (they provision the operator's "
            "own HOME on this substrate, so they are skipped by default).",
        ),
    ] = False,
    resume: Annotated[
        str | None,
        typer.Option(
            "--resume",
            metavar="GROUP",
            help="--local only: CONTINUE the journaled run named by this chain group id instead "
            "of starting a new one — completed stages replay from the journal (paid work is not "
            "re-paid), execution re-enters at the cursor. The expression must match the "
            "journaled composition; a changed chain is a new run and is refused.",
        ),
    ] = None,
    no_journal: Annotated[
        bool,
        typer.Option(
            "--no-journal",
            help="--local only: skip the run journal (no fabric involved, nothing resumable). "
            "For throwaway runs or a machine without nats-server provisioned.",
        ),
    ] = False,
    strategy: Annotated[
        str,
        typer.Option(
            help="Chain strategy: 'sequential' (run the workflows once) or 'loop-until-clean' "
            "(repeat review-pr→revise until the review is CLEAN or --max-iterations)."
        ),
    ] = "sequential",
    max_iterations: Annotated[
        int,
        typer.Option(
            "--max-iterations",
            help="loop-until-clean only: cap on review→revise cycles before the chain finalizes.",
        ),
    ] = 3,
    after: Annotated[
        str | None,
        typer.Option(
            "--after",
            help="Activation gate: fire this chain only after the named chain finalizes "
            "completed (its finalized data — incl. terminal captures like prNumber — seeds this "
            "chain's data where absent). A failed parent terminates this chain instead.",
        ),
    ] = None,
    at: Annotated[
        str | None,
        typer.Option(
            "--at",
            help="Activation gate: do not fire before this absolute time (ISO 8601, UTC). "
            "Mutually exclusive with --in.",
        ),
    ] = None,
    in_: Annotated[
        str | None,
        typer.Option(
            "--in",
            help="Activation gate: do not fire before now + this delay (ms, <n>m, or <n>h). "
            "Mutually exclusive with --at.",
        ),
    ] = None,
) -> None:
    """Register a chain with the durable engine; it sequences the workflows fire-and-forget.

    The workflow list is the chain EXPRESSION — everything after the chain-identity flags:

      -w KEY            fire this saved workflow (well-known names: implement-pr, review-pr, revise)

      -t ATOM ATOM...   overlay these templates into ONE workflow (composed and published on fire)

      --agent A --model M --budget DUR --fresh --inline --kind K   bind to the workflow they
                        FOLLOW; before the first workflow they set chain-wide defaults (a prefix
                        --budget is the whole-chain wall clock: <n>m, <n>h, or milliseconds; a
                        SUFFIX --budget is instead that one member's watch policy, enforced by the
                        watcher — the two compose whichever-trips-first).
                        Under --local the prefix budget is enforced by the driver BETWEEN STAGES
                        (it declines to start more work; it cannot terminate a running agent), and
                        a suffix budget is refused: there is no watcher here.
                        --inline embeds the composed steps in the chain row instead of publishing.

      --agent A B C...  SEVERAL names are a panel ROSTER: the member is panelized — each roster
                        agent answers concurrently, a pinned judge (claude) synthesizes under the
                        member's own output contract, so downstream seams are unchanged. Read/
                        judge kinds only (write kinds: use --parallel members); --model applies
                        the specified model to every panelized branch.

      --stage N         the member's concurrency STAGE (members sharing a stage run concurrently,
                        joined before the next); the alternative to --parallel grouping

      --cron CADENCE --max-fires N   the member self-arms a recurrence (forces --inline): it recurs
                        on CADENCE until its goal resolves (wf:<repo>:<slug>:<kind>.resolved) or the
                        fire budget trips; the chain OBSERVES it, never re-fires it. Needs -p repo=…

      --id NAME         the member's chain data namespace (D5) — a downstream reads its capture
                        via a dotted `--input PARAM=NAME.field`; defaults to the -t/-w label

      --capture BB=FIELD --input PARAM=SRC --until PATH=VALUE   structured-output threading for
                        the workflow they follow (per-workflow only): capture a declared output
                        FIELD onto chain data key BB; feed SRC (a flat key OR a dotted `id.field`)
                        in as PARAM; stop a loop when the structured field at PATH equals VALUE.

      --parallel        joins adjacent workflows into one concurrent stage (joined before the next)

    Template VALUES ride `-p key=value` (hydrating inline, uniform with `h workflow run`);
    `-t` hydrates STRUCTURE, `-p` hydrates values, the rest is machinery.

    Default expression: -w implement-pr -w review-pr -w revise (a feature to a reviewed PR).
    Example:  h chain run --slug demo -p spec=@spec.md -p repo=o/r \\
                  -t research --capture findings=summary \\
                  --parallel -t gather --cron '*/30 * * * *' --max-fires 20 --capture m=latest \\
                  -t report --input spec=research.findings --input telemetry=gather.m
    """
    if strategy not in ("sequential", "loop-until-clean"):
        _fail(
            f"strategy '{strategy}' not implemented — 'sequential' or 'loop-until-clean' "
            "(parallel is deferred until a multi-reviewer chain needs it)."
        )
    if not slug:
        _fail("--slug is required")
        raise AssertionError("unreachable")
    if local:
        # The activation gates are engine machinery: `--after` waits on another chain's finalized
        # row, `--at`/`--in` arm a scheduled fire. Both need something watching on a clock.
        engine_flags = {"--after": after, "--at": at, "--in": in_}
        used = [name for name, value in engine_flags.items() if value]
        if used:
            _fail(
                f"{', '.join(used)} need workflow-svc's engines — drop --local (activation gates "
                "wait on a durable row; local execution runs the chain here and now)"
            )
    elif with_setup:
        _fail("--with-setup applies to --local only")
    if not local:
        # The journal is the LOCAL substrate's durability; the service substrate's is the Dapr
        # engine's own. Refused by name so nobody reads --resume as a generic retry flag.
        if resume:
            _fail("--resume applies to --local only (the service substrate resumes via its engine)")
        if no_journal:
            _fail("--no-journal applies to --local only (only local runs journal)")
    if resume and no_journal:
        _fail("--resume needs the journal it would replay — drop --no-journal")

    tokens = list(ctx.args)
    if not any(token in ("-w", "-t") for token in tokens):
        tokens += DEFAULT_EXPR  # bare prefix flags (e.g. a chain budget) keep the default chain
    try:
        expr = parse_expr(tokens)
    except ExprError as err:
        _fail(str(err))
        raise AssertionError("unreachable")

    # Flatten the stages, resolving each member's FINAL stage: an explicit --stage wins, else its
    # positional index (from --parallel grouping). `in_parallel` is then whether that final stage is
    # shared — so `-t a --stage 0 -t b --stage 0` and `-w a --parallel -w b` mark parallel alike.
    # A chain "uses stages" (emits an explicit `stage` on every member) when a stage is shared OR
    # any --stage is explicit; else it stays purely sequential (engine defaults stage to the index).
    members: list[tuple[MemberRef, WorkflowConfig, int, int]] = []
    flat = 0
    for stage_index, stage_group in enumerate(expr.stages):
        for member in stage_group:
            cfg = effective_config(expr.defaults, member.config)
            final_stage = int(cfg.stage) if cfg.stage is not None else stage_index
            members.append((member, cfg, flat, final_stage))
            flat += 1
    stage_counts = Counter(final_stage for *_, final_stage in members)
    uses_stages = any(count > 1 for count in stage_counts.values()) or any(
        cfg.stage is not None for _, cfg, *_ in members
    )

    # Chain-level -p values seed the shared data chain data, threaded to every member. Parsed
    # BEFORE member resolution so the input validation inside _resolve_workflow knows the
    # seeds (repo). The implicit slug goes into defaultData (lowest precedence, issue #82) so
    # an --after parent's captured slug wins at activation. Explicit -p slug=... lands in data
    # and wins over both.
    data: dict[str, Any] = {**parse_params(param or [])}

    workflows: list[dict[str, Any]] = []
    for member, cfg, index, final_stage in members:
        if member.templates and all(template_role(atom) == "overlay" for atom in member.templates):
            _fail(
                f"-t group '{' '.join(member.templates)}' contains only overlays — "
                f"compose with a base, e.g. `-t implement {' '.join(member.templates)}`"
            )
        in_parallel = stage_counts[final_stage] > 1
        workflows.append(
            _resolve_workflow(
                member,
                cfg,
                slug,
                index,
                final_stage,
                uses_stages,
                in_parallel,
                repo_seeded=bool(data.get("repo")),
                local=local,
            )
        )
    # A cron member's recurrence + the chain's completion predicate both read wf:<repo>:<slug>:<wf>,
    # so it needs a repo on the chain data — fail loud here, not mid-fire in the engine.
    if any(w.get("cron") for w in workflows) and not data.get("repo"):
        _fail(
            "a --cron member needs a repo — add -p repo=owner/name (its recurrence + completion "
            "read wf:<repo>:<slug>:<workflow>)"
        )
    body: dict[str, Any] = {
        "slug": slug,
        "members": workflows,
        "data": data,
        "defaultData": {"slug": slug},
        "strategy": strategy,
    }
    chain_budget = expr.defaults.budget
    body["budgetMs"] = (
        _budget_ms(chain_budget) if chain_budget else len(workflows) * PER_WORKFLOW_BUDGET_MS
    )

    # Activation gates (issue #78): the scan holds stage 0 until they pass.
    if at is not None and in_ is not None:
        _fail("--at and --in are mutually exclusive")
    if after:
        body["after"] = after
    if at:
        body["notBefore"] = at
    elif in_:
        import datetime

        if not _BUDGET_RE_LOCAL.match(in_):
            _fail(f"bad --in '{in_}' — expected milliseconds, <n>m, or <n>h (e.g. 45m)")
        body["notBefore"] = (
            datetime.datetime.now(datetime.UTC) + datetime.timedelta(milliseconds=_budget_ms(in_))
        ).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    if strategy == "loop-until-clean":
        # The loop body is review-pr→revise: the review workflow is the predicate (CLEAN stops the
        # loop), and the last workflow loops back to it. Require both, in order. The engine's
        # cursor is a STAGE index (issue #79b), so startCursor is the review member's STAGE —
        # identical to its member index in a purely sequential chain. Stages BEFORE the loop may
        # be concurrent (e.g. a panel stage); stages inside the loop segment must be
        # single-member (the loop re-fires them and reads the sole member's verdict).
        kinds = [entry["kind"] for entry in workflows]
        if "review-pr" not in kinds:
            _fail("loop-until-clean needs a 'review-pr' workflow (the predicate).")
        review_pos = kinds.index("review-pr")
        start = members[review_pos][3]  # the review member's FINAL stage
        last_stage = max(final_stage for *_, final_stage in members)
        if start >= last_stage:
            _fail("loop-until-clean needs a workflow after 'review-pr' (e.g. 'revise') to loop.")
        crowded = sorted({fs for *_, fs in members if fs >= start and stage_counts[fs] > 1})
        if crowded:
            _fail(
                "loop-until-clean requires single-member stages from the review onward "
                f"(stage(s) {', '.join(map(str, crowded))} have several members) — concurrent "
                "stages may only precede the loop segment."
            )
        body["loop"] = {"startCursor": start, "maxIterations": max_iterations}

    if local:
        _run_local_chain(body, slug, with_setup, resume=resume, no_journal=no_journal)
        return

    result = _guarded(lambda: workflow_svc.chain_run(body))

    labels = [member.label for workflow in expr.members]
    gate = (
        f" — activates after chain '{after}'"
        if after
        else (f" — activates at {body.get('notBefore')}" if body.get("notBefore") else "")
    )
    console.print(
        f"==> chain '{escape(result['chainId'])}' registered "
        f"\\[{escape(' -> '.join(labels))}] "
        f"(branch feature/{escape(slug)}, strategy={escape(strategy)}){escape(gate)}"
    )
    console.print("    the chain engine sequences the workflows on the cron tick; non-blocking.")
    console.print(f"    watch it: h chain list  (or h workflow status feature-{slug})")
    console.print_json(data=result)


def _run_local_chain(
    body: dict[str, Any],
    slug: str,
    with_setup: bool,
    resume: str | None = None,
    no_journal: bool = False,
) -> None:
    """Execute a composed chain on the local substrate and report what it threaded.

    The chain BODY is the same one the service substrate would have registered — same members,
    same stages, same captures/inputs/until, same loop. Only `data` is flattened here (the engine
    merges `defaultData` under `data` at activation; there is no activation on this substrate) and
    the members are already embedded, since `--local` forces compose-on-fire.

    A `--resume GROUP` run REUSES the journaled group id (the composition must hash-match the
    journal; the executor refuses otherwise) instead of minting a fresh one.
    """
    members = [
        {k: v for k, v in member.items() if k in _LOCAL_MEMBER_FIELDS} for member in body["members"]
    ]
    job: dict[str, Any] = {
        "kind": "chain",
        "members": members,
        "data": {**body.get("defaultData", {}), **body.get("data", {})},
        "strategy": body["strategy"],
        "group": resume if resume else group_id(f"chain-{slug}"),
        "runsDir": str(AGENT_RUNS_DIR),
        "timeoutMs": LOCAL_STEP_TIMEOUT_MS,
        # The whole-chain wall clock rides to the local driver exactly as it rides to the chain
        # row — including the per-member-count DEFAULT, so a local chain is bounded like a
        # registered one rather than running unbounded on the operator's own machine. The driver
        # checks it between stages (it cannot terminate a running agent; timeoutMs bounds that).
        # A per-MEMBER budget is refused earlier — it is a watch policy, and there is no watcher.
        "budgetMs": body["budgetMs"],
        "worktreeRoot": str(LOCAL_WORKTREES_DIR),
        "repoPath": repo_root(Path.cwd()),
    }
    if body.get("loop"):
        job["loop"] = body["loop"]
    if with_setup:
        job["withSetup"] = True
    if not no_journal:
        job["journal"] = _journal_preflight(resume)

    try:
        envelope = local_runtime.run_job(job)
    except LocalRunError as err:
        err_console.print(f"[red]local:[/red] {escape(str(err))}")
        raise typer.Exit(1) from err

    runs = envelope.get("runs") or []
    table = Table("stage", "member", "iteration", "run group", title=f"chain · {job['group']}")
    for entry in runs:
        table.add_row(
            str(entry.get("stage", "?")),
            str(entry.get("member", "?")),
            str(entry.get("iteration", 0)),
            str(entry.get("group", "-")),
        )
    err_console.print(table)
    if envelope.get("data"):
        console.print_json(data=envelope["data"])

    status = envelope.get("status", "failed")
    if status == "completed":
        err_console.print(
            f"[green]chain completed[/green] — {escape(str(envelope.get('note', '')))}".rstrip()
        )
        return
    colour = "yellow" if status == "exhausted" else "red"
    note = escape(str(envelope.get("note", "no detail")))
    err_console.print(f"[{colour}]chain {escape(status)}[/{colour}]: {note}")
    raise typer.Exit(1)


@app.command("list")
def list_() -> None:
    """List registered chains + the scan heartbeat (the durable chain registry)."""
    try:
        result = workflow_svc.chain_list()
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {escape(str(err))}")
        err_console.print("Is workflow-svc running? (make dev-tab)")
        raise typer.Exit(1) from err
    chains = result.get("chains", [])
    table = Table(
        "chain",
        "status",
        "workflow",
        "member budget (ms)",
        "outcome",
        title=f"chains ({len(chains)})",
    )
    for c in chains:
        workflows = c.get("members", [])
        cursor = c.get("cursor", 0)
        current = workflows[cursor] if 0 <= cursor < len(workflows) else None
        kind = current["kind"] if current else "-"
        # The CURRENT member's own wall clock (`-w X --budget 10m`), read off the watch policy
        # its registration emitted. Distinct from the chain-wide budget: this one is enforced
        # per-member by the WATCHER engine, not by the chain engine. "-" means unbudgeted.
        watch = current.get("watch") if current else None
        member_budget = str(watch.get("maxDurationMs", "-")) if watch else "-"
        table.add_row(
            c.get("chainId", ""),
            c.get("status", ""),
            f"{cursor + 1}/{len(workflows)} ({kind})",
            member_budget,
            c.get("outcome") or "-",
        )
    console.print(table)
    heartbeat = result.get("heartbeat")
    if heartbeat:
        console.print(
            f"[dim]scan heartbeat: {heartbeat.get('at')} (enabled={heartbeat.get('enabled')})[/dim]"
        )


@app.command("rm")
def rm(
    chain_id: str = typer.Argument(..., help="Chain id to disarm (e.g. spot-ownership-review)."),
) -> None:
    """Disarm a chain: set finalized+disarmed, keep the row for audit.

    Calls workflow-svc's POST /chain/disarm — only workflow-svc writes chain:* rows (single-writer).
    Idempotent: an already-disarmed chain is a success, not an error.

    Prints the in-flight instanceId (if any) so you can terminate it:
        h workflow terminate <instanceId>
    """
    result = _guarded(lambda: workflow_svc.chain_disarm(chain_id))
    console.print(
        f"[green]disarmed[/green] chain:sub:{chain_id} "
        f"→ {result['status']} / {result.get('outcome', '')}"
    )
    if result.get("currentInstanceId"):
        console.print(
            f"[yellow]in-flight:[/yellow] {result['currentInstanceId']}"
            f" — terminate with: h workflow terminate {result['currentInstanceId']}"
        )
