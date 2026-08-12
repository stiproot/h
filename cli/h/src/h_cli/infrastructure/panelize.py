"""Panelize — the `--agent` roster transform.

Pure and dependency-free (sibling of overlay.py): a rendered workflow definition in, a panelized
one out — no helm, no network, no config. A panel is `--agent` being PLURAL: this transform turns
that cardinality into structure the engine already executes, so the engine needs nothing new.

What it does:
- locates the PANEL STEP — the one carrying `outputContract`; the contract-carrying step IS the
  workflow's voice (the one-declarer composition rule, overlay.py);
- replicates it into a parallel step group (`generic.workflow.ts` whenAll) with one branch per
  roster agent — contract STRIPPED; model applied from *model_override* when set, otherwise
  stripped (branches answer in prose and fall back to each agent's own AGENT_MODEL), the
  shared-workspace concurrency preamble prepended (this module is
  the SINGLE author of panel-branch prose, so the sync steering lives here, once);
- appends a synthesis step under the ORIGINAL step id, carrying the ORIGINAL contract and run by
  the pinned judge — so the workflow's output signature, and every seam that reads it
  (loop-until-clean, captures, the watcher), is unchanged. The panel is invisible below the
  contract.

A template may declare a top-level `panelSynthesis:` prose block ("how to synthesize a panel of
me") beside `outputs:`; overlay() carries it, and it is spliced into the synthesis task here —
generic compare-and-merge prose otherwise.
"""

from __future__ import annotations

import copy
import json
from typing import Any

# The synthesis judge — pinned (the pr-review executor pin migrates to the judge:
# the reviewer-identity trust model via panels-as-a-modifier decision 7).
JUDGE_ACTIVITY = "run-claude"

PANEL_GROUP_ID = "panel"

# The shared-workspace concurrency steering, injected into every branch's task. Advisory by
# design (the branches share provisioning; hard isolation is the deferred escalation).
_PREAMBLE = (
    "You are one of {n} agents ({roster}) answering the task below concurrently, as an "
    "independent panel. Work alone — do not coordinate with or wait for the others. You may "
    "share a workspace with them: treat any checkout as READ-ONLY — do not switch branches, "
    "install dependencies, run builds, or write files into it; keep scratch reasoning in your "
    "answer, not on disk. You are the '{agent}' panelist: if the task has you POST anything to "
    "an external system (a PR review or comment, an issue), begin that body with the literal "
    "prefix '[panel:{agent}]' — several panelists post to the same place, and without it the "
    "reader cannot tell which agent said what, nor a later run tell panel output from a "
    "single-agent one."
)

# Mirrors h.outputContractEpilogue (cli/charts/workflows/templates/_helpers.tpl) — the per-step
# instance of the output contract, restated verbatim so instruction and contract cannot drift.
_CONTRACT_MARKER = "===OUTPUT CONTRACT==="
_EPILOGUE = (
    _CONTRACT_MARKER + "\n"
    "End your final message with a fenced ```json code block containing a single JSON\n"
    "object matching this schema. The block is machine-validated: a missing or\n"
    "mismatching block fails this step. Nothing may follow the block.\n"
    "{schema}"
)

_SYNTHESIS_INTRO = (
    "{n} agents ({roster}) independently performed the same task, concurrently, as a panel. "
    "The original task and each agent's full answer are below. Synthesize the answers into the "
    "SINGLE result the task demands — what do they agree on, where do they diverge in ways that "
    "matter, and what does the merged best answer look like? Your final json block is the "
    "workflow's ONE output; the panelists' own outputs are raw material, not results."
)


class PanelizeError(ValueError):
    """A user-presentable panelize failure (str(err) is the message)."""


def roster_pairs(
    roster: tuple[str, ...] | list[str], identity: dict[str, tuple[str, str]]
) -> list[tuple[str, str]]:
    """Roster names → (name, run activity) pairs via the identity table (config.AGENT_IDENTITY —
    injected, keeping this module dependency-free). Unknown names raise PanelizeError."""
    pairs: list[tuple[str, str]] = []
    for name in roster:
        entry = identity.get(name)
        if entry is None:
            raise PanelizeError(
                f"unknown agent '{name}' in the roster — known: " + ", ".join(sorted(set(identity)))
            )
        pairs.append((name, entry[0]))
    return pairs


def _branch_id(agent: str) -> str:
    """Roster name → branch id: the short form ('claude-agent' → 'claude'), matching the
    branch naming the run activities' outputs read back (`{{claude.output}}`)."""
    return agent.removesuffix("-agent")


