"""h workspaces — clone-level admin for the shared workspace root, the sibling of `h worktrees`'
worktree admin.

Three commands: `link` — provision a repo's agent primitives (`.h/skills/`, `.h/rules/`) into
the locations agents actually read — `plugins`, which puts h's own consumer plugin where a
consumer repo's agents will actually load it, and `trust`, which stamps Claude Code's per-project
workspace trust for an h-managed checkout. The claude CLI ignores a repo's `permissions.allow`
entries until its path is trusted, and h's clones are never opened interactively, so the dialog that
grants trust never appears there. Under the local substrate's `--dangerously-skip-permissions`
runs the ignored entries are INERT (bypass never prompts), so nothing is broken — this command
exists for the operator who wants the warning gone and the allow-lists in effect, as an explicit
act rather than something h does to `~/.claude.json` on its own.
"""

import json
import os
import re
import shutil
import subprocess
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

# Claude Code's own plugin state. h reads these rather than trusting a command's exit code —
# see `verify_installed` for why that distinction is the whole point of the `plugins` command.
CLAUDE_PLUGINS = Path.home() / ".claude" / "plugins"
INSTALLED_PLUGINS = CLAUDE_PLUGINS / "installed_plugins.json"
KNOWN_MARKETPLACES = CLAUDE_PLUGINS / "known_marketplaces.json"
MARKETPLACES = CLAUDE_PLUGINS / "marketplaces"

PLUGIN = "h"
MARKETPLACE = "h-marketplace"
PLUGIN_REF = f"{PLUGIN}@{MARKETPLACE}"


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


def link_sources(repo: Path, *, dry_run: bool) -> list[str]:
    """Link skills whose files live elsewhere in the repo INTO `.h/skills/`.

    The first of two hops: this populates the source dir, and `link_skills` then publishes
    it to the agent pickup locations. It exists because a skill can have two audiences —
    `delegate-locally` is published to consumers from `plugins/h/skills/` AND used by h
    itself — and keeping a second copy in `.h/skills/` would be the drift this design avoids.

    Declared in `[sources]` rather than inferred from a directory listing, because which of the
    published skills h ALSO wants is a selection, not a rule.
    """
    manifest = repo / ".h" / MANIFEST
    if not manifest.is_file():
        return []
    try:
        sources = tomllib.loads(manifest.read_text()).get("sources", {})
    except (OSError, tomllib.TOMLDecodeError) as err:
        raise typer.BadParameter(f"unreadable {manifest}: {err}") from err
    made = []
    for name, rel in sources.items():
        target = repo / rel
        if not (target / "SKILL.md").is_file():
            raise typer.BadParameter(f'[sources] {name} = "{rel}" — no SKILL.md at {target}')
        link = repo / ".h" / "skills" / name
        want = os.path.relpath(target, link.parent)
        if link.is_symlink() and link.readlink().as_posix() == want:
            continue
        if link.exists() and not link.is_symlink():
            raise typer.BadParameter(
                f"{link} is a real directory — [sources] would replace it; remove it first"
            )
        if not dry_run:
            link.parent.mkdir(parents=True, exist_ok=True)
            link.unlink(missing_ok=True)
            link.symlink_to(want)
        made.append(name)
    return made


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


