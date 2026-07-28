"""The chain expression parser — the ordered workflow grammar of `h chain run`.

Pure and dependency-free (sibling of overlay.py): tokens in, structure out, no Typer/click/network.
The grammar (docs/plans/impl/chain-composition-surface.md §1.5):

    EXPR    := FLAG* STAGE STAGE*        # FLAGs before the first workflow = chain-wide defaults
    STAGE   := WF ( "--parallel" WF )*    # infix --parallel joins workflows into one parallel stage
    WF      := ( "-w" KEY | "-t" ATOM ATOM* ) FLAG*
    FLAG := "--agent" A A* | "--model" M | "--budget" DUR | "--fresh" | "--inline" | "--kind" K
           | "--stage" N | "--cron" CADENCE | "--max-fires" N | "--id" NAME
           | "--capture" DEST=SRC | "--input" DEST=SRC | "--until" PATH=VALUE

Scope is position (never dash count): a FLAG binds to the workflow it follows; before any
workflow it sets a chain-wide default a workflow can override. Adjacent stages run sequentially;
a parallel group has an implied join barrier. Typer must never declare these flag names on
`h chain run` — click consumes declared options wherever they appear in argv, which would destroy
their position.

`--agent` consumes operands greedily (the `-t` atom idiom): ONE name is the identity flag as
before; SEVERAL are a panel ROSTER
(docs/plans/impl/panels-as-a-modifier.md — the member is panelized:
each roster agent answers concurrently, a judge synthesizes under the member's own contract). A
roster is per-workflow only — a panel is one member's shape — so a multi-name prefix is rejected
while a single-name prefix stays a chain-wide default.

--capture/--input/--until are the declarative structured-output mappings
(docs/plans/impl/structured-workflow-outputs.md §4-5): per-workflow ONLY
(like --kind — a mapping is a member’s contract, never a chain-wide default),
member's contract, never a chain-wide default), repeatable for --capture/--input, assignment-
ordered destination=source.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace

# Greedy multi-value flags (the -t atom idiom: consume operands until the next dash token).
# --agent's cardinality is the panel dimension: one name = identity, several = a roster.
ROSTER_FLAGS = ("--agent",)
VALUE_FLAGS = (
    "--model",
    "--budget",
    "--kind",
    "--until",
    # Phase-6 per-member composition flags (docs/plans/impl/inline-chain-cron-composition.md):
    "--stage",  # explicit concurrency stage index (else positional, from --parallel grouping)
    "--cron",  # cron cadence — the member self-arms a recurrence (forces --inline)
    "--max-fires",  # cron budget (requires --cron)
    "--id",  # the member's chain data namespace (D5) — defaults to the -t/-w label
)
# Repeatable dest=source mapping flags — accumulate instead of the duplicate-flag rejection.
MAP_FLAGS = ("--capture", "--input")
BOOL_FLAGS = ("--fresh", "--inline")
CONNECTOR = "--parallel"
WORKFLOW_INTRODUCERS = ("-w", "-t")
# Per-workflow-only value flags: meaningless as chain-wide defaults (each is one member's contract).
PER_WORKFLOW_FLAGS = ("--kind", "--until", "--stage", "--cron", "--max-fires", "--id")

# A watch/chain budget: <n>m, <n>h, or bare milliseconds — validated here so a typo fails at
# parse time, not minutes later in the engine.
_BUDGET_RE = re.compile(r"^\d+[mh]?$")


class ExprError(ValueError):
    """A user-presentable chain-expression parse error (str(err) is the message)."""


@dataclass(frozen=True)
class WorkflowConfig:
    """Per-workflow config carried by FLAGs; every field optional (None/False = not given)."""

    # The --agent operands: () = not given, one name = identity, several = a panel ROSTER
    # (docs/plans/impl/panels-as-a-modifier.md — cardinality is the panel dimension,
    # not a new flag).
    agents: tuple[str, ...] = ()
    model: str | None = None
    budget: str | None = None  # raw duration token, validated against _BUDGET_RE
    fresh: bool = False
    kind: str | None = None
    # Phase-6 composition (docs/plans/impl/inline-chain-cron-composition.md):
    # stage = explicit stage idx
    # (str; else positional); cron = cadence (member self-arms a recurrence, forces inline);
    # max_fires = cron budget; id = the member's chain data namespace (D5); inline = embed the
    # composed steps in the chain row instead of publishing under <slug>-w<N>.
    stage: str | None = None
    cron: str | None = None
    max_fires: str | None = None
    id: str | None = None
    inline: bool = False
    # Structured-output mappings (per-workflow only, assignment-ordered destination=source):
    # captures: chain dataKey=outputField pairs; inputs: param=chain dataKey pairs; until: the
    # raw PATH=VALUE token (chain.py shapes it for the engine).
    captures: tuple[tuple[str, str], ...] = ()
    inputs: tuple[tuple[str, str], ...] = ()
    until: str | None = None


@dataclass(frozen=True)
class MemberRef:
    """One workflow: a saved-workflow key (-w) XOR a template group to compose-on-fire (-t)."""

    key: str | None = None
    templates: tuple[str, ...] = ()
    config: WorkflowConfig = field(default_factory=WorkflowConfig)

    @property
    def label(self) -> str:
        return self.key if self.key else "+".join(self.templates)


@dataclass(frozen=True)
class ChainExpr:
    """The parsed expression: chain-wide defaults + ordered stages (each a parallel group)."""

    defaults: WorkflowConfig = field(default_factory=WorkflowConfig)
    stages: tuple[tuple[MemberRef, ...], ...] = ()

    @property
    def members(self) -> tuple[MemberRef, ...]:
        return tuple(member for stage in self.stages for member in stage)


def effective_config(defaults: WorkflowConfig, member: WorkflowConfig) -> WorkflowConfig:
    """The member config over the chain-wide defaults, per field (member wins where given)."""
    return WorkflowConfig(
        agents=member.agents if member.agents else defaults.agents,
        model=member.model if member.model is not None else defaults.model,
        budget=member.budget if member.budget is not None else defaults.budget,
        fresh=member.fresh or defaults.fresh,
        kind=member.kind,  # kind is per-workflow only; defaults never carry one (parser enforces)
        # stage/cron/max_fires/id are per-workflow only (parser enforces) — no defaults to merge;
        # inline may be a chain-wide default (like fresh — "compose everything inline").
        stage=member.stage,
        cron=member.cron,
        max_fires=member.max_fires,
        id=member.id,
        inline=member.inline or defaults.inline,
        # Mappings are per-workflow only too (parser enforces) — no defaults to merge.
        captures=member.captures,
        inputs=member.inputs,
        until=member.until,
    )


def _validated(flag: str, value: str) -> str:
    if flag == "--budget" and not _BUDGET_RE.match(value):
        raise ExprError(f"bad {flag} '{value}' — expected milliseconds, <n>m, or <n>h (e.g. 45m)")
    if flag in ("--stage", "--max-fires") and not value.isdigit():
        raise ExprError(f"bad {flag} '{value}' — expected a non-negative integer")
    if flag in (*MAP_FLAGS, "--until"):
        dest, sep, src = value.partition("=")
        if not sep or not dest or not src:
            shape = (
                "PATH=VALUE (e.g. verdict=CLEAN)"
                if flag == "--until"
                else ("destination=source (e.g. prNumber=pr)")
            )
            raise ExprError(f"bad {flag} '{value}' — expected {shape}")
    return value


def _set_flag(config: WorkflowConfig, flag: str, value: str | bool, where: str) -> WorkflowConfig:
    name = flag.lstrip("-").replace("-", "_")  # --max-fires → max_fires
    current = getattr(config, name)
    if current not in (None, False):
        raise ExprError(f"duplicate {flag} {where}")
    return replace(config, **{name: value})


def parse_expr(tokens: list[str]) -> ChainExpr:
    """Parse the ordered EXPR tokens (everything Typer didn't consume) into a ChainExpr.

    Raises ExprError with a user-presentable message on any grammar violation — unknown tokens,
    a workflow introducer without operands, a value flag without a value, --parallel outside an
    infix position, duplicate flags on one workflow, --kind in the prefix.
    """
    defaults = WorkflowConfig()
    stages: list[list[MemberRef]] = []
    current: MemberRef | None = None  # the workflow whose suffix FLAGs are being collected
    joining = False  # a --parallel is pending: the next workflow joins the current stage
    i = 0
    n = len(tokens)

    def flag_value(flag: str) -> str:
        nonlocal i
        if i + 1 >= n or tokens[i + 1].startswith("-"):
            raise ExprError(f"{flag} needs a value")
        i += 1
        return _validated(flag, tokens[i])

    def finish_workflow() -> None:
        nonlocal current, joining
        if current is None:
            return
        if joining:
            stages[-1].append(current)
            joining = False
        else:
            stages.append([current])
        current = None

    while i < n:
        token = tokens[i]
        if token in WORKFLOW_INTRODUCERS:
            finish_workflow()
            if token == "-w":
                if i + 1 >= n or tokens[i + 1].startswith("-"):
                    raise ExprError("-w needs a saved-workflow key")
                i += 1
                current = MemberRef(key=tokens[i])
            else:
                atoms: list[str] = []
                while i + 1 < n and not tokens[i + 1].startswith("-"):
                    i += 1
                    atoms.append(tokens[i])
                if not atoms:
                    raise ExprError("-t needs at least one template operand")
                current = MemberRef(templates=tuple(atoms))
        elif token == CONNECTOR:
            if current is None:
                # Covers a connector at the start, in the prefix, and two connectors in a row.
                raise ExprError(
                    "--parallel is an infix connector — it must sit between two workflows"
                )
            # The workflow to the left closes into its stage; the next one joins that same
            # stage (A --parallel B --parallel C chains into one three-way group).
            finish_workflow()
            joining = True
        elif token in ROSTER_FLAGS:
            # Greedy multi-value (the -t atom loop): one name = identity, several = a roster.
            names: list[str] = []
            while i + 1 < n and not tokens[i + 1].startswith("-"):
                i += 1
                names.append(tokens[i])
            if not names:
                raise ExprError(f"{token} needs a value")
            if current is not None:
                if current.config.agents:
                    raise ExprError(f"duplicate {token} on workflow '{current.label}'")
                current = replace(current, config=replace(current.config, agents=tuple(names)))
            elif not stages:
                if len(names) > 1:
                    raise ExprError(
                        f"a {token} roster is per-workflow only — a panel is one member's "
                        "shape; place the roster after a -w/-t workflow"
                    )
                if defaults.agents:
                    raise ExprError(f"duplicate {token} in the chain-wide prefix")
                defaults = replace(defaults, agents=tuple(names))
            else:
                raise ExprError(
                    f"{token} must follow a workflow (or precede the first workflow as a default)"
                )
        elif token in MAP_FLAGS:
            flag = token
            value = flag_value(flag)
            if current is None:
                raise ExprError(f"{flag} is per-workflow only — place it after a -w/-t workflow")
            name = "captures" if flag == "--capture" else "inputs"
            pairs: tuple[tuple[str, str], ...] = getattr(current.config, name)
            dest, _, src = value.partition("=")
            if any(existing == dest for existing, _ in pairs):
                raise ExprError(f"duplicate {flag} destination '{dest}' on '{current.label}'")
            current = replace(
                current, config=replace(current.config, **{name: (*pairs, (dest, src))})
            )
        elif token in VALUE_FLAGS:
            flag = token
            value = flag_value(flag)
            if current is not None:
                current = replace(
                    current,
                    config=_set_flag(current.config, flag, value, f"on workflow '{current.label}'"),
                )
            elif not stages:
                if flag in PER_WORKFLOW_FLAGS:
                    raise ExprError(
                        f"{flag} is per-workflow only — place it after a -w/-t workflow"
                    )
                defaults = _set_flag(defaults, flag, value, "in the chain-wide prefix")
            else:
                raise ExprError(
                    f"{flag} must follow a workflow (or precede the first workflow as a default)"
                )
        elif token in BOOL_FLAGS:
            if current is not None:
                current = replace(
                    current,
                    config=_set_flag(current.config, token, True, f"on workflow '{current.label}'"),
                )
            elif not stages:
                defaults = _set_flag(defaults, token, True, "in the chain-wide prefix")
            else:
                raise ExprError(
                    f"{token} must follow a workflow (or precede the first workflow as a default)"
                )
        elif token.startswith("-"):
            known = ", ".join(
                (
                    *WORKFLOW_INTRODUCERS,
                    CONNECTOR,
                    *ROSTER_FLAGS,
                    *VALUE_FLAGS,
                    *MAP_FLAGS,
                    *BOOL_FLAGS,
                )
            )
            raise ExprError(f"unknown token '{token}' in the chain expression — known: {known}")
        else:
            raise ExprError(
                f"unexpected operand '{token}' — bare operands only follow -t (templates); "
                "a -w workflow takes exactly one key"
            )
        i += 1

    if joining and current is None:
        raise ExprError("--parallel is an infix connector — it must sit between two workflows")
    finish_workflow()
    if not stages:
        raise ExprError(
            "the chain expression needs at least one workflow (-w KEY or -t TEMPLATE...)"
        )
    return ChainExpr(defaults=defaults, stages=tuple(tuple(stage) for stage in stages))
