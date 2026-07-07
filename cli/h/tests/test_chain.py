"""h chain — the sequential pipeline threads state between hops (respx-mocked wire).

The core contract under test: hop N's output lands in the blackboard and hop N+1 reads it —
pr-review fires with the PR number parsed from the feature hop's ===PR===, and revise fires with
the review findings parsed from pr-review's ===REVIEW===.
"""

import json
from pathlib import Path

import respx
from httpx import Response
from typer.testing import CliRunner

from h_cli.commands.chain import _after_marker, _capture_pr, _capture_review
from h_cli.config import STATE_URL
from h_cli.infrastructure.workflow_svc import WORKFLOW_URL
from h_cli.main import app

runner = CliRunner()

FEATURE_OUTPUT = json.dumps(
    {"implement": {"output": "implemented it\n===PR===\nhttps://github.com/stiproot/h/pull/42"}}
)
REVIEW_OUTPUT = json.dumps(
    {"review": {"output": "reviewed it\n===REVIEW===\nsrc/models.py:17 — missing None guard"}}
)


def _all_output(result) -> str:
    out = result.output
    try:
        out += result.stderr
    except ValueError:
        pass
    return out


def _spec(tmp_path: Path) -> Path:
    p = tmp_path / "demo.md"
    p.write_text("# Demo\nDo the thing.\n")
    return p


def _mock_terminal(slug: str, feature_out: str, review_out: str) -> None:
    respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(200, json={"instanceId": f"feature-{slug}", "watching": False})
    )
    respx.get(f"{WORKFLOW_URL}/workflow/status/feature-{slug}").mock(
        return_value=Response(200, json={"runtimeStatus": "COMPLETED", "output": feature_out})
    )
    respx.post(f"{WORKFLOW_URL}/workflow/run/pr-review").mock(
        return_value=Response(200, json={"instanceId": f"pr-review-{slug}"})
    )
    respx.get(f"{WORKFLOW_URL}/workflow/status/pr-review-{slug}").mock(
        return_value=Response(200, json={"runtimeStatus": "COMPLETED", "output": review_out})
    )
    respx.post(STATE_URL).mock(return_value=Response(204))


@respx.mock
def test_chain_threads_state_between_hops(tmp_path: Path) -> None:
    _mock_terminal("demo", FEATURE_OUTPUT, REVIEW_OUTPUT)

    result = runner.invoke(
        app,
        [
            "chain",
            "run",
            "-t",
            "feature",
            "-t",
            "pr-review",
            "-t",
            "revise",
            "--slug",
            "demo",
            "--spec",
            str(_spec(tmp_path)),
            "--issue",
            "7",
            "--poll-interval",
            "0",
        ],
    )
    assert result.exit_code == 0, _all_output(result)

    # pr-review fired with the PR number parsed from the feature hop's ===PR=== (42).
    review_route = [c for c in respx.calls if c.request.url.path == "/workflow/run/pr-review"]
    assert len(review_route) == 1
    review_body = json.loads(review_route[0].request.content)
    assert review_body["params"]["pr"] == "42"

    # feature fired twice: the initial implement and the revise re-run (same instance).
    feature_calls = [c for c in respx.calls if c.request.url.path == "/workflow/run/feature"]
    assert len(feature_calls) == 2
    revise_body = json.loads(feature_calls[1].request.content)
    assert revise_body["fresh"] is True  # revise re-runs the feature instance fresh
    assert "missing None guard" in revise_body["params"]["spec"]  # review findings threaded in
    assert revise_body["params"]["issueNumber"] == "7"

    # the final PR url is reported
    assert "github.com/stiproot/h/pull/42" in result.output


@respx.mock
def test_chain_default_is_feature_review_revise(tmp_path: Path) -> None:
    _mock_terminal("demo", FEATURE_OUTPUT, REVIEW_OUTPUT)
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "demo", "--spec", str(_spec(tmp_path)), "--poll-interval", "0"],
    )
    assert result.exit_code == 0, _all_output(result)
    paths = [
        c.request.url.path for c in respx.calls if c.request.url.path.startswith("/workflow/run")
    ]
    assert paths == ["/workflow/run/feature", "/workflow/run/pr-review", "/workflow/run/feature"]


@respx.mock
def test_chain_stops_when_a_hop_fails(tmp_path: Path) -> None:
    respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
        return_value=Response(200, json={"instanceId": "feature-demo"})
    )
    respx.get(f"{WORKFLOW_URL}/workflow/status/feature-demo").mock(
        return_value=Response(200, json={"runtimeStatus": "FAILED"})
    )
    respx.post(STATE_URL).mock(return_value=Response(204))
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "demo", "--spec", str(_spec(tmp_path)), "--poll-interval", "0"],
    )
    assert result.exit_code == 1
    assert "FAILED" in _all_output(result)
    # pr-review must never fire after a failed feature hop
    assert not any(c.request.url.path == "/workflow/run/pr-review" for c in respx.calls)


def test_chain_rejects_unknown_template(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["chain", "run", "-t", "nope", "--slug", "x", "--spec", str(_spec(tmp_path))]
    )
    assert result.exit_code == 1
    assert "unknown template" in _all_output(result)


def test_chain_rejects_unimplemented_strategy(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["chain", "run", "--slug", "x", "--spec", str(_spec(tmp_path)), "--strategy", "parallel"],
    )
    assert result.exit_code == 1
    assert "not implemented" in _all_output(result)


# --- parser units ---


def test_after_marker_finds_the_step_that_carries_it() -> None:
    assert _after_marker(FEATURE_OUTPUT, "===PR===") == "https://github.com/stiproot/h/pull/42"
    assert _after_marker(FEATURE_OUTPUT, "===REVIEW===") is None
    assert _after_marker(None, "===PR===") is None
    assert _after_marker("not json", "===PR===") is None


def test_capture_pr_extracts_url_and_number() -> None:
    data: dict = {}
    _capture_pr(FEATURE_OUTPUT, data)
    assert data["prUrl"] == "https://github.com/stiproot/h/pull/42"
    assert data["prNumber"] == "42"


def test_capture_review_stores_findings() -> None:
    data: dict = {}
    _capture_review(REVIEW_OUTPUT, data)
    assert "missing None guard" in data["reviewFindings"]


def test_pr_review_hop_errors_without_a_pr_number(tmp_path: Path) -> None:
    with respx.mock:
        respx.post(f"{WORKFLOW_URL}/workflow/run/feature").mock(
            return_value=Response(200, json={"instanceId": "feature-demo"})
        )
        # feature completes but its output carries no ===PR=== marker
        respx.get(f"{WORKFLOW_URL}/workflow/status/feature-demo").mock(
            return_value=Response(
                200,
                json={
                    "runtimeStatus": "COMPLETED",
                    "output": json.dumps({"implement": {"output": "no pr here"}}),
                },
            )
        )
        respx.post(STATE_URL).mock(return_value=Response(204))
        result = runner.invoke(
            app,
            [
                "chain",
                "run",
                "--slug",
                "demo",
                "--spec",
                str(_spec(tmp_path)),
                "--poll-interval",
                "0",
            ],
        )
    assert result.exit_code == 1
    assert "pr-review needs a PR number" in _all_output(result)