def why_none(src: Path, offered: list[str], chose: str) -> str:
    """Why a count of zero is zero — the three situations a bare `0 selected` cannot tell apart.

    A repo with no `.h/skills/`, a repo whose `.h/skills/` is empty, and a profile that
    deliberately selects nothing all produced the identical line `0 selected, 0 linked, 0 pruned`
    with a clean exit. Only the third is what the operator asked for; the first two mean their
    agents will run with no context and nothing said so. That is the same shape as the plugin bug
    this command's sibling exists to fix — a success line that cannot fail — so it gets the same
    treatment: say WHICH.
    """
    if not src.is_dir():
        return f"no {src.name}/ under .h/ — this repo provisions none"
    if not offered:
        return f".h/{src.name}/ is empty — nothing on offer"
    return f"{chose} selects none of the {len(offered)} on offer ({', '.join(offered)})"


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

    sourced = link_sources(repo, dry_run=dry_run)
    prof_skills, prof_rules = load_profile(repo, profile)
    skills_src, rules_src = repo / ".h" / "skills", repo / ".h" / "rules"
    offered_skills = available(skills_src, "SKILL.md")
    offered_rules = available(rules_src, "*.md")
    skills = resolve_names(skill or prof_skills, offered_skills)
    rules = resolve_names(rule or prof_rules or [], offered_rules) if (rule or prof_rules) else []

    linked, pruned = link_skills(repo, skills, dry_run=dry_run)
    steering = rules_target or (repo / ".claude" / "CLAUDE.md")
    changed = write_rules(repo, rules, steering, dry_run=dry_run)

    chose = (
        "--skill/--rule"
        if (skill or rule)
        else f"profile '{profile}'"
        if profile
        else "the default selection"
    )
    prefix = "[yellow]would[/yellow] " if dry_run else ""
    if sourced:
        console.print(f"{prefix}sources: {', '.join(sourced)} linked into .h/skills/")

    if skills:
        console.print(
            f"{prefix}skills: {len(skills)} selected, {len(linked)} linked, {len(pruned)} pruned"
        )
    else:
        console.print(f"skills: none — {why_none(skills_src, offered_skills, chose)}")
    if pruned:
        console.print(f"  pruned: {', '.join(pruned)}")

    if rules:
        console.print(
            f"{prefix}rules: {', '.join(rules)} → {steering}" + ("" if changed else " (unchanged)")
        )
    elif changed:
        console.print(f"{prefix}rules: block removed from {steering}")
    else:
        console.print(f"rules: none — {why_none(rules_src, offered_rules, chose)}")

    # The case the operator most needs told: they ran a provisioning command and the repo gained
    # NOTHING. Not an error — trxy legitimately has no primitives yet — but it must never read as
    # a successful provision, which is precisely how `0 selected, 0 linked, 0 pruned` read.
    if not skills and not rules and not pruned and not sourced:
        console.print(
            "[yellow]nothing was provisioned[/yellow] — agents here get no skills or rules from h."
        )


# --- plugins: h's consumer plugin, where agents will actually load it -------------------------
#
# DECLARING a plugin and INSTALLING one are different things, and conflating them cost 19 days.
# trxy committed the `.claude/settings.json` marketplace + enabledPlugins entries on 2026-08-13
# under a commit titled "install the h plugin". The plugin never loaded once: an agent running in
# a trxy worktree reported seven plugins in its init event and `h` was not among them, because
# nothing had written an `h@h-marketplace` entry to installed_plugins.json. Every plugin that DID
# load had one.
#
# Nothing surfaced that. The settings file said yes, the marketplace clone was present and
# current, and the only way to find out was to read what an agent actually loaded. So this command
# does three things in order, and the third is the one that matters: declare, install, then VERIFY
# by reading Claude Code's own registry back. A command that trusts its own success line would
# have reproduced exactly the failure it exists to fix.


