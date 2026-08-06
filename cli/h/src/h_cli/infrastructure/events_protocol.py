"""The local event fabric's wire protocol — pure shapes and transitions, no IO.

A task message is a FIRE DESCRIPTOR: the trigger payload made local, the sibling of the service
substrate's `workflow-trigger` event `{key, params}`. The relay (`h events serve`) composes the
named template on fire and executes it through the local executor; the LOOP EDGE is the `publish`
field an agent may return beside its contract fields — the next task, handed to the machinery.
The relay, not the agent, does the publishing (mirroring how the chain engine, not the member,
fires the next stage), and every transition burns one step of the seed's mandatory budget.

Everything here is pure so the protocol is unit-testable without a server; `events_fabric` owns
the IO.
"""

import re
from typing import Any

from h_cli.config import (
    AGENT_IDENTITY,
    MODEL_PARAM_SLOTS,
    agent_identity_params,
    baked_models_suit,
)

PROTOCOL_VERSION = 1

# One stream per direction. Tasks are a WORK QUEUE (a message is deleted when the relay acks it —
# exactly-one-execution); results are LIMITS-retained history, so a finished loop's terminal
# envelope is still readable after the fact.
TASK_STREAM = "h-tasks"
TASK_SUBJECTS = "h.task.>"
RESULT_STREAM = "h-results"
RESULT_SUBJECTS = "h.result.>"

# A runaway loop is spend: budgets are refused above this outright, whatever the seed says.
MAX_STEPS_CEILING = 25

# Subject tokens must stay literal — no wildcards, separators, or spaces smuggled into a subject.
_TOKEN = re.compile(r"^[A-Za-z0-9_-]+$")


def task_subject(queue: str) -> str:
    return f"h.task.{queue}"


def result_subject(group: str) -> str:
    return f"h.result.{group}"


def msg_id(descriptor: dict[str, Any]) -> str:
    """The dedup identity: one publish per (group, step) inside the stream's duplicate window.

    This is what makes a redelivered step safe to re-run — if a prior delivery already published
    step N+1 before the relay died, the re-run's publish is rejected as a duplicate instead of
    forking the loop.
    """
    return f"{descriptor['group']}:{descriptor['step']}"


def seed_descriptor(
    *,
    template: str,
    params: dict[str, Any],
    agent: str,
    max_steps: int,
    group: str,
    queue: str = "default",
    model: str | None = None,
) -> dict[str, Any]:
    """The loop's first descriptor. The budget is part of the message, not relay state: any relay
    instance (including one started after a crash) enforces it from the descriptor alone."""
    descriptor: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "template": template,
        "params": params,
        "agent": agent,
        "group": group,
        "queue": queue,
        "step": 1,
        "maxSteps": max_steps,
    }
    if model:
        descriptor["model"] = model
    return descriptor


def validate_descriptor(descriptor: Any) -> list[str]:
    """Human-readable problems; empty means the descriptor is executable. Fail-closed on version
    so a future protocol change never half-executes on an old relay."""
    if not isinstance(descriptor, dict):
        return ["descriptor must be a JSON object"]
    problems: list[str] = []
    if descriptor.get("v") != PROTOCOL_VERSION:
        problems.append(f"unsupported protocol version {descriptor.get('v')!r}")
    if not isinstance(descriptor.get("template"), str) or not descriptor.get("template"):
        problems.append("missing template")
    if not isinstance(descriptor.get("params"), dict):
        problems.append("params must be an object")
    agent = descriptor.get("agent")
    if not isinstance(agent, str) or agent not in AGENT_IDENTITY:
        problems.append(f"unknown agent {agent!r} (known: {', '.join(sorted(AGENT_IDENTITY))})")
    for field in ("group", "queue"):
        value = descriptor.get(field)
        if not isinstance(value, str) or not _TOKEN.match(value):
            problems.append(f"{field} must match {_TOKEN.pattern}")
    step, max_steps = descriptor.get("step"), descriptor.get("maxSteps")
    if not isinstance(step, int) or step < 1:
        problems.append("step must be an integer >= 1")
    if not isinstance(max_steps, int) or not 1 <= max_steps <= MAX_STEPS_CEILING:
        problems.append(f"maxSteps must be an integer in 1..{MAX_STEPS_CEILING}")
    return problems


def validate_publish(publish: Any) -> list[str]:
    """The agent-returned hand-off: `{task, agent?}`. Validated with the same posture as chain
    registration — an unexecutable hand-off is refused before anything publishes."""
    if not isinstance(publish, dict):
        return ["publish must be an object {task, agent?}"]
    problems: list[str] = []
    if not isinstance(publish.get("task"), str) or not publish["task"].strip():
        problems.append("publish.task must be a non-empty string")
    agent = publish.get("agent")
    if agent is not None and (not isinstance(agent, str) or agent not in AGENT_IDENTITY):
        problems.append(
            f"publish.agent {agent!r} unknown (known: {', '.join(sorted(AGENT_IDENTITY))})"
        )
    return problems


def hand_off(descriptor: dict[str, Any], publish: dict[str, Any]) -> dict[str, Any] | None:
    """The next descriptor, or None when the budget is spent (the caller then emits `exhausted`).

    The next task REPLACES `params.task`; every other seed param rides along unchanged, so a
    template with more content params than `task` keeps them across the loop.
    """
    if descriptor["step"] + 1 > descriptor["maxSteps"]:
        return None
    return {
        **descriptor,
        "params": {**descriptor["params"], "task": publish["task"]},
        "agent": publish.get("agent") or descriptor["agent"],
        "step": descriptor["step"] + 1,
    }


def merged_params(defaults: dict[str, Any], descriptor: dict[str, Any]) -> dict[str, Any]:
    """Fire-time params for one relay step: descriptor content over template defaults, plus the
    identity expansion `--agent` would have done, with the baked-model rule applied (a baked
    model belongs to its executor: descriptor.model wins every slot; a non-claude executor with
    no model gets the slots cleared rather than a claude model id it would reject)."""
    merged = {**defaults, **descriptor["params"]}
    identity = agent_identity_params(descriptor["agent"])
    if identity:
        merged.update(identity)
    model = descriptor.get("model")
    if model:
        merged.update(dict.fromkeys(MODEL_PARAM_SLOTS, model))
    elif not baked_models_suit(descriptor["agent"]):
        merged.update(dict.fromkeys(MODEL_PARAM_SLOTS, ""))
    return merged


def loop_structured(envelope: dict[str, Any]) -> dict[str, Any] | None:
    """The LAST step result carrying a validated `structured` block — the loop's protocol reads
    the same contract output every chain seam reads, nothing bespoke."""
    results = envelope.get("results") or {}
    if not isinstance(results, dict):
        return None
    for value in reversed(list(results.values())):
        if isinstance(value, dict) and isinstance(value.get("structured"), dict):
            return value["structured"]
    return None


def terminal(descriptor: dict[str, Any], status: str, **fields: Any) -> dict[str, Any]:
    """The loop's terminal envelope, published to `h.result.<group>`. `exhausted` is a budget
    stop with work outstanding — deliberately not a failure, same as a loop-until-clean chain."""
    return {
        "v": PROTOCOL_VERSION,
        "kind": "terminal",
        "group": descriptor["group"],
        "status": status,  # resolved | exhausted | failed
        "steps": descriptor["step"],
        "agent": descriptor["agent"],
        **fields,
    }
