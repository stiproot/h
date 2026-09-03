"""The quota gate's CLI half — the two flags every fire surface shares, and the wire shape they
build.

`--on-quota` and `--ignore-quota` mean the same thing on both substrates (the gate is
engine-core's `QuotaGate`, riding the fire descriptor): before each agent step the run reads
what that executor's CLI LAST reported about its rate-limit windows (`quota:<executor>`) and
refuses by name when the step would not fit — or, with `wait`, defers it past the window's
reset. `--ignore-quota` is the operator's override. The flags live here rather than in one
command so `h workflow run`, `h chain run` and `h delegate` cannot drift apart on their help
text or their wire shape.
"""

from typing import Annotated, Any

import typer

OnQuotaOpt = Annotated[
    str | None,
    typer.Option(
        "--on-quota",
        metavar="fail|wait",
        help="What an agent step does when its executor's rate-limit window would not fit it "
        "(read from what that CLI last reported — `h agents list`): `fail` (default) refuses "
        "by name before spending anything; `wait` defers past the window's reset instead — "
        "the local driver sleeps between steps (up to 6h), the service watcher arms a "
        "same-identity continuation (implies --watch).",
    ),
]

IgnoreQuotaOpt = Annotated[
    bool,
    typer.Option(
        "--ignore-quota",
        help="Skip the quota gate for this fire. The provider still adjudicates; this only "
        "removes h's pre-fire refusal (e.g. the last report is known to be stale).",
    ),
]


def quota_gate(on_quota: str | None, ignore: bool) -> dict[str, Any] | None:
    """`--on-quota`/`--ignore-quota` → the `QuotaGate` wire shape, or None for the defaults."""
    if on_quota is not None and on_quota not in ("fail", "wait"):
        raise typer.BadParameter(
            f"expected fail or wait, got {on_quota!r}", param_hint="--on-quota"
        )
    if on_quota is None and not ignore:
        return None
    gate: dict[str, Any] = {"onQuota": on_quota or "fail"}
    if ignore:
        gate["ignore"] = True
    return gate


WINDOW_LABEL = {"five_hour": "5h", "seven_day": "7d"}


def _local_clock(iso: str) -> str:
    """An ISO instant → `HH:MM` in the operator's local zone (a reset is read against a watch)."""
    from datetime import datetime

    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return iso


def quota_cell(row: dict[str, Any] | None, now_iso: str | None = None) -> str:
    """One executor's `quota:` row → `5h 62% → 14:05 · 7d 31% → Tue 09:00`, or `-` when nothing
    has been observed. A window whose reset has passed reads as `reset` — the observation is
    stale in its favour, and the next run rewrites it. `!` marks a rejected (exhausted) report."""
    if not row:
        return "-"
    from datetime import UTC, datetime

    now = datetime.fromisoformat(now_iso.replace("Z", "+00:00")) if now_iso else datetime.now(UTC)
    parts: list[str] = []
    for name, label in WINDOW_LABEL.items():
        window = (row.get("windows") or {}).get(name)
        if not window:
            continue
        try:
            resets = datetime.fromisoformat(str(window["resetsAt"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            resets = None
        if resets is not None and resets <= now:
            parts.append(f"{label} reset")
            continue
        pct = f"{round(float(window.get('utilization', 0)) * 100)}%"
        when = _local_clock(str(window["resetsAt"])) if resets is not None else "?"
        if resets is not None and (resets - now).days >= 1:
            when = resets.astimezone().strftime("%a %H:%M")
        parts.append(f"{label} {pct} → {when}")
    if not parts:
        return "-"
    mark = "!" if row.get("status") == "rejected" else ""
    return mark + " · ".join(parts)