def h_source(repo: Path) -> str:
    """The `owner/name` this repo pins h to, read from `.h/h.lock`.

    Derived from the pin rather than hardcoded, so a fork's consumer installs the fork's plugin —
    the marketplace and the CLI must come from the same place or the skills describe a different h
    than the one running. It also draws the boundary for free: a repo with no pin is not a
    consumer, which is what keeps h itself out (h must never enable its own plugin — the
    marketplace source is GitHub, so it would run a published copy against a live source tree).
    """
    lock = repo / ".h" / "h.lock"
    if not lock.is_file():
        raise typer.BadParameter(
            f"no {lock} — this repo does not pin h, so it is not an h consumer.\n"
            "  The h plugin is for repos that USE h. h's own checkout deliberately does not "
            "enable it."
        )
    match = re.search(r'^repo\s*=\s*"(.+?)"', lock.read_text(), re.MULTILINE)
    if not match:
        raise typer.BadParameter(f"{lock} declares no `repo` — cannot tell which h to install.")
    slug = re.sub(r"^https?://github\.com/", "", match.group(1).strip()).removesuffix(".git")
    if slug.count("/") != 1:
        raise typer.BadParameter(
            f"{lock}'s repo ({match.group(1)}) is not a github owner/name — "
            "the plugin marketplace can only be sourced from GitHub."
        )
    return slug


def declare_plugin(repo: Path, slug: str, *, dry_run: bool) -> bool:
    """Add the marketplace + enabledPlugins entries to `.claude/settings.json`, additively.

    Read-modify-write touching only h's two keys. The file is the REPO's — its other marketplaces,
    permissions and MCP settings must survive byte-for-byte in value terms, the same rule
    `stamp_trust` follows for `~/.claude.json` and `link_skills` follows for a real skill
    directory. Returns False when both entries already say what they should.
    """
    path = repo / ".claude" / "settings.json"
    config = json.loads(path.read_text()) if path.is_file() else {}
    want_source = {"source": "github", "repo": slug}
    enabled = config.setdefault("enabledPlugins", {})
    markets = config.setdefault("extraKnownMarketplaces", {})
    if (
        enabled.get(PLUGIN_REF) is True
        and markets.get(MARKETPLACE, {}).get("source") == want_source
    ):
        return False
    enabled[PLUGIN_REF] = True
    markets[MARKETPLACE] = {"source": want_source}
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(config, indent=2) + "\n")
    return True


def offered_version() -> str | None:
    """The plugin version the marketplace CLONE currently offers, or None if it is not cloned yet.

    Read so an install that is present but STALE is updated rather than reported as fine — the
    per-scope pinning trap: `claude plugin marketplace update` refreshes the clone and moves no
    install, so a project scope sits on its old snapshot indefinitely and nothing says so.
    """
    manifest = MARKETPLACES / MARKETPLACE / "plugins" / PLUGIN / ".claude-plugin" / "plugin.json"
    if not manifest.is_file():
        return None
    try:
        return json.loads(manifest.read_text()).get("version")
    except (OSError, ValueError):
        return None


def marketplace_registered() -> bool:
    """Whether Claude Code KNOWS the h marketplace — not merely whether its clone sits on disk.

    The two come apart: `marketplace remove` and a hand-edited config can leave either half
    without the other, and an install cannot resolve a marketplace the config does not know.
    Gating on the clone directory would be a PRESENCE check standing in for a READINESS one,
    which is the exact substitution this whole command exists to eliminate — so it reads the
    registry, the same way `verify_installed` refuses to read an exit code.
    """
    if not KNOWN_MARKETPLACES.is_file():
        return False
    try:
        return MARKETPLACE in json.loads(KNOWN_MARKETPLACES.read_text())
    except (OSError, ValueError):
        return False


def verify_installed(repo: Path) -> dict | None:
    """The PROJECT-scope install entry for this repo, straight from Claude Code's registry.

    This is the load-bearing half of the command. `installed_plugins.json` holds one entry per
    SCOPE — a `user` entry plus a `project` entry per projectPath — so a user-scope install proves
    nothing about the clone an agent runs in, and the entry for a sibling clone proves nothing
    about this one. Matching on the exact path is what makes a pass mean something.
    """
    if not INSTALLED_PLUGINS.is_file():
        return None
    try:
        registry = json.loads(INSTALLED_PLUGINS.read_text())
    except (OSError, ValueError):
        return None
    for entry in registry.get("plugins", {}).get(PLUGIN_REF, []):
        if entry.get("scope") == "project" and entry.get("projectPath") == str(repo):
            return entry
    return None


