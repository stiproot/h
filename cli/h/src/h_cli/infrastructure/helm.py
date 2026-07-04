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

from h_cli.config import CHARTS_DIR


class HelmError(RuntimeError):
    """Raised when helm is missing or a render fails; str(err) is user-presentable."""


def render_workflow(
    family: str,
    values: dict[str, str] | None = None,
    file_values: dict[str, Path] | None = None,
    include_local: bool = True,
) -> str:
    """Render one workflow family's template (charts/workflows/templates/<family>.yaml) to YAML.

    Merges the gitignored org-specific overrides (values.local.yaml) when present, then the given
    --set / --set-file values. Output is stripped of helm's document separator and "# Source:"
    comment. Note --set splits on commas and dots; fine for the branch-safe tokens passed here —
    route anything richer through file_values. include_local=False renders from chart defaults
    only (hermetic — used by the golden tests, and anywhere reproducibility beats convenience).
    """
    if shutil.which("helm") is None:
        raise HelmError("helm is required on PATH (https://helm.sh) — it renders cli/charts")
    chart = CHARTS_DIR / "workflows"
    cmd = ["helm", "template", family, str(chart), "-s", f"templates/{family}.yaml"]
    local_values = chart / "values.local.yaml"
    if include_local and local_values.is_file():
        cmd += ["--values", str(local_values)]
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


def to_wire_json(rendered_yaml: str) -> str:
    """Final processing step: canonical YAML → the compact JSON today's wire format expects."""
    return json.dumps(yaml.safe_load(rendered_yaml), ensure_ascii=False)
