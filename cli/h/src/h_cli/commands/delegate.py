"""h delegate — hand one task to one or more agent CLIs running as local child processes.

The atom of the local execution substrate. `h workflow run` and `h chain run` compose work out
of templates and fire it at workflow-svc; this is the case with nothing to compose — a driver (a
human at a terminal, or an agent shelling out) delegating a bounded piece of work to codex, pi or
openhands and reading the answer back. No Dapr, no services, no registries: the only prerequisite
is a built workspace and CLIs the operator has already authenticated.

`--agent` repeats to form a roster, exactly as it does on `h workflow run`; every agent answers
the same task independently and in parallel. Synthesis is deliberately NOT done here — for a
judged panel use `h workflow run answer --local --agent a b`, which panelizes through the same
transform the service substrate uses.
"""

import json
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console
from rich.rule import Rule
from rich.table import Table

from h_cli.config import AGENT_RUNS_DIR, LOCAL_WORKTREES_DIR
from h_cli.infrastructure import local_runtime
from h_cli.infrastructure.local_runtime import LocalRunError, group_id, repo_root

console = Console()
err_console = Console(stderr=True)


def delegate(
    task: Annotated[
        str,
        typer.Argument(help="The task to delegate. A leading @ splices in that file's content."),
    ],
    agent: Annotated[
        list[str] | None,
        typer.Option(
            "--agent",
            "-a",
            help="Agent to run; repeat for a roster (each answers independently, in parallel).",
        ),
    ] = None,
    model: Annotated[
        str | None,
        typer.Option("--model", "-m", help="Model override, applied to every agent in the roster."),
    ] = None,
    cwd: Annotated[
        Path | None, typer.Option("--cwd", help="Working directory (default: here).")
    ] = None,
    timeout: Annotated[
        int, typer.Option("--timeout", help="Per-agent wall-clock budget, in seconds.")
    ] = 1800,
    worktree: Annotated[
        bool,
        typer.Option(
            "--worktree",
            help="Cut an isolated git worktree per agent — write work never touches the live tree.",
        ),
    ] = False,
    base: Annotated[
        str, typer.Option("--base", help="Branch a new worktree starts from (fetched from origin).")
    ] = "main",
    plan: Annotated[
        bool, typer.Option("--plan", help="Read-only: run the agent in plan mode where supported.")
    ] = False,
    group: Annotated[
        str | None,
        typer.Option(
            "--id", help="Run-ledger group for this job (default: local-<yymmdd>-<hhmmss>)."
        ),
    ] = None,
    as_json: Annotated[
        bool, typer.Option("--json", help="Print the raw result envelope instead of the answers.")
    ] = False,
) -> None:
    """Delegate a task to local agent CLIs and print what each produced."""
    if task.startswith("@"):
        path = Path(task[1:])
        if not path.is_file():
            err_console.print(f"[red]task[/red]: no such file: {path}")
            raise typer.Exit(1)
        task = path.read_text()

    working_dir = (cwd or Path.cwd()).resolve()
    if not working_dir.is_dir():
        err_console.print(f"[red]--cwd[/red]: no such directory: {working_dir}")
        raise typer.Exit(1)

    roster = agent or ["claude"]
    job_group = group or group_id("local")
    job: dict[str, Any] = {
        "kind": "delegate",
        "task": task,
        "agents": roster,
        "cwd": str(working_dir),
        "timeoutMs": timeout * 1000,
        "runsDir": str(AGENT_RUNS_DIR),
        "group": job_group,
    }
    if model:
        job["model"] = model
    if plan:
        job["permissionMode"] = "plan"

    try:
        if worktree:
            job["worktree"] = {
                "repoPath": repo_root(working_dir),
                "root": str(LOCAL_WORKTREES_DIR),
                # Namespaced so a sweep can find them (`git branch --list 'local/*'`), without
                # repeating the group's own `local-` prefix in every branch name.
                "branchPrefix": f"local/{job_group.removeprefix('local-')}",
                "remoteBase": base,
            }
        envelope = local_runtime.run_job(job)
    except LocalRunError as err:
        err_console.print(f"[red]local:[/red] {err}")
        raise typer.Exit(1) from err

    if as_json:
        console.print_json(json.dumps(envelope))
        raise typer.Exit(0 if envelope.get("ok") else 1)

    runs = envelope.get("runs") or []
    if not runs:
        err_console.print(f"[red]local:[/red] {envelope.get('error', 'no runs')}")
        raise typer.Exit(1)

    # One agent: just the answer — a driver piping this wants the output, not a report.
    if len(runs) == 1:
        run = runs[0]
        if run.get("output"):
            console.print(run["output"])
        if run.get("status") != "completed":
            err_console.print(f"[red]{run['agent']} failed:[/red] {run.get('error', '')}")
    else:
        for run in runs:
            console.print(Rule(f"[bold]{run['agent']}[/bold] — {run.get('status')}"))
            console.print(run.get("output") or f"[red]{run.get('error', 'no output')}[/red]")

    _print_ledger(runs, job_group)
    raise typer.Exit(0 if envelope.get("ok") else 1)


def _print_ledger(runs: list[dict[str, Any]], group: str) -> None:
    """Where each run landed, and what it cost.

    Cost is surfaced deliberately: local execution has no watcher, so there is no daily-budget
    fence and no engine-side tally — this table and `h runs` are the accounting.
    """
    table = Table(
        "agent", "status", "cost", "run id", title=f"runs · {group}", title_justify="left"
    )
    for run in runs:
        cost = run.get("costUsd")
        table.add_row(
            run.get("agent", "?"),
            run.get("status", "?"),
            "—" if cost is None else f"${cost:.4f}",
            run.get("runId", "—"),
        )
    err_console.print(table)
