"""Overlay — spatial composition: merge several workflow definitions into one.

Phase 2 of the workflow-composition plan (docs/plans/impl/workflow-composition.md). Overlay is the
compose-file operator (`docker compose -f a -f b`): later layers extend earlier ones, producing a
single workflow definition that runs as ONE workflow (one instanceId, one worktree, one agent
context). It is how `feature --pr` becomes `-t implement -t create-pr` — `create-pr` extends the
`implement` step's prose rather than adding a separate run (which would re-establish agent context).

Merge semantics (a later layer over the accumulator):
- Top-level keys (instanceId, workspaceId, …): later wins.
- Steps merge BY `id`:
  - a step whose id is new is appended (preserving first-seen order);
  - a step whose id already exists is merged into the existing one — its `input.task` is APPENDED
    to the existing task (prose extension, e.g. the PR epilogue), its `input.setup` list is
    CONCATENATED onto the existing setup list (command extension, base first — so an atom can
    contribute setup commands without clobbering the base's), every other `input` field and
    top-level step field is later-wins. `task`/`setup` present on only one side, or with
    non-string/non-list values, follow later-wins like any other field.

Pure and dependency-free: takes/returns plain dicts (parsed YAML/JSON), no helm, no network.
"""

from __future__ import annotations

import copy
from typing import Any

TASK_SEPARATOR = "\n"


def _merge_step(base_step: dict[str, Any], layer_step: dict[str, Any]) -> None:
    """Merge `layer_step` into `base_step` in place: append `input.task`, concatenate
    `input.setup` lists, later-wins the rest."""
    base_input: dict[str, Any] = base_step.setdefault("input", {})
    for key, value in (layer_step.get("input") or {}).items():
        if (
            key == "task"
            and isinstance(value, str)
            and isinstance(base_input.get("task"), str)
        ):
            base_input["task"] = base_input["task"].rstrip("\n") + TASK_SEPARATOR + value
        elif (
            key == "setup"
            and isinstance(value, list)
            and isinstance(base_input.get("setup"), list)
        ):
            base_input["setup"] = base_input["setup"] + value
        else:
            base_input[key] = value
    for key, value in layer_step.items():
        if key not in ("input", "id"):
            base_step[key] = value


def overlay(*definitions: dict[str, Any]) -> dict[str, Any]:
    """Merge workflow definitions left-to-right into one. Later layers extend earlier ones.

    Raises ValueError if a step has no `id` (ids are the merge key — an unidentified step could not
    be targeted or extended by a later layer).
    """
    if not definitions:
        raise ValueError("overlay() needs at least one definition")

    result: dict[str, Any] = {}
    steps_by_id: dict[str, dict[str, Any]] = {}
    order: list[str] = []

    declared_outputs = sum(1 for d in definitions if d.get("outputs"))
    if declared_outputs > 1:
        # An outputs declaration renders a contract epilogue into its atom's task prose; two
        # declaring atoms would append two conflicting ===OUTPUT CONTRACT=== blocks into the merged
        # step. One atom owns the composed workflow's output signature — fail loud, not last-wins.
        raise ValueError(
            "overlay: more than one atom declares `outputs` — exactly one template may own the "
            "composed workflow's output contract"
        )

    for definition in definitions:
        for key, value in definition.items():
            if key == "steps":
                continue
            # `params` is the stored-defaults surface (fire-time identity, model, …): atoms each
            # contribute their own defaults, so merge key-wise (later wins per key) instead of
            # letting a later atom's block clobber an earlier one's wholesale.
            if key == "params" and isinstance(value, dict) and isinstance(result.get(key), dict):
                result[key].update(copy.deepcopy(value))
            else:
                result[key] = copy.deepcopy(value)
        for step in definition.get("steps") or []:
            step_id = step.get("id")
            if not step_id:
                raise ValueError(f"overlay: every step needs an `id` (got {step!r})")
            if step_id in steps_by_id:
                _merge_step(steps_by_id[step_id], copy.deepcopy(step))
            else:
                clone = copy.deepcopy(step)
                steps_by_id[step_id] = clone
                order.append(step_id)

    # A composed definition is a workflow definition, not a template: the per-template `role`
    # marker must not leak through (later-wins would keep the LAST atom's role — misleading).
    result.pop("role", None)
    result["steps"] = [steps_by_id[step_id] for step_id in order]
    return result
