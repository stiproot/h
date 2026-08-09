"""The event fabric's pure protocol: descriptors, hand-offs, budgets, terminals."""

from h_cli.infrastructure import events_protocol as protocol


def _seed(**overrides):
    base = protocol.seed_descriptor(
        template="answer",
        params={"task": "start"},
        agent="claude",
        max_steps=3,
        group="loop-1",
    )
    return {**base, **overrides}


def test_seed_descriptor_is_valid_and_carries_the_budget() -> None:
    descriptor = _seed()
    assert protocol.validate_descriptor(descriptor) == []
    assert descriptor["step"] == 1
    assert descriptor["maxSteps"] == 3
    assert protocol.msg_id(descriptor) == "loop-1:1"


def test_validate_refuses_unknown_agent_bad_group_and_absurd_budget() -> None:
    problems = protocol.validate_descriptor(_seed(agent="gpt-99", group="has spaces", maxSteps=999))
    assert any("unknown agent" in p for p in problems)
    assert any("group" in p for p in problems)
    assert any("maxSteps" in p for p in problems)


def test_validate_refuses_wildcards_in_subject_tokens() -> None:
    # A queue of ">" would subscribe the relay to everything; it must never leave validation.
    assert protocol.validate_descriptor(_seed(queue=">")) != []
    assert protocol.validate_descriptor(_seed(queue="a.b")) != []


def test_validate_fails_closed_on_a_future_protocol_version() -> None:
    assert any("version" in p for p in protocol.validate_descriptor(_seed(v=2)))


def test_hand_off_threads_task_switches_agent_and_burns_a_step() -> None:
    nxt = protocol.hand_off(_seed(), {"task": "continue", "agent": "codex"})
    assert nxt is not None
    assert nxt["params"]["task"] == "continue"
    assert nxt["agent"] == "codex"
    assert nxt["step"] == 2
    assert nxt["maxSteps"] == 3
    assert protocol.msg_id(nxt) == "loop-1:2"


def test_hand_off_keeps_the_agent_when_none_is_named_and_other_params_ride_along() -> None:
    descriptor = _seed(params={"task": "start", "repo": "o/r"})
    nxt = protocol.hand_off(descriptor, {"task": "next"})
    assert nxt is not None
    assert nxt["agent"] == "claude"
    assert nxt["params"] == {"task": "next", "repo": "o/r"}


def test_hand_off_returns_none_when_the_budget_is_spent() -> None:
    assert protocol.hand_off(_seed(step=3), {"task": "more"}) is None


def test_validate_publish_requires_a_task_and_a_known_agent() -> None:
    assert protocol.validate_publish({"task": "x"}) == []
    assert protocol.validate_publish({"task": "x", "agent": "codex"}) == []
    assert protocol.validate_publish({"task": "  "}) != []
    assert protocol.validate_publish({"task": "x", "agent": "nope"}) != []
    assert protocol.validate_publish("just a string") != []


def test_merged_params_applies_identity_and_clears_baked_models_for_foreign_executors() -> None:
    defaults = {"runActivity": "run-claude", "agentId": "claude-agent", "modelAnswer": "claude-x"}
    merged = protocol.merged_params(defaults, _seed(agent="codex"))
    assert merged["runActivity"] == "run-codex"
    assert merged["agentId"] == "codex-agent"
    assert merged["modelAnswer"] == ""  # baked claude model must not reach codex


def test_merged_params_keeps_baked_models_for_the_default_executor() -> None:
    defaults = {"runActivity": "run-claude", "agentId": "claude-agent", "modelAnswer": "claude-x"}
    merged = protocol.merged_params(defaults, _seed(agent="claude"))
    assert merged["modelAnswer"] == "claude-x"


def test_merged_params_explicit_model_wins_every_slot() -> None:
    merged = protocol.merged_params({}, _seed(agent="codex", model="gpt-x"))
    assert merged["modelAnswer"] == "gpt-x"


def test_loop_structured_reads_the_last_structured_step() -> None:
    envelope = {
        "results": {
            "params": {"task": "t"},
            "plan": {"structured": {"answer": "early"}},
            "answer": {"structured": {"answer": "final", "publish": {"task": "next"}}},
        }
    }
    assert protocol.loop_structured(envelope) == {
        "answer": "final",
        "publish": {"task": "next"},
    }
    assert protocol.loop_structured({"results": {}}) is None


def test_terminal_carries_group_status_and_step_count() -> None:
    event = protocol.terminal(_seed(step=2), "resolved", answer="42")
    assert event["kind"] == "terminal"
    assert event["group"] == "loop-1"
    assert event["status"] == "resolved"
    assert event["steps"] == 2
    assert event["answer"] == "42"


def test_run_summary_reports_last_run_id_and_summed_cost() -> None:
    envelope = {
        "runs": [
            {"step": "plan", "agent": "claude", "runId": "r1", "costUsd": 0.25},
            {"step": "answer", "agent": "codex", "runId": "r2", "costUsd": 0.5},
        ]
    }
    # The LAST runId, because that is the run whose output the terminal is reporting on.
    assert protocol.run_summary(envelope) == {"runId": "r2", "costUsd": 0.75}


def test_run_summary_omits_cost_it_was_never_told() -> None:
    # codex on a ChatGPT plan reports no cost: absent must stay absent, never a $0 that reads free.
    assert protocol.run_summary({"runs": [{"step": "a", "agent": "codex", "runId": "r1"}]}) == {
        "runId": "r1"
    }
    assert protocol.run_summary({"runs": []}) == {}
    assert protocol.run_summary({}) == {}
