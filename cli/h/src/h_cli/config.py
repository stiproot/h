"""Settings — env > the consumer repo's .h/config.toml > mode defaults, per setting.

TWO INSTALL MODES, detected rather than configured:

- **Checkout (editable)**: the CLI runs from the h repo (uv workspace member), so file-relative
  resolution reaches it — this file lives at cli/h/src/h_cli/config.py, making parents[3] the
  cli/ dir. Charts, the built runner, and the workspace siblings all derive from the checkout.
- **Packaged (wheel)**: the CLI is `uv tool install`ed; parents[3] is site-packages nonsense, so
  file-relative derivation would be silently wrong — the h-packaged plan's landmine. Instead the
  wheel SHIPS the stock charts and a bundled runner under `h_cli/_bundled/` (built by
  hatch_build.py from the full repo), and the workspace defaults move under `~/.h/`. Detection
  is the presence of the checkout's chart tree; a wheel that somehow lacks its bundle refuses
  loud at the point of use, never guesses.
"""

import os
import tomllib
from pathlib import Path

_CLI_DIR = Path(__file__).resolve().parents[3]
_REPO_DIR = _CLI_DIR.parent
_BUNDLED_DIR = Path(__file__).resolve().parent / "_bundled"

# Checkout mode iff the editable install's file-relative derivation actually lands in an h
# checkout. Everything mode-dependent branches on this ONCE.
IS_CHECKOUT = (_CLI_DIR / "charts" / "workflows").is_dir()
# The packaged workspace home: h-owned, tidy, overridable per consumer repo or env.
_PACKAGED_HOME = Path.home() / ".h"

# --- Consumer-repo config (.h/config.toml) ---------------------------------------------------
# A repo that CONSUMES h — carrying its own domain chart, firing `h … --local` from its own
# checkout — declares its paths once in `<repo>/.h/config.toml` instead of exporting env vars
# per shell. The CLI discovers the file by walking UP from the invoking cwd (first hit wins), so
# `h` behaves per-repo the way `git` does. Precedence per setting stays explicit-first:
# env var > .h/config.toml > h-checkout default. Relative paths in the file resolve against the
# repo that carries it; absolute paths pass through. Unknown keys and non-string values fail
# LOUD — a typo'd key silently falling back to a default is how a run lands in the wrong charts.
_CONSUMER_KEYS = frozenset(
    {
        "charts_dir",  # → H_CHARTS_DIR
        "local_bin",  # → H_LOCAL_BIN
        "workspace_dir",  # → H_WORKSPACE_DIR
        "worktrees_dir",  # → H_LOCAL_WORKTREES_DIR
        "runs_dir",  # → AGENT_RUNS_DIR
        "dotenv",  # → H_DOTENV
        "events_store",  # → H_EVENTS_STORE
    }
)


def _discover_consumer_config() -> tuple[Path | None, dict[str, str]]:
    """The nearest ancestor `.h/config.toml`, as (repo root carrying it, parsed keys)."""
    cwd = Path.cwd().resolve()
    for candidate in (cwd, *cwd.parents):
        path = candidate / ".h" / "config.toml"
        if not path.is_file():
            continue
        try:
            loaded = tomllib.loads(path.read_text())
        except tomllib.TOMLDecodeError as err:
            raise SystemExit(f"h: malformed {path}: {err}") from err
        unknown = sorted(set(loaded) - _CONSUMER_KEYS)
        if unknown:
            raise SystemExit(
                f"h: unknown key(s) in {path}: {', '.join(unknown)} — "
                f"supported: {', '.join(sorted(_CONSUMER_KEYS))}"
            )
        non_string = sorted(key for key, value in loaded.items() if not isinstance(value, str))
        if non_string:
            raise SystemExit(f"h: {path}: values must be path strings: {', '.join(non_string)}")
        return candidate, loaded
    return None, {}


CONSUMER_CONFIG_ROOT, _CONSUMER_CONF = _discover_consumer_config()


def _setting(env: str, key: str, default: Path) -> Path:
    """One setting under the precedence rule. Config-file paths resolve against the consumer
    repo root (absolute values pass through pathlib's `/` untouched); `~` expands in both env
    and file values, so a consumer config can name machine-relative homes portably
    (`workspace_dir = "~/code/h-workspace"`)."""
    value = os.getenv(env)
    if value:
        return Path(value).expanduser()
    if CONSUMER_CONFIG_ROOT is not None and key in _CONSUMER_CONF:
        configured = Path(_CONSUMER_CONF[key]).expanduser()
        return (CONSUMER_CONFIG_ROOT / configured).resolve()
    return default


# Template source (strategy 2 — see cli/README.md). STOCK_CHARTS_DIR is h's own chart and the
# FALLBACK of the search path below; CHARTS_DIR is the primary (a consumer's own chart when
# configured, else the stock chart itself). Packaged mode reads the stock chart from the wheel's
# bundle — same templates, shipped instead of checked out.
STOCK_CHARTS_DIR = _CLI_DIR / "charts" if IS_CHECKOUT else _BUNDLED_DIR / "charts"
CHARTS_DIR = _setting("H_CHARTS_DIR", "charts_dir", STOCK_CHARTS_DIR)


