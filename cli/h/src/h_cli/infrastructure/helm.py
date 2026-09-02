"""Helm-as-templating-engine adapter — the Python sibling of cli/scripts/_render.sh.

Rendered YAML is the canonical artifact. to_wire_json is a *final processing step*, applied only
at the wire boundary because today's consumers (workflow-svc, workflow-mcp run_workflow) speak
JSON; nothing upstream of that call assumes JSON.
"""

import json
import shutil
import subprocess
from pathlib import Path

import yaml

from h_cli.config import CHARTS_DIR, chart_root_for, charts_roots


class HelmError(RuntimeError):
    """Raised when helm is missing or a render fails; str(err) is user-presentable."""


def render_workflow(
    template: str,
    values: dict[str, str] | None = None,
    file_values: dict[str, Path] | None = None,
    include_local: bool = True,
) -> str:
    """Render one workflow template (charts/workflows/templates/<template>.tmpl.yaml) to YAML.

    Merges the gitignored org-specific overrides (values.local.yaml) when present, then the given
    --set / --set-file values. Output is stripped of helm's document separator and "# Source:"
    comment. Note --set splits on commas and dots; fine for the branch-safe tokens passed here —
    route anything richer through file_values. include_local=False renders from chart defaults
    only (hermetic — used by the golden tests, and anywhere reproducibility beats convenience).
    """
    if shutil.which("helm") is None:
        raise HelmError("helm is required on PATH (https://helm.sh) — it renders cli/charts")
    # The owning chart root comes from the search path (consumer primary, stock fallback); an
    # unknown template falls through to the primary so helm's own missing-file error surfaces.
    chart = (chart_root_for(template) or CHARTS_DIR) / "workflows"
    # --set template=… gates which template body evaluates: helm renders every template even under
    # -s, so without the gate one template's `required` values would break another's render.
    cmd = [
        "helm",
        "template",
        template,
        str(chart),
        "-s",
        f"templates/{template}.tmpl.yaml",
        "--set",
        f"template={template}",
    ]
    for values_file in values_layers(chart, include_local):
        cmd += ["--values", str(values_file)]
    for key, value in (values or {}).items():
        cmd += ["--set", f"{key}={value}"]
    for key, path in (file_values or {}).items():
        cmd += ["--set-file", f"{key}={path}"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        # helm's own messages (required-value, schema violations) are already user-facing.
        raise HelmError(proc.stderr.strip())
    lines = [
        line
        for line in proc.stdout.splitlines()
        if line != "---" and not line.startswith("# Source: ")
    ]
    return "\n".join(lines).strip() + "\n"


def values_layers(chart: Path, include_local: bool = True) -> list[Path]:
    """The values files layered over `chart`'s own values.yaml, lowest precedence first.

    The chart search path resolves TEMPLATES consumer-first with h's stock chart as fallback;
    this is the same rule for VALUES. A stock template rendered from a consumer repo layers the
    consumer's `workflows/values.yaml` (committed — the repo's own facts: its acceptance command,
    the gitignored files a fresh worktree needs, its git auth) over the stock defaults, then each
    root's gitignored `values.local.yaml` for machine-local overrides. Without this a consumer
    could not compose `verify` at all: `verify.cmd` is `required` at render time and its only
    value lived in the stock chart's values.local.yaml, which a packaged install does not have
    (bit trxy live 2026-09-01 — the acceptance gate was exactly the piece a consumer could not
    reach, so nine delegated runs carried it in prose).

    Only roots that PRECEDE the owning root on the search path are layered: helm reads the
    owning chart's values.yaml as its defaults and every `--values` file overrides it, so
    layering a LOWER-precedence root (the stock chart under a consumer template) would invert
    the search-path order and let stock defaults win over the consumer's own. A consumer
    template therefore renders from its chart alone, plus values.local files.
    include_local=False keeps only the committed layers (hermetic renders, goldens).
    """
    owning = chart.parent.resolve()
    roots = list(charts_roots())
    preceding = roots[: roots.index(owning)] if owning in roots else []
    layers: list[Path] = [chart / "values.local.yaml"] if include_local else []
    for root in reversed(preceding):  # the search path is highest-precedence first
        other = root / "workflows"
        layers.append(other / "values.yaml")
        if include_local:
            layers.append(other / "values.local.yaml")
    return [path for path in layers if path.is_file()]


def to_wire_json(rendered_yaml: str) -> str:
    """Final processing step: canonical YAML → the compact JSON today's wire format expects."""
    return json.dumps(yaml.safe_load(rendered_yaml), ensure_ascii=False)
