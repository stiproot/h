"""h chain — temporal composition: run several workflows in sequence through a shared blackboard.

Phase 1 of the workflow-composition plan (docs/plans/workflow-composition.md): chain the EXISTING
saved workflows (`feature` -> `pr-review` -> `revise`) via a `-t` list, threading state between hops
through a chain blackboard keyed by `slug`. This is the cheap probe of the shared-context contract —
no template surgery yet; the overlay operator and the durable chain-as-policy engine come later.

The blackboard is `{slug, data: Record<str, any>}`: each chain template keys out of `data` what it
needs (its inputs) and writes back what it produces (its outputs). For Phase 1 that port contract is
the built-in `CHAIN_TEMPLATES` registry below; later it moves into the templates themselves. The
in-process `data` dict drives the threading; it is mirrored best-effort to the statestore key
`chain:<slug>` so a chain's shared context is durable and inspectable (the eventual home is a hosted
actor with turn-based writes, needed once the parallel strategy lands).
"""

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
import typer
from rich.console import Console

from h_cli.commands.feature import _resolve_spec
from h_cli.config import STATE_URL
from h_cli.infrastructure import workflow_svc

app = typer.Typer(
    no_args_is_help=True, help="Chain workflows into a pipeline (temporal composition)."
)
console = Console()
err_console = Console(stderr=True)

TERMINAL = {"COMPLETED", "FAILED", "TERMINATED"}
DEFAULT_WATCH_BUDGET_MS = 45 * 60_000

# The revise hop re-fires `feature` on the same branch; its spec tells the agent to address the
# review feedback. With the #20 epilogue on main, the agent fetches the unresolved threads itself,
# implements each change, then replies inline and resolves them — so the spec just points at the PR
# and hands over the review summary as context.
_REVISE_SPEC_PREAMBLE = (
    "Address the review feedback on the open pull request for this branch. Fetch the unresolved "
    "review threads on the PR, implement each requested change, then (per the PR epilogue) reply "
    "inline to each thread you addressed and resolve it. The review summary follows.\n\n"
    "===REVIEW SUMMARY===\n"
)


class ChainError(RuntimeError):
    """A chain hop could not proceed (a prior hop produced no usable output, or a run failed)."""


@dataclass(frozen=True)
class ChainTemplate:
    """A chainable unit's Phase-1 port contract: how to fire it, how it reads/writes `data`."""

    name: str
    saved_key: str  # the saved workflow this hop fires
    fresh: bool  # re-fire semantics (revise re-runs the same feature instance)
    instance_prefix: str  # instanceId = f"{instance_prefix}-{slug}" (feature+revise share one)
    build_params: Callable[[dict[str, Any]], dict[str, Any]]  # data -> fire params (inputs)
    capture: Callable[[str | None, dict[str, Any]], None]  # workflow output -> data (outputs)


def _step_outputs(workflow_output: str | None) -> list[str]:
    """Pull each step's `output` text from the workflow result.

    The generic workflow returns JSON.stringify(results); Dapr serializes that again into the
    status `output` property, so the value can arrive double-encoded (a JSON string whose content
    is itself a JSON string). Unwrap successive string layers until a dict surfaces.
    """
    results: Any = workflow_output
    for _ in range(3):
        if not isinstance(results, str):
            break
        try:
            results = json.loads(results)
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(results, dict):
        return []
    return [
        v["output"]
        for v in results.values()
        if isinstance(v, dict) and isinstance(v.get("output"), str)
    ]


def _after_marker(workflow_output: str | None, marker: str) -> str | None:
    """Return the text following `marker` in whichever step output carries it (else None)."""
    for text in _step_outputs(workflow_output):
        if marker in text:
            return text.split(marker, 1)[1].strip()
    return None


def _capture_pr(workflow_output: str | None, data: dict[str, Any]) -> None:
    tail = _after_marker(workflow_output, "===PR===")
    if not tail:
        return
    url = tail.splitlines()[0].strip()
    data["prUrl"] = url
    match = re.search(r"/pull/(\d+)", url)
    if match:
        data["prNumber"] = match.group(1)