def charts_roots() -> tuple[Path, ...]:
    """The chart search path: the primary root first, h's stock chart as fallback.

    This is what makes a consumer chart ADDITIVE: pointing charts_dir/H_CHARTS_DIR at a domain
    chart keeps the stock templates reachable instead of replacing all of them (the
    all-or-nothing failure the h-packaged POC hit live, 2026-08-13). A name present in both
    resolves to the primary — shadowing a stock template is the overlay semantics, not an error.
    """
    if CHARTS_DIR.resolve() == STOCK_CHARTS_DIR.resolve():
        return (STOCK_CHARTS_DIR,)
    return (CHARTS_DIR, STOCK_CHARTS_DIR)


def chart_root_for(template: str) -> Path | None:
    """The chart root whose workflows chart carries `template`, in charts_roots() order."""
    for root in charts_roots():
        if (root / "workflows" / "templates" / f"{template}.tmpl.yaml").is_file():
            return root
    return None


# --- Local execution substrate -------------------------------------------------------------
# The runner the CLI spawns instead of firing a workflow through workflow-svc. Checkout mode: the
# built workspace package (`bun run build` is the one prerequisite). Packaged mode: the wheel's
# bundled single-file runner — CLI and runner ship together, so they cannot skew.
LOCAL_BIN = _setting(
    "H_LOCAL_BIN",
    "local_bin",
    _REPO_DIR / "packages/js/local-runtime/dist/bin.js"
    if IS_CHECKOUT
    else _BUNDLED_DIR / "h-local.mjs",
)

# Run-ledger root. Defaults to the SAME directory the agent services write (host mode's
# AGENT_BASE_DIR sibling, which is the compose bind mount too), so a local run shows up in
# `h runs`, obs-mcp and the viz beside service runs instead of in a private ledger.
# .resolve() is load-bearing, not cosmetic: these defaults are built with `..`, and a path
# carrying `..` compares FALSE under Path.is_relative_to, which is purely lexical. `h worktrees`
# filtered its entries that way and so found nothing at all in the default configuration (caught
# on its first real run, 2026-08-06). Resolving here fixes every consumer at once — and stops the
# unresolved form leaking into user-facing output.
AGENT_RUNS_DIR = _setting(
    "AGENT_RUNS_DIR",
    "runs_dir",
    _REPO_DIR / "../h-workspace/.runs" if IS_CHECKOUT else _PACKAGED_HOME / "workspace/.runs",
).resolve()

# Where per-agent worktrees are cut for a delegated write task.
LOCAL_WORKTREES_DIR = _setting(
    "H_LOCAL_WORKTREES_DIR",
    "worktrees_dir",
    _REPO_DIR / "../h-worktrees" if IS_CHECKOUT else _PACKAGED_HOME / "worktrees",
).resolve()

# The workspace root h OWNS: the clones it works on live here (`h-workspace/<repo>`), beside the
# run ledger and the fabric's store. The SERVICE substrate has always used it (the agents' shared
# workspace root, `<sharedRoot>/repo` for the /worktree route); making the LOCAL substrate honour
# the same root is what keeps the two symmetric — one place to look for "what h is working on",
# and one boundary an operator's own checkouts sit outside of.
H_WORKSPACE_DIR = _setting(
    "H_WORKSPACE_DIR",
    "workspace_dir",
    _REPO_DIR / "../h-workspace" if IS_CHECKOUT else _PACKAGED_HOME / "workspace",
).resolve()

# --- Local event fabric ----------------------------------------------------------------------
# The local substrate's event fabric: one nats-server -js child (`h events up`), no containers.
# The JetStream store sits beside the run ledger so "reset the local runtime state" is one
# directory tree, and NATS_URL is the standard client env var so external tooling (the `nats`
# CLI) reads the same fabric without configuration.
EVENTS_URL = os.getenv("NATS_URL", "nats://127.0.0.1:4222")
EVENTS_STORE_DIR = _setting(
    "H_EVENTS_STORE", "events_store", AGENT_RUNS_DIR.parent / ".nats"
).resolve()

# The repo's .env — the same file compose and the run scripts feed the agent services from. A
# local run reads it too, so the substrate does not need its own credential setup.
# Packaged mode has no checkout .env; ~/.h/.env is the credentials-gap file there (a missing
# file reads as {} — the soft-dependency semantics are unchanged).
DOTENV_PATH = _setting(
    "H_DOTENV", "dotenv", _REPO_DIR / ".env" if IS_CHECKOUT else _PACKAGED_HOME / ".env"
)
FEATURE_SPECS_DIR = Path(
    os.getenv("H_FEATURE_SPECS_DIR", str(_CLI_DIR / "scripts/payloads/domain/feature-requests"))
)