def _strip_epilogue(task: str) -> str:
    """The task prose without its trailing rendered contract epilogue (when present) — the
    synthesis restates the contract authoritatively, so the quoted task must not carry a
    second, nested ===OUTPUT CONTRACT=== block."""
    marker = task.rfind(_CONTRACT_MARKER)
    return task[:marker].rstrip() if marker != -1 else task


def panelize(
    definition: dict[str, Any],
    roster: list[tuple[str, str]],
    model_override: str | None = None,
) -> dict[str, Any]:
    """A rendered workflow definition + a roster of (agent name, run activity) pairs → the
    panelized definition. Pure: the input definition is not mutated.

    When *model_override* is set (e.g. from `--model` with a roster), it is applied to every
    branch step input. Omit to strip the baked model (each branch falls back to its own
    AGENT_MODEL).

    Raises PanelizeError on any shape violation — no (or several) contract-carrying steps, a
    contract step without task prose, duplicate roster entries, or a branch/step id collision.
    """
    if len(roster) < 2:
        raise PanelizeError("a panel roster needs at least two agents")
    branch_ids = [_branch_id(name) for name, _ in roster]
    if len(set(branch_ids)) != len(branch_ids):
        raise PanelizeError(
            "duplicate roster agent — each panelist must be a distinct executor "
            f"(roster: {', '.join(name for name, _ in roster)})"
        )

    steps: list[dict[str, Any]] = list(definition.get("steps") or [])
    contract_steps = [
        step
        for step in steps
        if isinstance(step.get("input"), dict) and step["input"].get("outputContract")
    ]
    if len(contract_steps) != 1:
        raise PanelizeError(
            "panelize needs exactly ONE step carrying `outputContract` (the workflow's voice — "
            f"the one-declarer rule); found {len(contract_steps)}"
        )
    subject = contract_steps[0]
    subject_id = subject.get("id") or subject.get("activity")
    task = subject["input"].get("task")
    if not isinstance(task, str) or not task.strip():
        raise PanelizeError("the contract-carrying step has no task prose to panelize")

    reserved = {step.get("id") for step in steps if step is not subject} | {PANEL_GROUP_ID}
    collisions = [bid for bid in branch_ids if bid in reserved]
    if collisions:
        raise PanelizeError(
            f"branch id(s) {', '.join(collisions)} collide with an existing step id — "
            "results would clobber"
        )

    contract = copy.deepcopy(subject["input"]["outputContract"])
    roster_line = ", ".join(branch_ids)

    branches: list[dict[str, Any]] = []
    for (name, activity), bid in zip(roster, branch_ids):
        # Contract stripped (branches answer in prose; the retained epilogue text in the task is
        # harmless — an unvalidated json ending just makes synthesis easier). Model behaviour:
        # when model_override is set it is applied to every branch; otherwise the baked model is
        # stripped so each branch falls back to its own AGENT_MODEL.
        branch_input = {
            key: copy.deepcopy(value)
            for key, value in subject["input"].items()
            if key not in ("outputContract", "model")
        }
        if model_override:
            branch_input["model"] = model_override
        # The preamble is per-BRANCH, not shared: it names which panelist this is, so anything
        # the branch posts externally is attributable.
        preamble = _PREAMBLE.format(n=len(roster), roster=roster_line, agent=bid)
        branch_input["task"] = f"{preamble}\n\n{task}"
        branches.append({"id": bid, "activity": activity, "input": branch_input})

    sections = "\n\n".join(f"==={bid.upper()}===\n{{{{{bid}.output}}}}" for bid in branch_ids)
    guidance = definition.get("panelSynthesis")
    synthesis_parts = [_SYNTHESIS_INTRO.format(n=len(roster), roster=roster_line)]
    if isinstance(guidance, str) and guidance.strip():
        synthesis_parts.append(guidance.strip())
    synthesis_parts.append(_EPILOGUE.format(schema=json.dumps(contract, indent=2)))
    synthesis_parts.append(f"===TASK===\n{_strip_epilogue(task)}")
    synthesis_parts.append(sections)

    panel_step = {"id": PANEL_GROUP_ID, "parallel": branches}
    # The synthesis KEEPS the original step id: semantically it IS the step — same id, same
    # contract — so any later step's reference to it resolves to the synthesized result.
    synthesis_step = {
        "id": subject_id,
        "activity": JUDGE_ACTIVITY,
        "input": {"outputContract": contract, "task": "\n\n".join(synthesis_parts)},
    }

    new_steps: list[dict[str, Any]] = []
    for step in steps:
        if step is subject:
            new_steps.extend((panel_step, synthesis_step))
        else:
            new_steps.append(copy.deepcopy(step))

    return {
        **{k: copy.deepcopy(v) for k, v in definition.items() if k != "steps"},
        "steps": new_steps,
    }