def claude_plugin(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    """Run `claude plugin …` from the repo, so `--scope project` binds to the right projectPath."""
    return subprocess.run(
        ["claude", "plugin", *args], cwd=cwd, capture_output=True, text=True, timeout=300
    )


@app.command()
def plugins(
    path: Annotated[
        Path | None,
        typer.Argument(help="The consumer repo to provision; default: the cwd's repository root."),
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Report what would change; write nothing.")
    ] = False,
    allow_external: Annotated[
        bool, typer.Option("--allow-external", help="Permit a repo outside the managed workspace.")
    ] = False,
) -> None:
    """Install h's consumer plugin into a repo, and prove it will actually load.

    Declares the marketplace and plugin in `.claude/settings.json`, installs at PROJECT scope, and
    then reads Claude Code's install registry back to confirm it took. Idempotent — re-run it after
    a plugin version bump, which is the normal case rather than an exception.
    """
    target = Path(path) if path is not None else Path(repo_root(Path.cwd()))
    try:
        repo = assert_managed(target, allow_external=allow_external, flag="path")
    except ExternalWorkspaceError as err:
        err_console.print(f"[red]{err}[/red]")
        raise typer.Exit(1) from err

    slug = h_source(repo)
    prefix = "[yellow]would[/yellow] " if dry_run else ""
    declared = declare_plugin(repo, slug, dry_run=dry_run)
    console.print(
        f"{prefix}declare: {PLUGIN_REF} from {slug} → {repo / '.claude/settings.json'}"
        + ("" if declared else " (already declared)")
    )

    if not shutil.which("claude"):
        err_console.print(
            "[red]claude is not on PATH[/red] — h never auto-installs it. The declaration above "
            "is written, but the plugin cannot be installed or verified from here."
        )
        raise typer.Exit(1)

    entry = verify_installed(repo)
    offered = offered_version()
    if dry_run:
        state = f"installed {entry['version']}" if entry else "NOT installed"
        console.print(f"would install: {PLUGIN_REF} at project scope (currently {state})")
        if entry and offered and entry.get("version") != offered:
            console.print(f"  would update: {entry['version']} → {offered}")
        return

    # The marketplace has to be REGISTERED before an install can resolve it, and a fresh consumer
    # has never added it. `add` reports failure when it is already present, so its outcome is
    # deliberately not fatal — the install below, and the read-back after it, are the real gates.
    if not marketplace_registered():
        console.print(f"marketplace: adding {slug}…")
        claude_plugin(["marketplace", "add", slug], repo)

    if entry and offered and entry.get("version") == offered:
        console.print(f"install: {PLUGIN_REF} {offered} already at project scope")
    else:
        verb = "update" if entry else "install"
        console.print(f"install: running `claude plugin {verb} {PLUGIN_REF} --scope project`…")
        done = claude_plugin([verb, PLUGIN_REF, "--scope", "project", "-y"], repo)
        if done.returncode != 0:
            err_console.print(f"[red]claude plugin {verb} failed[/red]\n{done.stderr.strip()}")
            raise typer.Exit(1)

    # VERIFY. Never the command's success line — that is exactly what was trusted for 19 days.
    final = verify_installed(repo)
    if final is None:
        err_console.print(
            f"[red]✗ {PLUGIN_REF} is declared but NOT installed for {repo}[/red]\n"
            f"  Nothing in {INSTALLED_PLUGINS} names this project path, so an agent running here "
            "will load no h skills.\n"
            "  The install command reported success; the registry disagrees. Do not trust the "
            "former."
        )
        raise typer.Exit(1)
    console.print(
        f"[green]✓ verified[/green] {PLUGIN_REF} {final.get('version')} at project scope "
        f"({final.get('installPath')})"
    )
    console.print("  restart any running session — it keeps the plugin set it started with.")


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
