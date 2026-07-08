"""h chain — temporal composition: sequence workflows through the durable chain engine.

A chain is a registered policy the chain engine (workflow-svc) sequences on the cron tick, mirroring
the watcher engine (docs/plans/workflow-composition.md Phase 4). `h chain run` REGISTERS the chain
and returns immediately — the hops run fire-and-forget and survive a closed laptop; `h chain list`
inspects the durable registry. State threads hop-to-hop IN THE ENGINE (it parses each hop's
`===MARKER===` output into the chain's blackboard and builds the next hop's params), so the chained
workflows stay chain-agnostic. This CLI only names the hops and their fire identity; the Phase-1
in-process poll/thread loop is gone.
"""

from dataclasses import dataclass
from typing import Annotated, Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

from h_cli.commands.feature import _resolve_spec
from h_cli.infrastructure import workflow_svc

app = typer.Typer(
    no_args_is_help=True, help="Chain workflows into a pipeline (temporal composition)."
)
console = Console()
err_console = Console(stderr=True)

PER_HOP_BUDGET_MS = 45 * 60_000


@dataclass(frozen=True)
class HopSpec:
    """A hop kind's fire identity: the saved workflow key, instance naming, re-fire semantics.
    The engine (workflow-svc chain-hops.ts) owns the state threading; this is only how it fires.
    """

    key: str  # saved workflow key this hop fires
    instance_prefix: str  # instanceId = f"{instance_prefix}-{slug}"
    fresh: bool  # re-fire a terminal instance under that id (revise re-runs feature-pr fresh)


# feature-pr and revise share the feature-<slug> instance (same branch/worktree/PR); revise re-runs
# it fresh. pr-review has its own instance. Publish feature-pr once:
#   h workflow compose -t feature -t verify -t create-pr --save feature-pr
HOP_SPECS: dict[str, HopSpec] = {
    "feature-pr": HopSpec("feature-pr", "feature", False),
    "pr-review": HopSpec("pr-review", "pr-review", False),
    "revise": HopSpec("feature-pr", "feature", True),
}
DEFAULT_CHAIN = ["feature-pr", "pr-review", "revise"]


@app.command()
def run(
    template: Annotated[
        list[str] | None,
        typer.Option(
            "--template",
            "-t",
            help="A chain hop, repeatable (compose-style). "
            f"Known: {', '.join(HOP_SPECS)}. Default: {' -> '.join(DEFAULT_CHAIN)}.",
        ),
    ] = None,
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
        str, typer.Option(help="Chain strategy. 'sequential' only (parallel/loop-until-clean TBD).")
    ] = "sequential",
    fresh: Annotated[
        bool,
        typer.Option("--fresh", help="Re-run the first hop's instance if it already finished."),
    ] = False,
    budget: Annotated[
        int | None,
        typer.Option(
            "--budget",
            help="Chain wall-clock budget in MINUTES; on breach the engine terminates the "
            "current hop and finalizes the chain. Default: 45 min per hop.",
        ),
    ] = None,
) -> None:
    """Register a chain with the durable engine; it sequences the hops fire-and-forget.

    The default chain takes a feature to a reviewed PR: implement+open a PR (feature-pr), post
    inline review comments (pr-review), then address them on the same branch (revise). This
    returns as soon as the chain is registered — the engine fires hop 0 and advances the rest on the
    cron tick. Watch it with `h chain list`. Prerequisite: publish `feature-pr` and `pr-review`.
    """
    templates = template or DEFAULT_CHAIN
    if strategy != "sequential":
        err_console.print(
            f"[red]strategy '{strategy}' not implemented[/red] — only 'sequential' for now "
            "(parallel and loop-until-clean are the next chain-engine strategies)."
        )
        raise typer.Exit(1)
    unknown = [t for t in templates if t not in HOP_SPECS]
    if unknown:
        err_console.print(
            f"[red]unknown hop(s):[/red] {', '.join(unknown)} — known: {', '.join(HOP_SPECS)}"
        )
        raise typer.Exit(1)
    if not slug or not spec:
        err_console.print("[red]--slug and --spec are required[/red]")
        raise typer.Exit(1)

    spec_text = _resolve_spec(spec).read_text()
    hops: list[dict[str, Any]] = []
    for position, name in enumerate(templates):
        s = HOP_SPECS[name]
        hops.append(
            {
                "kind": name,
                "key": s.key,
                "instanceId": f"{s.instance_prefix}-{slug}",
                # feature+revise re-run the same instance; revise (and a --fresh first hop) opt in.
                "fresh": s.fresh or (fresh and position == 0),
            }
        )
    data: dict[str, Any] = {"slug": slug, "spec": spec_text}
    if issue is not None:
        data["issueNumber"] = str(issue)
    body: dict[str, Any] = {"slug": slug, "hops": hops, "data": data, "strategy": strategy}
    body["budgetMs"] = (budget * 60_000) if budget is not None else len(hops) * PER_HOP_BUDGET_MS

    try:
        result = workflow_svc.chain_run(body)
    except httpx.HTTPError as err:
        err_console.print(f"[red]http:[/red] {err}")
        err_console.print("Is workflow-svc running and are `feature-pr`/`pr-review` published?")
        raise typer.Exit(1) from err

    console.print(
        f"==> chain '{result['chainId']}' registered [{' -> '.join(templates)}] "
        f"(branch feature/{slug}, strategy={strategy})"
    )
    console.print("    the chain engine sequences the hops on the cron tick — this does not block.")
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
    table = Table("chain", "status", "hop", "outcome", title=f"chains ({len(chains)})")
    for c in chains:
        hops = c.get("hops", [])
        cursor = c.get("cursor", 0)
        kind = hops[cursor]["kind"] if 0 <= cursor < len(hops) else "-"
        table.add_row(
            c.get("chainId", ""),
            c.get("status", ""),
            f"{cursor + 1}/{len(hops)} ({kind})",
            c.get("outcome") or "-",
        )
    console.print(table)
    heartbeat = result.get("heartbeat")
    if heartbeat:
        console.print(
            f"[dim]scan heartbeat: {heartbeat.get('at')} (enabled={heartbeat.get('enabled')})[/dim]"
        )
