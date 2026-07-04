"""The YAML→JSON wire edge and the task-embedding round trip — no helm, no network."""

import json

import yaml

from h_cli.commands.feature import _RUN_VERBATIM_PREAMBLE
from h_cli.infrastructure.helm import to_wire_json

SAMPLE_YAML = """\
instanceId: "feature-x"
steps:
  - id: plan
    activity: run-claude
    input:
      cwd: "{{worktree.worktreePath}}"
      task: |-
        Line one with ${VARS} and $SHELL_VAR.
        Line "two" with back\\slashes.
"""


def test_to_wire_json_is_lossless() -> None:
    assert json.loads(to_wire_json(SAMPLE_YAML)) == yaml.safe_load(SAMPLE_YAML)


def test_to_wire_json_is_compact_single_line() -> None:
    assert "\n" not in to_wire_json(SAMPLE_YAML)


def test_definition_embeds_in_task_problem_and_parses_back() -> None:
    """Mirror of what `h feature run` seeds: the agent must be able to lift the JSON back out."""
    problem = _RUN_VERBATIM_PREAMBLE + to_wire_json(SAMPLE_YAML)
    _, _, embedded = problem.partition("===WORKFLOW DEFINITION===\n")
    definition = json.loads(embedded)
    assert definition["instanceId"] == "feature-x"
    assert definition["steps"][0]["input"]["cwd"] == "{{worktree.worktreePath}}"