def _capture_review(workflow_output: str | None, data: dict[str, Any]) -> None:
    data["reviewFindings"] = _after_marker(workflow_output, "===REVIEW===") or ""


def _feature_params(data: dict[str, Any]) -> dict[str, Any]:
    # Fires the composed `feature-pr` template (feature ⊕ create-pr) — the PR comes from the
    # overlay, not a createPr flag. issueNumber is create-pr's optional `Closes #N` param.
    params = {"slug": data["slug"], "spec": data["spec"]}
    if data.get("issueNumber"):
        params["issueNumber"] = data["issueNumber"]
    return params


def _pr_review_params(data: dict[str, Any]) -> dict[str, Any]:
    pr = data.get("prNumber")
    if not pr:
        raise ChainError(
            "pr-review needs a PR number, but the previous hop produced none "
            "(no ===PR=== marker in its output). Did the feature hop open a PR?"
        )
    return {"pr": pr}


def _revise_params(data: dict[str, Any]) -> dict[str, Any]:
    params = {
        "slug": data["slug"],
        "spec": _REVISE_SPEC_PREAMBLE + (data.get("reviewFindings") or "(no findings reported)"),
    }
    if data.get("issueNumber"):
        params["issueNumber"] = data["issueNumber"]
    return params


# Phase-1 built-in registry — the chainable templates and their port contracts. The `feature` and
# `revise` hops both fire the composed `feature-pr` saved template (feature ⊕ create-pr — publish it
# once with `h workflow compose -t feature -t create-pr --save feature-pr`); they share the
# `feature-<slug>` instance (same worktree/branch/PR), and `revise` re-runs it fresh.
CHAIN_TEMPLATES: dict[str, ChainTemplate] = {
    "feature": ChainTemplate(
        "feature", "feature-pr", False, "feature", _feature_params, _capture_pr
    ),
    "pr-review": ChainTemplate(
        "pr-review", "pr-review", False, "pr-review", _pr_review_params, _capture_review
    ),
    "revise": ChainTemplate("revise", "feature-pr", True, "feature", _revise_params, _capture_pr),
}

DEFAULT_CHAIN = ["feature", "pr-review", "revise"]


def _blackboard_write(slug: str, data: dict[str, Any]) -> None:
    """Mirror the blackboard to the statestore key chain:<slug> (best-effort, inspectable).

    The in-process `data` dict is the source of truth for threading; this mirror makes the
    chain's shared context durable and readable from any session. A missing/unreachable sidecar
    is a warning, never a chain failure.
    """
    try:
        httpx.post(
            STATE_URL,
            json=[{"key": f"chain:{slug}", "value": {"slug": slug, "data": data}}],
            timeout=10,
        ).raise_for_status()
    except httpx.HTTPError:
        err_console.print(
            f"[dim]note: could not mirror blackboard to chain:{slug} "
            "(sidecar unreachable); threading continues in-process[/dim]"
        )


def _poll_terminal(instance_id: str, poll_interval: float, timeout: float) -> dict[str, Any]:
    """Poll a workflow instance until it reaches a terminal status, or raise on timeout."""
    deadline = time.monotonic() + timeout
    while True:
        status = workflow_svc.status(instance_id)
        runtime = status.get("runtimeStatus", "UNKNOWN")
        if runtime in TERMINAL:
            return status
        if time.monotonic() >= deadline:
            raise ChainError(f"{instance_id}: still {runtime} after {timeout:.0f}s (timeout)")
        time.sleep(poll_interval)


