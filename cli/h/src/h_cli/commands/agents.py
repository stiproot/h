"""h agents — list the workflow-invokable agents and maintain the executor policy.

The list reads from the existing config tables (no new data source); deny/allow maintain the
engine-enforced `exec:config` row — the activity-registry gate refuses a denied executor at fire
time, on every path.

Both substrates are addressable: without `--local` the row lives in workflow-svc's Redis; with it,
in the local substrate's JetStream KV, where the local executor and `h delegate` read the same
fence. The row SHAPE is engine-core's `ExecPolicy` either way, so only the transport differs."""

from datetime import UTC, datetime
from typing import Any

import typer
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from h_cli.commands._quota import quota_cell
from h_cli.config import AGENT_IDENTITY
from h_cli.infrastructure import local_runtime, workflow_svc

app = typer.Typer(
    no_args_is_help=True,
    help="List the workflow-invokable agents and maintain the executor policy.",
)
console = Console()
err_console = Console(stderr=True)


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


# --- substrate selection -------------------------------------------------------------------
#
# `--local` reads and writes the JetStream KV `exec:` bucket instead of workflow-svc's Redis row,
# through the runner (which owns the key codec — see local_runtime.registry). The FLAG is the
# selector everywhere, matching `h workflow run --local` and `h chain run --local`: the source of
# an answer should be in the command you typed, not in which services happen to be up.
#
# The policy SHAPE is identical on both substrates — it is engine-core's `ExecPolicy` either way —
# so everything below this seam is substrate-agnostic.


def _policy_get(local: bool) -> dict:
    if not local:
        return workflow_svc.exec_policy_get()
    return local_runtime.registry("exec.get") or {"denied": [], "updatedAt": ""}


def _policy_set(local: bool, denied: list[Any], budgets: dict | None = None) -> dict:
    if not local:
        return workflow_svc.exec_policy_set(denied)
    # The service route normalizes bare names into operator entries at write time; there is no
    # route here, so the CLI does it — the same `normalizeDenied` rule, stated once in Python
    # rather than a second time in the runner.
    entries = [
        e if isinstance(e, dict) else {"name": e, "reason": "operator", "deniedAt": _now()}
        for e in denied
    ]
    policy: dict[str, Any] = {"denied": entries, "updatedAt": _now()}
    if budgets:
        policy["budgets"] = budgets
    return local_runtime.registry("exec.save", policy=policy)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _quota_rows(local: bool, policy: dict) -> dict[str, dict]:
    """The `quota:` OBSERVATION registry, keyed by executor shortname — what each agent CLI last
    reported about its rate-limit windows. Distinct from the exec: POLICY row: this is what the
    gate READS to refuse a fire that would not fit, and what the shepherd reads to schedule
    around a reset. Service side it rides `/exec/policy`'s `quota` field; locally it is its own
    registry read. Best-effort — an unreadable registry leaves the column `-`."""
    try:
        rows = policy.get("quota") if not local else local_runtime.registry("quota.list")
    except Exception:
        return {}
    return {row["executor"]: row for row in (rows or []) if isinstance(row, dict)}


LOCAL_OPT = typer.Option(
    False,
    "--local",
    help="Read/write the LOCAL substrate's exec: registry (JetStream KV) instead of workflow-svc.",
)


@app.command("list")
def list_(local: bool = LOCAL_OPT) -> None:
    """List all workflow-invokable agents, their identities, the denied set (with provenance:
    operator denies never expire; auto usage-limited/cost-budget denies carry an expiry), each
    executor's daily budget vs today's tallied spend, and its rate-limit headroom as its CLI
    last reported it (`5h 62% → 14:05 · 7d 31% → Tue 09:00`; `!` = exhausted; `reset` = the
    observation predates the window's reset). Fire past the reset, or --on-quota wait."""
    policy: dict = {}
    try:
        policy = _policy_get(local)
        entries = {e["name"]: e for e in _entries(policy)}
    except Exception as err:
        # The table still lists the agents; only the policy column is unknown. Naming WHICH
        # substrate could not answer matters now that there are two.
        entries = {}
        where = "the local fabric" if local else "workflow-svc"
        console.print(f"[yellow]{where} unreachable — policy column unavailable[/yellow]")
        if local:
            console.print(f"[yellow]{escape(str(err))}[/yellow]")
    budgets: dict = policy.get("budgets", {}) or {}
    spend: dict = policy.get("todaySpend", {}) or {}
    quota = _quota_rows(local, policy)

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
    # Headroom goes under the table rather than in it: at terminal width a seventh column
    # truncates the identities to noise, and a reset time is read as a sentence anyway.
    for short, row in sorted(quota.items()):
        console.print(
            f"quota: {escape(short)} {escape(quota_cell(row))}  "
            f"[dim](observed {escape(str(row.get('observedAt', '?')))} "
            f"by {escape(str(row.get('runId', '?')))})[/dim]"
        )
    if entries:
        _print_denied(list(entries.values()))
    gap_runs = policy.get("todayCostGapRuns", 0)
    if gap_runs:
        console.print(
            f"[yellow]today: {gap_runs} run(s) finalized with NO usable cost (gaps, not zeros) — "
            "spend column undercounts[/yellow]"
        )


@app.command("deny")
def deny(
    names: list[str] = typer.Argument(..., help="Agent names to deny (e.g. codex)."),
    local: bool = LOCAL_OPT,
) -> None:
    """Deny executors engine-wide: every fire path refuses them until allowed again. An
    operator deny never expires and upgrades any automatic usage-limited entry."""
    shortnames = {_executor_shortname(n) for n in names}
    kept = [e for e in _entries(_policy_get(local)) if e["name"] not in shortnames]
    # New denies ride as bare names — the write side stamps them as operator entries.
    policy = _policy_set(local, kept + sorted(shortnames))
    _print_denied(_entries(policy))


@app.command("budget")
def budget(
    name: str = typer.Argument(..., help="Agent name (e.g. kimi)."),
    usd_per_day: float | None = typer.Argument(
        None, help="Daily budget in USD; omit with --clear to remove."
    ),
    clear: bool = typer.Option(False, "--clear", help="Remove this executor's budget."),
    local: bool = LOCAL_OPT,
) -> None:
    """Set or clear an executor's daily cost budget: when
    the watcher's day tally crosses it, the executor is auto-denied until the next UTC midnight
    (`cost-budget` entry — never overrides an operator deny; lift early with `h agents allow`)."""
    if local:
        # A budget is not a stored number, it is a WATCHER behaviour: the day tally crosses it and
        # the watcher writes the cost-budget deny. There is no watcher on this substrate yet, so
        # storing one would arm a fence nobody enforces — the silent kind of wrong. Refuse by name,
        # like every other engine-shaped flag `--local` declines.
        err_console.print(
            "[red]--local cannot set a budget[/red] — a budget is enforced by the WATCHER's daily "
            "cost tally, and no watcher runs on the local substrate. `h agents deny --local` is "
            "the fence that does work here; drop --local to set a budget on the service substrate."
        )
        raise typer.Exit(code=1)
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
    local: bool = LOCAL_OPT,
) -> None:
    """Remove executors from the denied set — lifts operator AND auto entries alike."""
    shortnames = {_executor_shortname(n) for n in names}
    updated = [e for e in _entries(_policy_get(local)) if e["name"] not in shortnames]
    policy = _policy_set(local, updated)
    _print_denied(_entries(policy))