WORKFLOW_URL = os.getenv("WORKFLOW_URL", "http://localhost:8003")  # workflow-svc app
AGENT_URL = os.getenv("AGENT_URL", "http://localhost:8010")  # workflow-agent app
DAPR_HTTP_PORT = os.getenv("DAPR_HTTP_PORT", "3510")  # workflow-agent's Dapr sidecar
STATE_URL = f"http://localhost:{DAPR_HTTP_PORT}/v1.0/state/statestore"

# Agent-service registry for --agent flags: app ports as pinned by cli/scripts/run-*.sh
# (the full map is in README.md). Any of these can host the standard POST /workflow
# submit-and-babysit endpoint; a full http(s) URL is also accepted wherever a name is.
AGENT_URLS = {
    "claude-agent": "http://localhost:8002",
    "openhands-agent": "http://localhost:8004",
    "pi-agent": "http://localhost:8015",
    "codex-agent": "http://localhost:8016",
    "kimi-agent": "http://localhost:8017",
    "dapr-agent": "http://localhost:8006",
    "dapr-claude-loop-agent": "http://localhost:8007",
    "langgraph-agent": "http://localhost:8009",
    "workflow-agent": "http://localhost:8010",
}


def resolve_agent_url(agent: str) -> str | None:
    """An http(s) URL passes through; otherwise look the name up in the registry."""
    if agent.startswith(("http://", "https://")):
        return agent
    return AGENT_URLS.get(agent)


# Fire-time identity mapping (chain-composition-surface §1.9): a user-facing --agent name → the
# {runActivity, agentId} param pair a published template's identity slots consume. An explicit
# table, deliberately not a naming convention (run-dapr-agent's agentId is 'dapr-agent', not
# 'dapr-agent-agent'). Only agents whose run activity takes the shared {cwd,model,task} input
# belong here — extend as more agents earn a run-* activity.
AGENT_IDENTITY: dict[str, tuple[str, str]] = {
    "claude": ("run-claude", "claude-agent"),
    "claude-agent": ("run-claude", "claude-agent"),
    "openhands": ("run-openhands", "openhands-agent"),
    "openhands-agent": ("run-openhands", "openhands-agent"),
    "pi": ("run-pi", "pi-agent"),
    "pi-agent": ("run-pi", "pi-agent"),
    "codex": ("run-codex", "codex-agent"),
    "codex-agent": ("run-codex", "codex-agent"),
    "kimi": ("run-kimi", "kimi-agent"),
    "kimi-agent": ("run-kimi", "kimi-agent"),
}

# The model param slots publish-mode templates expose (chain's KIND_MODEL_PARAMS, unioned).
# `--model` is execution machinery (like `--agent`): it sets these slots on `h workflow run`.
MODEL_PARAM_SLOTS: tuple[str, ...] = (
    "modelPlan",
    "modelImplement",
    "modelReview",
    "modelRevise",
    "modelAnswer",
)

# Saved keys whose executor is pinned: --agent is warned-and-ignored, never applied. review-pr's
# executor is the loop's consistent reviewer (claude-agent). Under the trust model this pin is an
# operational default, not a security boundary (a
# minimal-surface reviewer returns as a per-run trust profile if untrusted repos do).
FROZEN_EXECUTOR_KEYS: frozenset[str] = frozenset({"review-pr"})


# The executor a chart template's BAKED models were chosen for — `agentId` in
# cli/charts/workflows/values.yaml. Templates bake claude model ids (implement.models.plan =
# claude-sonnet-4-6, …) because claude is the chart's default executor.
DEFAULT_TEMPLATE_AGENT_ID = "claude-agent"


def baked_models_suit(agent: str) -> bool:
    """True when `agent` is the executor a template's baked models were chosen for.

    A baked model BELONGS TO its executor: `claude-sonnet-4-6` is meaningless to an
    openhands-agent pointed at DeepSeek, which rejects it outright
    (`LLMBadRequestError: … but you passed claude-sonnet-4-6`, hit live 2026-07-27 — the run
    exited 0 with empty output, so the cause was invisible). `--agent` and `--model` are
    independent axes, so switching executor without also switching model is a guaranteed
    failure that LOOKS like a valid command.

    panelize.py already encodes this rule for roster branches ("a baked model belongs to the
    original executor; each branch falls back to its own AGENT_MODEL"); this is the same rule
    for a SINGLE `--agent`.
    """
    identity = AGENT_IDENTITY.get(agent)
    return identity is not None and identity[1] == DEFAULT_TEMPLATE_AGENT_ID


def agent_identity_params(agent: str) -> dict[str, str] | None:
    """A user-facing `--agent` name → the {runActivity, agentId} fire-time params a published
    template's identity slots consume, or None if the name is unknown. The single expansion both
    `h workflow run` and `h chain run` use, so `--agent` means the SAME thing in both."""
    identity = AGENT_IDENTITY.get(agent)
    if identity is None:
        return None
    return {"runActivity": identity[0], "agentId": identity[1]}
