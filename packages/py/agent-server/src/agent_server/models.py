from dataclasses import dataclass, field


@dataclass
class AgentRequest:
    input: str
    system_prompt: str | None = None
    session_id: str | None = None
    workflow_instance_id: str | None = None
    # Stable workspace key. When set, the workspace dir keys on it instead of workflow_instance_id.
    workspace_id: str | None = None
    # Explicit working dir for the run; overrides the computed workspace dir when set.
    cwd: str | None = None
    # Per-step LLM model override; falls back to the service default.
    model: str | None = None
    # "plan" runs the agent read-only; falls back to the default.
    permission_mode: str | None = None


@dataclass
class AgentResponse:
    output: str
    session_id: str
    model: str
    turns: int
    usage: dict = field(default_factory=lambda: {"input": 0, "output": 0})
    # Total LLM cost in USD, when the agent reports it.
    cost_usd: float | None = None
    # Number of tool calls made during the run (best-effort).
    tool_calls: int | None = None
    # Identifier of the run-ledger record for this run.
    run_id: str | None = None
    # Why the run stopped ("completed" | "usage-limited" | "timeout" | "failed") — the JS agents'
    # classify-stop vocabulary; None = this runner does not classify. Mirror-contract parity: the
    # watcher's usage-limit refinement reads stopReason off every run:<id> mirror
    # (docs/plans/cost-containment.md audit — py agents had no field at all, so a py-agent usage
    # limit could never reach the fence).
    stop_reason: str | None = None
