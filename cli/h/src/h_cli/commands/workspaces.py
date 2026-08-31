"""h workspaces — clone-level admin for the shared workspace root, the sibling of `h worktrees`'
worktree admin.

Two commands: `link` — provision a repo's agent primitives (`.h/skills/`, `.h/rules/`) into the
locations agents actually read — and `trust`, which stamps Claude Code's per-project workspace
trust for an h-managed checkout. The claude CLI ignores a repo's `permissions.allow` entries
until its path is trusted, and h's clones are never opened interactively, so the dialog that
grants trust never appears there. Under the local substrate's `--dangerously-skip-permissions`
runs the ignored entries are INERT (bypass never prompts), so nothing is broken — this command
exists for the operator who wants the warning gone and the allow-lists in effect, as an explicit
act rather than something h does to `~/.claude.json` on its own.
"""

import json
import tomllib
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from h_cli.infrastructure.local_runtime import repo_root
from h_cli.infrastructure.workspace import ExternalWorkspaceError, assert_managed

app = typer.Typer(no_args_is_help=True, help="Workspace clones: link, trust.")
console = Console()
err_console = Console(stderr=True)

CLAUDE_CONFIG = Path.home() / ".claude.json"


def stamp_trust(config_path: Path, project_path: Path) -> bool:
    """Set `projects[<path>].hasTrustDialogAccepted: true` in the claude CLI's config.

    Read-modify-write that touches ONLY that key — the file is the claude CLI's own state
    and everything else in it must survive byte-for-byte in value terms. Returns False when
    the entry was already trusted (idempotent). A missing file is created with just this
    entry; the claude CLI fills its own defaults on next run.
    """
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    projects = config.setdefault("projects", {})
    entry = projects.setdefault(str(project_path), {})
    if entry.get("hasTrustDialogAccepted") is True:
        return False
    entry["hasTrustDialogAccepted"] = True
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    return True


# --- link: agent primitives into the locations agents read ------------------------------------
#
# `.h/skills/` and `.h/rules/` are the SOURCE, identical in h and in any repo that consumes it, so
# this runs one code path with no branch on repo kind. Skills become directory symlinks (proven:
# the agent discovers a skill through a link, and a relative link resolves inside a worktree);
# rules become one managed block in a steering file, because several rules cannot symlink onto one
# path.
#
# SELECTION is the point, not just installation. A profile in `.h/context.toml` gives a mode its
# usual set, and explicit flags override it per invocation — the split `h.pluginSetupSteps` already
# uses (curated sources baked at publish, WHICH ones fire-time). That is what lets one workflow run
# A with one skill and run B with another.

RULES_BEGIN = (
    "<!-- BEGIN h primitives (managed by h — edits between the markers are overwritten) -->"
)
RULES_END = "<!-- END h primitives -->"
MANIFEST = "context.toml"


def load_profile(repo: Path, profile: str | None) -> tuple[list[str] | None, list[str] | None]:
    """The (skills, rules) a profile selects, or (None, None) when there is nothing to read.

    `None` means UNSELECTED — fall back to the caller's default — while `[]` means a profile
    deliberately selects nothing, which is how a mode turns a rule off. Collapsing the two would
    make "no manifest" and "an empty profile" indistinguishable.
    """
    manifest = repo / ".h" / MANIFEST
    if profile is None or not manifest.is_file():
        return None, None
    try:
        profiles = tomllib.loads(manifest.read_text()).get("profiles", {})
    except (OSError, tomllib.TOMLDecodeError) as err:
        raise typer.BadParameter(f"unreadable {manifest}: {err}") from err
    if profile not in profiles:
        known = ", ".join(sorted(profiles)) or "none defined"
        raise typer.BadParameter(f"no profile '{profile}' in {manifest} (have: {known})")
    entry = profiles[profile]
    return entry.get("skills"), entry.get("rules")


