"""h status — one-screen driver check-in: chains, engine heartbeats, PRs, verdict.

Read-only, zero writes, zero agent invocations. Four independent fetches (chain/watch/cron/PRs);
each failure is recorded and surfaced in the verdict rather than exiting non-zero.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import typer
from rich.console import Console
from rich.table import Table

from h_cli.infrastructure import workflow_svc

console = Console()

STALE_AFTER_SECONDS = 5 * 60
RECENT_WINDOW_SECONDS = 24 * 3600
NON_OK_OUTCOMES = frozenset({"failed", "terminated", "budget-terminated", "orphaned"})


def _heartbeat_age_seconds(at: Any) -> float | None:
    """ISO timestamp → age in seconds; None when absent or unparseable (treat as stale)."""
    if not isinstance(at, str):
        return None
    try:
        ts = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    return (datetime.now(UTC) - ts).total_seconds()


def _format_age(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m"
    return f"{seconds / 3600:.1f}h"


def _fetch_all() -> (
    tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None, list[dict[str, Any]], list[str]]
):
    """Fetch chain/watch/cron/PRs independently; records errors rather than raising."""
    fetch_errors: list[str] = []
    chain_data: dict[str, Any] | None = None
    watch_data: dict[str, Any] | None = None
    cron_data: dict[str, Any] | None = None
    prs: list[dict[str, Any]] = []

    try:
        chain_data = workflow_svc.chain_list()
    except httpx.HTTPError as err:
        fetch_errors.append(f"chain/list unreachable: {err}")

    try:
        watch_data = workflow_svc.watch_list()
    except httpx.HTTPError as err:
        fetch_errors.append(f"watch/list unreachable: {err}")

    try:
        cron_data = workflow_svc.cron_list()
    except httpx.HTTPError as err:
        fetch_errors.append(f"cron/list unreachable: {err}")

    try:
        prs = workflow_svc.open_prs()
    except httpx.HTTPError as err:
        fetch_errors.append(f"open_prs unavailable: {err}")

    return chain_data, watch_data, cron_data, prs, fetch_errors


def _findings_count(data: Any) -> int | None:
    """Count non-empty lines in data['reviewFindings'] when present."""
    if not isinstance(data, dict):
        return None
    findings = data.get("reviewFindings")
    if not isinstance(findings, str) or not findings.strip():
        return None
    return len([ln for ln in findings.splitlines() if ln.strip()])


def _analyze(
    chain_data: dict[str, Any] | None,
    watch_data: dict[str, Any] | None,
    cron_data: dict[str, Any] | None,
    prs: list[dict[str, Any]],
    fetch_errors: list[str],
) -> tuple[dict[str, Any], list[str]]:
    """Pure analysis: returns (sections_dict, flags_list). Shared by rich and --json paths."""
    flags: list[str] = list(fetch_errors)

    # --- CHAINS ---
    chains = (chain_data or {}).get("chains") or []
    active_chains: list[dict[str, Any]] = []
    recent_finalized: list[dict[str, Any]] = []

    for c in chains:
        status = c.get("status", "")
        if status in ("scheduling", "running"):
            members = c.get("members") or []
            cursor = c.get("cursor", 0)
            loop = c.get("loop")
            iteration = loop.get("iterations") if isinstance(loop, dict) else None
            fc = _findings_count(c.get("data"))
            # Normalize stages: absent stage equals member index (sequential, not explicit 0)
            stages = frozenset(m.get("stage", i) for i, m in enumerate(members))
            total_stages = len(stages)
            active_chains.append(
                {
                    "chainId": c.get("chainId", ""),
                    "status": status,
                    "cursor": cursor,
                    "total": total_stages,
                    "iteration": iteration,
                    "findings": fc,
                }
            )
        elif status == "finalized":
            ended_raw = c.get("endedAt")
            age = _heartbeat_age_seconds(ended_raw)
            if age is not None and age < RECENT_WINDOW_SECONDS:
                outcome = c.get("outcome") or "completed"
                if outcome in NON_OK_OUTCOMES:
                    flags.append(f"chain {c.get('chainId', '?')} {outcome}")
                recent_finalized.append(
                    {
                        "chainId": c.get("chainId", ""),
                        "outcome": outcome,
                        "endedAt": ended_raw,
                    }
                )

    # --- ENGINES ---
    def _hb_entry(name: str, data: dict[str, Any] | None) -> dict[str, Any]:
        hb = (data or {}).get("heartbeat")
        if hb is None:
            flags.append(f"{name} heartbeat missing")
            return {"name": name, "age": None, "stale": True, "enabled": False}
        age = _heartbeat_age_seconds(hb.get("at"))
        stale = age is None or age > STALE_AFTER_SECONDS
        enabled = bool(hb.get("enabled"))
        if stale:
            shown = "unparseable" if age is None else _format_age(age)
            flags.append(f"{name} tick stale {shown}")
        if not enabled:
            flags.append(f"{name} engine disabled")
        return {"name": name, "age": age, "stale": stale, "enabled": enabled}

    heartbeats = [
        _hb_entry("chain", chain_data),
        _hb_entry("watch", watch_data),
        _hb_entry("cron", cron_data),
    ]

    active_watches = len([
        w for w in ((watch_data or {}).get("watches") or [])
        if w.get("status") in ("scheduling", "watching")
    ])
    pending_scheds = [
        s for s in ((cron_data or {}).get("sched") or []) if s.get("status") == "armed"
    ]

    # --- VERDICT ---
    if flags:
        verdict = f"ATTENTION: {len(flags)} flag(s) — {'; '.join(flags)}"
    else:
        verdict = "OK"

    return {
        "chains": {"active": active_chains, "recent_finalized": recent_finalized},
        "engines": {
            "heartbeats": heartbeats,
            "active_watches": active_watches,
            "pending_scheds": [
                {"id": s.get("id", ""), "fireAt": s.get("fireAt", "")} for s in pending_scheds
            ],
        },
        "prs": {"open": prs},
        "flags": flags,
        "verdict": verdict,
    }, flags


def status(
    json_output: bool = typer.Option(False, "--json", help="Emit the status digest as JSON."),
) -> None:
    """One-screen driver check-in: chains, engine heartbeats, PRs, verdict. Read-only."""
    chain_data, watch_data, cron_data, prs, fetch_errors = _fetch_all()
    sections, flags = _analyze(chain_data, watch_data, cron_data, prs, fetch_errors)

    if json_output:
        console.print_json(data=sections)
        return

    # --- CHAINS ---
    console.rule("[bold]CHAINS[/bold]")
    active = sections["chains"]["active"]
    if active:
        t = Table(
            "chainId", "status", "stage", "loop iter", "findings",
            title=f"active ({len(active)})",
        )
        for row in active:
            stage_str = (
                f"{row['cursor'] + 1}/{row['total']}" if row["total"] else str(row["cursor"])
            )
            t.add_row(
                row["chainId"],
                row["status"],
                stage_str,
                str(row["iteration"]) if row["iteration"] is not None else "",
                str(row["findings"]) if row["findings"] is not None else "",
            )
        console.print(t)
    else:
        console.print("[dim]no active chains[/dim]")

    recent = sections["chains"]["recent_finalized"]
    if recent:
        t2 = Table("chainId", "outcome", "endedAt", title=f"finalized last 24h ({len(recent)})")
        for row in recent:
            outcome = row["outcome"]
            outcome_cell = f"[bold red]{outcome}[/bold red]" if outcome in NON_OK_OUTCOMES else outcome
            t2.add_row(row["chainId"], outcome_cell, row["endedAt"])
        console.print(t2)

    # --- ENGINES ---
    console.rule("[bold]ENGINES[/bold]")
    hb_table = Table("engine", "last tick", "stale?", "enabled")
    for hb in sections["engines"]["heartbeats"]:
        age = hb["age"]
        age_str = (_format_age(age) + " ago") if age is not None else "unknown"
        stale_cell = "[red]STALE[/red]" if hb["stale"] else "ok"
        hb_table.add_row(hb["name"], age_str, stale_cell, str(hb["enabled"]))
    console.print(hb_table)

    console.print(f"active watches: {sections['engines']['active_watches']}")

    pending = sections["engines"]["pending_scheds"]
    if pending:
        st = Table("id", "fireAt", title=f"pending scheds ({len(pending)})")
        for s in pending:
            st.add_row(s["id"], s["fireAt"])
        console.print(st)
    else:
        console.print("[dim]no pending scheduled fires[/dim]")

    # --- PULL REQUESTS ---
    console.rule("[bold]PULL REQUESTS[/bold]")
    open_prs = sections["prs"]["open"]
    if open_prs:
        t_prs = Table(
            "#", "title", "author",
            title=f"open ({len(open_prs)})",
        )
        for pr in open_prs:
            t_prs.add_row(
                str(pr.get("number", "?")),
                pr.get("title", ""),
                pr.get("author", ""),
            )
        console.print(t_prs)
    else:
        console.print("[dim]no open pull requests[/dim]")

    # --- VERDICT ---
    console.rule("[bold]VERDICT[/bold]")
    if flags:
        console.print(f"[bold red]ATTENTION: {len(flags)} flag(s)[/bold red]")
        for f in flags:
            console.print(f"  • {f}")
    else:
        console.print("[bold green]OK[/bold green]")
