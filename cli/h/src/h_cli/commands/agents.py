"""h agents — list the workflow-invokable agents and maintain the executor policy.

The list reads from the existing config tables (no new data source); deny/allow maintain the
engine-enforced `exec:config` row on workflow-svc —
the activity-registry gate refuses a denied executor at fire time, on every path."""

import typer
from rich.console import Console
from rich.table import Table

from h_cli.config import AGENT_IDENTITY
from h_cli.infrastructure import workflow_svc

app = typer.Typer(
    no_args_is_help=True,
    help="List the workflow-invokable agents and maintain the executor policy.",
)
console = Console()


def _executor_shortname(name: str) -> str:
    """Resolve a user-given agent name to its policy shortname (the run activity minus `run-`).

    Unknown names are refused loudly — the engine gate matches shortnames, so a typo would
    silently deny nothing."""
    identity = AGENT_IDENTITY.get(name)
    if identity is None:
        known = ", ".join(sorted({a for a, _ in AGENT_IDENTITY.values()}))
        console.print(f"[red]unknown agent '{name}'[/red] — known run activities: {known}")
        raise typer.Exit(code=1)
    run_activity, _ = identity
    return run_activity.removeprefix("run-")


def _entries(policy: dict) -> list[dict]:
    """The policy's denied list as entries (the wire is already normalized by the GET route,
    but tolerate the pre-provenance string shape defensively)."""
    out: list[dict] = []
    for d in policy.get("denied", []):
        if isinstance(d, str):
            out.append({"name": d, "reason": "operator", "deniedAt": policy.get("updatedAt", "")})
        else:
            out.append(d)
    return out


def _policy_cell(entry: dict | None) -> str:
    # Compact on purpose — rich truncates wide cells; provenance detail rides `h agents list`'s
    # denied summary line below the table and the gate's refusal message.
    if entry is None:
        return "allowed"
    return "auto-denied" if entry.get("reason") in ("usage-limited", "cost-budget") else "DENIED"


def _print_denied(entries: list[dict]) -> None:
    parts = []
    for e in sorted(entries, key=lambda e: e["name"]):
        until = f", until {e['until']}" if e.get("until") else ""
        parts.append(f"{e['name']} ({e['reason']}{until})")
    console.print("denied: " + (", ".join(parts) or "(none)"))


@app.command("list")
def list_() -> None:
    """List all workflow-invokable agents, their identities, the denied set (with provenance:
    operator denies never expire; auto usage-limited/cost-budget denies carry an expiry), and
    each executor's daily budget vs today's tallied spend."""
    policy: dict = {}
    try:
        policy = workflow_svc.exec_policy_get()
        entries = {e["name"]: e for e in _entries(policy)}
    except Exception:
        entries = {}  # workflow-svc down: the table still lists; policy column shows unknown
        console.print("[yellow]workflow-svc unreachable — policy column unavailable[/yellow]")
    budgets: dict = policy.get("budgets", {}) or {}
    spend: dict = policy.get("todaySpend", {}) or {}

    seen: set[str] = set()
    rows: list[tuple[str, str, str, str, str, str]] = []
    for name in sorted(AGENT_IDENTITY.keys()):
        run_activity, agent_id = AGENT_IDENTITY[name]
        if agent_id in seen:
            continue
        seen.add(agent_id)
        short = run_activity.removeprefix("run-")
        cell = _policy_cell(entries.get(short))
        budget = f"${budgets[short]:g}/day" if short in budgets else "-"
        today = f"${spend[short]:.2f}" if short in spend else "-"
        rows.append((name, run_activity, agent_id, cell, budget, today))

    # No url column: at table width it truncated to noise; the budget/today columns (A1) earn
    # the space. Full URLs live in config (AGENT_URLS).
    table = Table(
        "agent",
        "runActivity",
        "agentId",
        "policy",
        "budget",
        "today",
        title=f"agents ({len(rows)})",
    )
    for row in rows:
        table.add_row(*row)
    console.print(table)
    if entries:
        _print_denied(list(entries.values()))
    gap_runs = policy.get("todayCostGapRuns", 0)
    if gap_runs:
        console.print(
            f"[yellow]today: {gap_runs} run(s) finalized with NO usable cost (gaps, not zeros) — "
            "spend column undercounts[/yellow]"
        )


@app.command("deny")
def deny(names: list[str] = typer.Argument(..., help="Agent names to deny (e.g. codex).")) -> None:
    """Deny executors engine-wide: every fire path refuses them until allowed again. An
    operator deny never expires and upgrades any automatic usage-limited entry."""
    shortnames = {_executor_shortname(n) for n in names}
    kept = [e for e in _entries(workflow_svc.exec_policy_get()) if e["name"] not in shortnames]
    # New denies ride as bare names — the route stamps them as operator entries at write time.
    policy = workflow_svc.exec_policy_set(kept + sorted(shortnames))
    _print_denied(_entries(policy))


@app.command("budget")
def budget(
    name: str = typer.Argument(..., help="Agent name (e.g. kimi)."),
    usd_per_day: float | None = typer.Argument(
        None, help="Daily budget in USD; omit with --clear to remove."
    ),
    clear: bool = typer.Option(False, "--clear", help="Remove this executor's budget."),
) -> None:
    """Set or clear an executor's daily cost budget: when
    the watcher's day tally crosses it, the executor is auto-denied until the next UTC midnight
    (`cost-budget` entry — never overrides an operator deny; lift early with `h agents allow`)."""
    shortname = _executor_shortname(name)
    if clear:
        result = workflow_svc.exec_budget_set(shortname, None)
    elif usd_per_day is None or usd_per_day <= 0:
        console.print("[red]give a positive USD/day amount, or --clear to remove[/red]")
        raise typer.Exit(code=1)
    else:
        result = workflow_svc.exec_budget_set(shortname, usd_per_day)
    budgets = result.get("budgets", {})
    parts = [f"{n} ${b:g}/day" for n, b in sorted(budgets.items())]
    console.print("budgets: " + (", ".join(parts) or "(none)"))


@app.command("allow")
def allow(
    names: list[str] = typer.Argument(..., help="Agent names to re-allow (e.g. codex)."),
) -> None:
    """Remove executors from the denied set — lifts operator AND auto entries alike."""
    shortnames = {_executor_shortname(n) for n in names}
    updated = [e for e in _entries(workflow_svc.exec_policy_get()) if e["name"] not in shortnames]
    policy = workflow_svc.exec_policy_set(updated)
    _print_denied(_entries(policy))
