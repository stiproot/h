"""Golden (snapshot) tests of the chart through the real path: chart → helm binary → adapter.

These are the chart's contract tests — a template change surfaces as a reviewable snapshot
diff. Rendered hermetically (include_local=False) from chart defaults + the hostile fixture,
so the goldens are byte-stable on any machine with helm. Re-bless deliberately with
`uv run pytest --snapshot-update` and review the diff like any other code change.
"""

import json
import shutil
from pathlib import Path

import pytest

from h_cli.infrastructure import helm

pytestmark = pytest.mark.skipif(
    shutil.which("helm") is None, reason="helm not on PATH (renders cli/charts)"
)


def _render_hostile(hostile_spec: Path) -> str:
    return helm.render_workflow(
        "feature",
        values={"feature.slug": "hostile-fixture"},
        file_values={"feature.spec": hostile_spec},
        include_local=False,
    )


def test_feature_yaml_golden(hostile_spec: Path, snapshot) -> None:
    """The canonical YAML artifact — pins the chart, header stripping, and token coexistence."""
    assert _render_hostile(hostile_spec) == snapshot


def test_feature_wire_json_golden(hostile_spec: Path, snapshot) -> None:
    """The JSON wire form — pins the final processing step as lossless alongside the YAML."""
    assert helm.to_wire_json(_render_hostile(hostile_spec)) == snapshot


def test_hostile_tokens_survive_verbatim(hostile_spec: Path) -> None:
    """Belt-and-braces behavioral check, independent of snapshot blessing."""
    definition = json.loads(helm.to_wire_json(_render_hostile(hostile_spec)))
    plan_task = definition["steps"][2]["input"]["task"]
    tokens = ("$AGENT_APP_DIR", "${VARS}", "{{step.field}}", '"double quotes"', "back\\slashes")
    for token in tokens:
        assert token in plan_task
    assert definition["steps"][3]["input"]["task"].count("{{plan.output}}") == 1


def test_missing_slug_is_a_render_error(hostile_spec: Path) -> None:
    with pytest.raises(helm.HelmError, match="feature.slug is required"):
        helm.render_workflow(
            "feature",
            values={"feature.slug": ""},
            file_values={"feature.spec": hostile_spec},
            include_local=False,
        )


def test_branch_unsafe_slug_fails_schema(hostile_spec: Path) -> None:
    with pytest.raises(helm.HelmError, match="does not match pattern"):
        helm.render_workflow(
            "feature",
            values={"feature.slug": "Bad_Slug"},
            file_values={"feature.spec": hostile_spec},
            include_local=False,
        )