@app.command()
def run(
    template: Annotated[
        list[str] | None,
        typer.Option(
            "--template",
            "-t",
            help="A chainable template, repeatable (compose-style). "
            f"Known: {', '.join(CHAIN_TEMPLATES)}. Default: {' -> '.join(DEFAULT_CHAIN)}.",
        ),
    ] = None,
    slug: Annotated[
        str | None,
        typer.Option(help="Chain slug — the branch token (feature/<slug>) and blackboard key."),
    ] = None,
    spec: Annotated[
        str | None,
        typer.Option(help="Feature spec: a .md path, or a bare name under the spec home."),
    ] = None,
    issue: Annotated[
        int | None, typer.Option("--issue", help="GitHub issue this chain implements (Closes #N).")
    ] = None,
    strategy: Annotated[
        str, typer.Option(help="Chain strategy. Phase 1 supports 'sequential' only.")
    ] = "sequential",
    fresh: Annotated[
        bool,
        typer.Option("--fresh", help="Re-run the first hop's instance if it already finished."),
    ] = False,
    watch: Annotated[
        bool,
        typer.Option(
            "--watch", help="Register every hop with the durable watcher engine (45m budget)."
        ),
    ] = False,
    poll_interval: Annotated[
        float, typer.Option(help="Seconds between status polls while awaiting each hop.")
    ] = 10.0,
    timeout: Annotated[
        float, typer.Option(help="Seconds to await each hop before giving up.")
    ] = 1800.0,
) -> None:
    """Run a chain of workflows in sequence, threading state through the chain blackboard.

    The default chain takes a feature all the way to a reviewed PR: implement+open a PR (feature),
    post inline review comments (pr-review), then address them on the same branch (revise). Each hop
    reads its inputs from — and writes its outputs to — the blackboard keyed by --slug.
    """
    templates = template or DEFAULT_CHAIN
    if strategy != "sequential":
        err_console.print(
            f"[red]strategy '{strategy}' not implemented[/red] — Phase 1 supports 'sequential' "
            "(parallel and loop-until-clean come with the chain-as-policy engine)."
        )
        raise typer.Exit(1)
    unknown = [t for t in templates if t not in CHAIN_TEMPLATES]
    if unknown:
        err_console.print(
            f"[red]unknown template(s):[/red] {', '.join(unknown)} — "
            f"known: {', '.join(CHAIN_TEMPLATES)}"
        )
        raise typer.Exit(1)
    if not slug or not spec:
        err_console.print("[red]--slug and --spec are required[/red]")
        raise typer.Exit(1)

    spec_text = _resolve_spec(spec).read_text()
    data: dict[str, Any] = {"slug": slug, "spec": spec_text}
    if issue is not None:
        data["issueNumber"] = str(issue)
    watch_policy = {"maxDurationMs": DEFAULT_WATCH_BUDGET_MS} if watch else None

    console.print(
        f"==> chain [{' -> '.join(templates)}] on slug '{slug}' "
        f"(branch feature/{slug}, strategy={strategy})"
    )
    _blackboard_write(slug, data)

    for position, name in enumerate(templates, start=1):
        tmpl = CHAIN_TEMPLATES[name]
        try:
            params = tmpl.build_params(data)
        except ChainError as err:
            err_console.print(f"[red]hop {position} ({name}):[/red] {err}")
            raise typer.Exit(1) from err
        instance_id = f"{tmpl.instance_prefix}-{slug}"
        # feature+revise re-run the same instance; revise (and a --fresh first hop) opt into fresh.
        hop_fresh = tmpl.fresh or (fresh and position == 1)
        console.print(f"--> hop {position}/{len(templates)}: {name} (instance {instance_id})")
        try:
            fired = workflow_svc.run_saved(
                tmpl.saved_key, params, instance_id, hop_fresh, watch_policy
            )
            status = _poll_terminal(fired["instanceId"], poll_interval, timeout)
        except httpx.HTTPError as err:
            err_console.print(f"[red]hop {position} ({name}) http:[/red] {err}")
            err_console.print("Is workflow-svc running and are `feature-pr`/`pr-review` published?")
            raise typer.Exit(1) from err
        except ChainError as err:
            err_console.print(f"[red]hop {position} ({name}):[/red] {err}")
            raise typer.Exit(1) from err

        runtime = status.get("runtimeStatus")
        if runtime != "COMPLETED":
            err_console.print(
                f"[red]hop {position} ({name}) ended {runtime}[/red] — chain stopped."
            )
            raise typer.Exit(1)
        tmpl.capture(status.get("output"), data)
        _blackboard_write(slug, data)
        console.print(f"    done: {name} — blackboard keys: {', '.join(sorted(data))}")

    console.print("==> chain complete")
    if data.get("prUrl"):
        console.print(f"    PR: {data['prUrl']}")
    console.print_json(data={"slug": slug, "data": data})