def available(src: Path, marker: str) -> list[str]:
    """What the source dir offers: skill directories carrying a SKILL.md, or rule *.md files."""
    if not src.is_dir():
        return []
    if marker == "SKILL.md":
        return sorted(d.name for d in src.iterdir() if (d / "SKILL.md").is_file())
    return sorted(f.stem for f in src.iterdir() if f.suffix == ".md")


def resolve_names(selected: list[str] | None, offered: list[str]) -> list[str]:
    """`["*"]` or an unselected None means everything on offer; anything else is taken literally."""
    if selected is None or selected == ["*"]:
        return offered
    unknown = [n for n in selected if n not in offered]
    if unknown:
        raise typer.BadParameter(
            f"not available: {', '.join(unknown)} (have: {', '.join(offered) or 'none'})"
        )
    return selected


def link_skills(repo: Path, names: list[str], *, dry_run: bool) -> tuple[list[str], list[str]]:
    """Point `.claude/skills/<name>` at `.h/skills/<name>`; unlink what is no longer selected.

    Pruning is NOT optional. Selection only means something if a deselected skill actually goes
    away — otherwise run B of a workflow silently inherits run A's, which is the exact experiment
    this command exists to make possible.

    It only ever touches links it owns: a link INTO `.h/skills/`. A real directory is the repo's
    own skill and a link pointing elsewhere is somebody else's; both are left alone.
    """
    dest = repo / ".claude" / "skills"
    linked, pruned = [], []
    if not dry_run:
        dest.mkdir(parents=True, exist_ok=True)
    for name in names:
        link = dest / name
        want = f"../../.h/skills/{name}"
        if link.is_symlink() and link.readlink().as_posix() == want:
            continue
        if link.exists() and not link.is_symlink():
            raise typer.BadParameter(
                f"{link} is a real directory — the repo's own skill; refusing to replace it"
            )
        if not dry_run:
            link.unlink(missing_ok=True)
            link.symlink_to(want)
        linked.append(name)
    if dest.is_dir():
        for entry in sorted(dest.iterdir()):
            if entry.name in names or not entry.is_symlink():
                continue
            if not entry.readlink().as_posix().startswith("../../.h/skills/"):
                continue  # not ours to remove
            if not dry_run:
                entry.unlink()
            pruned.append(entry.name)
    return linked, pruned


def write_rules(repo: Path, names: list[str], target: Path, *, dry_run: bool) -> bool:
    """Write the selected rules into ONE managed block in `target`, preserving everything else.

    A marker block rather than owning the file outright: `.claude/CLAUDE.md` happens to be free in
    every repo checked so far, but three repos is an observation, not a guarantee, and another
    agent's steering file (AGENTS.md) may have no free slot at all. Markers work in both cases, so
    there is one path instead of a fallback chain nobody exercises.

    An empty selection REMOVES the block — that is how a mode turns h's rules off.
    """
    src = repo / ".h" / "rules"
    body = "\n\n".join((src / f"{n}.md").read_text().strip() for n in names)
    block = f"{RULES_BEGIN}\n{body}\n{RULES_END}\n" if names else ""
    existing = target.read_text() if target.is_file() else ""
    if RULES_BEGIN in existing and RULES_END in existing:
        head, rest = existing.split(RULES_BEGIN, 1)
        tail = rest.split(RULES_END, 1)[1].lstrip("\n")
        updated = f"{head}{block}{tail}"
    else:
        updated = f"{block}{existing}" if block else existing
    if updated == existing:
        return False
    if not dry_run:
        if updated.strip():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(updated)
        else:
            # Removing the last block must not leave an empty steering file behind: a reader who
            # finds one cannot tell "h deliberately applies no rules here" from "something failed".
            target.unlink(missing_ok=True)
    return True


