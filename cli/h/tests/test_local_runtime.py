"""The local-substrate client: env layering and the runner boundary."""

import json
from pathlib import Path

import pytest

from h_cli.infrastructure.local_runtime import LocalRunError, child_env, run_job


def test_dotenv_fills_gaps_but_never_shadows_the_shell(tmp_path: Path, monkeypatch) -> None:
    """Shell-wins precedence. Deliberately the OPPOSITE of cli/scripts/compose.sh, which makes
    .env authoritative for long-lived containers; an interactive command must honour a key the
    operator just exported for this one run."""
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "# a comment\n"
        "ANTHROPIC_API_KEY=from-dotenv\n"
        'LLM_BASE_URL="http://quoted"\n'
        "export GH_TOKEN=exported-form\n"
        "MALFORMED\n"
        "\n"
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-shell")
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)

    env = child_env(dotenv)

    assert env["ANTHROPIC_API_KEY"] == "from-shell"
    assert env["LLM_BASE_URL"] == "http://quoted"
    assert env["GH_TOKEN"] == "exported-form"
    assert "MALFORMED" not in env


def test_missing_dotenv_is_not_an_error(tmp_path: Path) -> None:
    """Local execution must work in a checkout with no .env at all — the operator's own shell
    env is the documented path."""
    assert child_env(tmp_path / "absent.env")


def test_unbuilt_runner_says_how_to_build_it(tmp_path: Path) -> None:
    with pytest.raises(LocalRunError, match="bun run build"):
        run_job({"kind": "delegate"}, bin_path=tmp_path / "nope.js")


def test_reads_the_envelope_off_the_last_stdout_line(tmp_path: Path) -> None:
    """The runner's contract: progress on stderr, ONE json envelope on stdout. Anything a CLI or
    a runtime warning leaks onto stdout before it must not break the parse."""
    fake = tmp_path / "fake-runner.js"
    fake.write_text(
        "process.stdin.resume();\n"
        "process.stdin.on('end', () => {\n"
        "  console.log('a stray warning');\n"
        "  console.log(JSON.stringify({ ok: true, group: 'g', runs: [] }));\n"
        "});\n"
    )
    assert run_job({"kind": "delegate"}, bin_path=fake) == {"ok": True, "group": "g", "runs": []}


def test_the_job_reaches_the_runner_on_stdin(tmp_path: Path) -> None:
    fake = tmp_path / "echo-runner.js"
    fake.write_text(
        "let d='';process.stdin.on('data',c=>d+=c);\n"
        "process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,echo:JSON.parse(d)})));\n"
    )
    job = {"kind": "delegate", "task": "t", "agents": ["claude"]}
    # The driver stamps the wire-contract version on the way out — the runner's half of the
    # handshake refuses a mismatch, so the stamp must always be present.
    from h_cli.infrastructure.local_runtime import LOCAL_PROTOCOL_VERSION

    assert run_job(job, bin_path=fake)["echo"] == {
        **job,
        "protocolVersion": LOCAL_PROTOCOL_VERSION,
    }


def test_a_runner_that_says_nothing_is_a_loud_failure(tmp_path: Path) -> None:
    fake = tmp_path / "silent-runner.js"
    fake.write_text("process.stdin.resume();process.stdin.on('end',()=>process.exit(3));\n")
    with pytest.raises(LocalRunError, match="produced no result"):
        run_job({"kind": "delegate"}, bin_path=fake)


def test_unreadable_output_is_a_loud_failure(tmp_path: Path) -> None:
    fake = tmp_path / "garbage-runner.js"
    fake.write_text("process.stdin.resume();process.stdin.on('end',()=>console.log('{nope'));\n")
    with pytest.raises(LocalRunError, match="unreadable result"):
        run_job({"kind": "delegate"}, bin_path=fake)


def test_envelope_round_trips_unicode(tmp_path: Path) -> None:
    fake = tmp_path / "unicode-runner.js"
    payload = json.dumps({"ok": True, "runs": [{"output": "答え — ✓"}]})
    fake.write_text(
        "process.stdin.resume();\n"
        f"process.stdin.on('end',()=>console.log({json.dumps(payload)}));\n"
    )
    assert run_job({"kind": "delegate"}, bin_path=fake)["runs"][0]["output"] == "答え — ✓"