@app.command()
def link(
    path: Annotated[
        Path | None,
        typer.Argument(help="The repo to provision; default: the cwd's repository root."),
    ] = None,
    profile: Annotated[
        str | None,
        typer.Option(
            "--profile", "-P", help="A profile from .h/context.toml (e.g. container, local)."
        ),
    ] = None,
    skill: Annotated[
        list[str] | None,
        typer.Option(
            "--skill", help="Link exactly these skills; repeatable. Overrides the profile."
        ),
    ] = None,
    rule: Annotated[
        list[str] | None,
        typer.Option(
            "--rule", help="Apply exactly these rules; repeatable. Overrides the profile."
        ),
    ] = None,
    rules_target: Annotated[
        Path | None,
        typer.Option(
            "--rules-target",
            help="Steering file the rules block is written to; default .claude/CLAUDE.md.",
        ),
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Report what would change; write nothing.")
    ] = False,
    allow_external: Annotated[
        bool, typer.Option("--allow-external", help="Permit a repo outside the managed workspace.")
    ] = False,
) -> None:
    """Provision this repo's agent primitives into the locations agents read.

    Skills in `.h/skills/` become symlinks under `.claude/skills/`; rules in `.h/rules/` become one
    managed block in a steering file. Selection comes from `--skill`/`--rule` if given, else the
    named profile, else everything on offer — so a bare `h workspaces link` is the whole set and a
    workflow's setup step can narrow it per run.

    Writes files; never commits them. The diff is yours (or the agent's) to commit, the way
    `npm install` leaves one.
    """
    target = Path(path) if path is not None else Path(repo_root(Path.cwd()))
    try:
        repo = assert_managed(target, allow_external=allow_external, flag="path")
    except ExternalWorkspaceError as err:
        err_console.print(f"[red]{err}[/red]")
        raise typer.Exit(1) from err

    prof_skills, prof_rules = load_profile(repo, profile)
    skills = resolve_names(skill or prof_skills, available(repo / ".h" / "skills", "SKILL.md"))
    rules = (
        resolve_names(rule or prof_rules or [], available(repo / ".h" / "rules", "*.md"))
        if (rule or prof_rules)
        else []
    )

    linked, pruned = link_skills(repo, skills, dry_run=dry_run)
    steering = rules_target or (repo / ".claude" / "CLAUDE.md")
    changed = write_rules(repo, rules, steering, dry_run=dry_run)

    prefix = "[yellow]would[/yellow] " if dry_run else ""
    console.print(
        f"{prefix}skills: {len(skills)} selected, {len(linked)} linked, {len(pruned)} pruned"
    )
    if pruned:
        console.print(f"  pruned: {', '.join(pruned)}")
    if rules:
        console.print(
            f"{prefix}rules: {', '.join(rules)} → {steering}" + ("" if changed else " (unchanged)")
        )
    elif changed:
        console.print(f"{prefix}rules: block removed from {steering}")


@app.command()
def trust(
    path: Annotated[
        Path | None,
        typer.Argument(
            help="An h-managed checkout (a workspace clone or an h worktree); "
            "default: the cwd's repository root.",
        ),
    ] = None,
) -> None:
    """Trust an h-managed checkout for Claude Code (its permissions.allow takes effect).

    Deliberately scoped to the managed workspace boundary: h vouches only for checkouts it
    owns, and only when the operator asks. An external repo is trusted the normal way —
    run claude there interactively and accept the dialog.
    """
    target = Path(path) if path is not None else Path(repo_root(Path.cwd()))
    try:
        resolved = assert_managed(target, flag="path")
    except ExternalWorkspaceError as err:
        err_console.print(f"[red]{err}[/red]")
        raise typer.Exit(1) from err
    if not resolved.is_dir():
        err_console.print(f"[red]not a directory:[/red] {resolved}")
        raise typer.Exit(1)
    if stamp_trust(CLAUDE_CONFIG, resolved):
        console.print(f"[green]trusted[/green] {resolved} — permissions.allow now applies here")
    else:
        console.print(f"already trusted: {resolved}")
