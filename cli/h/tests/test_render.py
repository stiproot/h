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

TEMPLATE_NAMES = sorted(
    path.name.removesuffix(".tmpl.yaml")
    for path in (helm.CHARTS_DIR / "workflows" / "templates").glob("*.tmpl.yaml")
)
MINIMAL_VALUES = {
    "verify": {"verify.cmd": "echo ok"},
    "improve-plugin": {
        "improvePlugin.tile": "plugins/linear",
        "improvePlugin.clonePath": "/workspace/plugins-repo",
    },
}
PINNED_OR_OVERLAY_IDENTITY = {
    "review-pr",
    "test-plugin-setup",
    "improve-plugin",
    "verify",
    "create-pr",
    "arm-revise-pr",
}


@pytest.mark.parametrize("name", TEMPLATE_NAMES)
def test_every_workflow_template_renders_and_obeys_identity_contract(name: str) -> None:
    """A new template is covered by default, in addition to the per-template content goldens."""
    try:
        rendered = helm.render_workflow(
            name,
            values={"publish": "true", **MINIMAL_VALUES.get(name, {})},
            include_local=False,
        )
    except helm.HelmError as exc:
        if name not in MINIMAL_VALUES and "required" in str(exc).lower():
            pytest.fail(
                f"{name!r} needs required render values; register them in MINIMAL_VALUES: {exc}",
                pytrace=False,
            )
        raise
    definition = json.loads(helm.to_wire_json(rendered))
    assert definition["steps"], f"{name!r} rendered no steps (check its .Values.template gate)"
    # CLAUDE.md's fire-time-identity invariant: a NEW full workflow must open identity slots,
    # or be deliberately classified as a pinned-identity/overlay atom here.
    if name not in PINNED_OR_OVERLAY_IDENTITY:
        assert "{{params.runActivity}}" in rendered


def _render_hostile(hostile_spec: Path) -> str:
    return helm.render_workflow(
        "implement",
        values={"implement.slug": "hostile-fixture"},
        file_values={"implement.spec": hostile_spec},
        include_local=False,
    )


def test_implement_yaml_golden(hostile_spec: Path, snapshot) -> None:
    """The canonical YAML artifact — pins the chart, header stripping, and token coexistence."""
    assert _render_hostile(hostile_spec) == snapshot


def test_implement_wire_json_golden(hostile_spec: Path, snapshot) -> None:
    """The JSON wire form — pins the final processing step as lossless alongside the YAML."""
    assert helm.to_wire_json(_render_hostile(hostile_spec)) == snapshot


def test_implement_is_always_four_pure_steps(hostile_spec: Path) -> None:
    """implement is a pure atom — worktree/setup/plan/implement, never a verify or PR step."""
    definition = json.loads(helm.to_wire_json(_render_hostile(hostile_spec)))
    assert [s["id"] for s in definition["steps"]] == ["worktree", "setup", "plan", "implement"]


def test_verify_golden(snapshot) -> None:
    """The verify overlay atom: a lone implement step carrying the gating acceptance check."""
    rendered = helm.render_workflow(
        "verify", values={"publish": "true", "verify.cmd": "bun run lint"}, include_local=False
    )
    assert rendered == snapshot


def test_verify_requires_a_cmd() -> None:
    """verify.cmd is required — composing verify without it fails loud, never a silent no-op."""
    with pytest.raises(helm.HelmError, match="verify.cmd is required"):
        helm.render_workflow("verify", values={"publish": "true"}, include_local=False)


def test_revise_golden(snapshot) -> None:
    """revise-pr — a standalone, publish-native workflow that reads a PR's unresolved review threads
    itself (github MCP) and addresses them. worktree → setup → revise-pr,
    {{params.pr}}/{{params.slug}}."""
    rendered = helm.render_workflow("revise-pr", values={"publish": "true"}, include_local=False)
    assert rendered == snapshot


def test_revise_is_worktree_setup_revise() -> None:
    """revise-pr is self-sufficient: cut the PR's branch, read its threads, push — three steps."""
    import yaml

    rendered = helm.render_workflow("revise-pr", values={"publish": "true"}, include_local=False)
    steps = [s["id"] for s in yaml.safe_load(rendered)["steps"]]
    assert steps == ["worktree", "setup", "revise-pr"]


def test_compose_implement_verify_create_pr_orders_and_gates() -> None:
    """implement ⊕ verify ⊕ create-pr: one step ordered implement → check → PR-if-green."""
    from h_cli.infrastructure.overlay import overlay

    def _atom(name: str, **vals: str) -> dict:
        return json.loads(
            helm.to_wire_json(
                helm.render_workflow(
                    name,
                    values={"publish": "true", "composable": "true", **vals},
                    include_local=False,
                )
            )
        )

    merged = overlay(
        _atom("implement"),
        _atom("verify", **{"verify.cmd": "bun run lint"}),
        _atom("create-pr"),
    )
    assert [s["id"] for s in merged["steps"]] == ["worktree", "setup", "plan", "implement"]
    task = next(s for s in merged["steps"] if s["id"] == "implement")["input"]["task"]
    # the check gates the PR: verify prose (and its stop-on-fail) precede the open-PR prose
    assert task.index("===ACCEPTANCE CHECK===") < task.index("open (or update) a pull request")
    assert "do not open a pull request" in task  # the gate


def test_git_auth_ssh_on_worktree_step(hostile_spec: Path) -> None:
    """implement.gitAuth=ssh names the auth strategy on the worktree step."""
    rendered = helm.render_workflow(
        "implement",
        values={"implement.slug": "hostile-fixture", "implement.gitAuth": "ssh"},
        file_values={"implement.spec": hostile_spec},
        include_local=False,
    )
    definition = json.loads(helm.to_wire_json(rendered))
    assert definition["steps"][0]["input"]["auth"] == "ssh"


def test_create_pr_gitauth_ssh_swaps_push() -> None:
    """createPr.gitAuth=ssh swaps create-pr's push instruction to the ssh transport."""
    rendered = helm.render_workflow(
        "create-pr", values={"publish": "true", "createPr.gitAuth": "ssh"}, include_local=False
    )
    task = json.loads(helm.to_wire_json(rendered))["steps"][0]["input"]["task"]
    assert "git push origin feature/{{params.slug}}" in task
    assert "x-access-token" not in task


def test_implement_never_opens_a_pr(hostile_spec: Path) -> None:
    """implement carries no PR machinery — a PR only ever comes from the create-pr overlay."""
    rendered = _render_hostile(hostile_spec)
    assert "===CREATE PR===" not in rendered
    assert "===PR===" not in rendered
    assert "do not commit or push" in rendered


def test_implement_publish_mode_golden(snapshot) -> None:
    """Publish mode: slug/spec become {{params.*}} slots, no instanceId — a saveable template."""
    rendered = helm.render_workflow("implement", values={"publish": "true"}, include_local=False)
    assert rendered == snapshot


def test_implement_publish_mode_opens_param_slots() -> None:
    definition = json.loads(
        helm.to_wire_json(
            helm.render_workflow("implement", values={"publish": "true"}, include_local=False)
        )
    )
    assert "instanceId" not in definition
    assert definition["steps"][0]["input"]["branch"] == "feature/{{params.slug}}"
    assert "{{params.spec}}" in definition["steps"][2]["input"]["task"]
    # implement carries no PR params — opening a PR is the create-pr overlay's job, not feature's.
    assert "{{params.createPr}}" not in definition["steps"][3]["input"]["task"]


def test_improve_plugin_golden(snapshot) -> None:
    """The improve-plugin template (publish-native), hermetic with explicit template config."""
    rendered = helm.render_workflow(
        "improve-plugin",
        values={
            "improvePlugin.tile": "plugins/linear",
            "improvePlugin.clonePath": "/workspace/plugins-repo",
        },
        include_local=False,
    )
    assert rendered == snapshot


def test_templates_do_not_cross_demand_values(hostile_spec: Path) -> None:
    """The template gate: rendering one template never trips another template's `required`."""
    # implement renders without improvePlugin.tile or reviewPr.repo set…
    _render_hostile(hostile_spec)
    # …improve-plugin renders without implement.slug/spec or reviewPr.repo set…
    helm.render_workflow(
        "improve-plugin",
        values={"improvePlugin.tile": "plugins/linear"},
        include_local=False,
    )
    # …review-pr renders without implement.slug/spec or improvePlugin.tile set…
    helm.render_workflow(
        "review-pr",
        values={"reviewPr.repo": "owner/h"},
        include_local=False,
    )
    # …and test-plugin-setup renders without any other template's required values.
    helm.render_workflow("test-plugin-setup", values={}, include_local=False)


def test_hostile_tokens_survive_verbatim(hostile_spec: Path) -> None:
    """Belt-and-braces behavioral check, independent of snapshot blessing."""
    definition = json.loads(helm.to_wire_json(_render_hostile(hostile_spec)))
    plan_task = definition["steps"][2]["input"]["task"]
    tokens = ("$AGENT_APP_DIR", "${VARS}", "{{step.field}}", '"double quotes"', "back\\slashes")
    for token in tokens:
        assert token in plan_task
    assert definition["steps"][3]["input"]["task"].count("{{plan.output}}") == 1


def test_missing_slug_is_a_render_error(hostile_spec: Path) -> None:
    with pytest.raises(helm.HelmError, match="implement.slug is required"):
        helm.render_workflow(
            "implement",
            values={"implement.slug": ""},
            file_values={"implement.spec": hostile_spec},
            include_local=False,
        )


def test_branch_unsafe_slug_fails_schema(hostile_spec: Path) -> None:
    with pytest.raises(helm.HelmError, match="(?i)does not match pattern"):
        helm.render_workflow(
            "implement",
            values={"implement.slug": "Bad_Slug"},
            file_values={"implement.spec": hostile_spec},
            include_local=False,
        )


def test_create_pr_golden(snapshot) -> None:
    """The create-pr overlay atom (publish-native): a lone implement step with the PR epilogue."""
    rendered = helm.render_workflow("create-pr", values={"publish": "true"}, include_local=False)
    assert rendered == snapshot


def test_create_pr_task_requires_direct_markdown_without_shell_wrapper() -> None:
    """The rendered MCP guidance must never recommend a literal shell heredoc expression."""
    rendered = helm.render_workflow("create-pr", values={"publish": "true"}, include_local=False)
    task = json.loads(helm.to_wire_json(rendered))["steps"][0]["input"]["task"]

    assert "Pass the intended Markdown directly" in task
    assert "beginning with the intended heading or first line" in task
    assert "$(cat" not in task
    assert "<<'EOF'" not in task
    assert not any(line.strip() == "EOF" for line in task.splitlines())


def test_composable_implement_ends_implement_neutrally(hostile_spec: Path) -> None:
    """composable=true ends implement neutrally at the plan — the overlay attach point."""
    rendered = helm.render_workflow(
        "implement",
        values={"implement.slug": "hostile-fixture", "composable": "true"},
        file_values={"implement.spec": hostile_spec},
        include_local=False,
    )
    definition = json.loads(helm.to_wire_json(rendered))
    assert [s["id"] for s in definition["steps"]] == ["worktree", "setup", "plan", "implement"]
    implement = definition["steps"][3]["input"]["task"]
    assert "do not commit or push" not in implement  # no standalone closer to collide with overlays
    assert implement.rstrip().endswith("{{plan.output}}")  # ends at the plan handoff


def test_compose_implement_create_pr_extends_implement() -> None:
    """overlay(feature[composable], create-pr) == feature-to-a-PR in one workflow (--pr seam)."""
    from h_cli.infrastructure.overlay import overlay

    feature = json.loads(
        helm.to_wire_json(
            helm.render_workflow(
                "implement", values={"publish": "true", "composable": "true"}, include_local=False
            )
        )
    )
    create_pr = json.loads(
        helm.to_wire_json(
            helm.render_workflow("create-pr", values={"publish": "true"}, include_local=False)
        )
    )
    merged = overlay(feature, create_pr)
    # No extra step — create-pr extended the existing implement, not appended a new run.
    assert [s["id"] for s in merged["steps"]] == ["worktree", "setup", "plan", "implement"]
    implement = next(s for s in merged["steps"] if s["id"] == "implement")["input"]["task"]
    # The base implement prose AND the epilogue both live on the one step, in order.
    assert "First persist the plan" in implement
    assert implement.index("{{plan.output}}") < implement.index("open (or update) a pull request")
    # The epilogue's fire-time params thread through unresolved for a saved template.
    assert "{{params.issueNumber}}" in implement
    assert "feature/{{params.slug}}" in implement


def test_arm_revise_golden(snapshot) -> None:
    """arm-revise overlay (§10, Job 2): a lone register-cron step arming a revise-until-merged
    cron."""
    rendered = helm.render_workflow("arm-revise-pr", values={"publish": "true"}, include_local=False)
    assert rendered == snapshot


def test_compose_implement_verify_create_pr_arm_revise_appends_the_arm_step() -> None:
    """implement ⊕ verify ⊕ create-pr ⊕ arm-revise: the arm-revise step is APPENDED (new id) after
    implement, carrying register-cron + the PR guard — the h-builds-h implement-pr composition."""
    from h_cli.infrastructure.overlay import overlay

    def _atom(name: str, **vals: str) -> dict:
        return json.loads(
            helm.to_wire_json(
                helm.render_workflow(
                    name,
                    values={"publish": "true", "composable": "true", **vals},
                    include_local=False,
                )
            )
        )

    merged = overlay(
        _atom("implement"),
        _atom("verify", **{"verify.cmd": "bun run lint"}),
        _atom("create-pr"),
        _atom("arm-revise-pr"),
    )
    assert [s["id"] for s in merged["steps"]] == [
        "worktree",
        "setup",
        "plan",
        "implement",
        "arm-revise-pr",
    ]
    arm = next(s for s in merged["steps"] if s["id"] == "arm-revise-pr")
    assert arm["activity"] == "register-cron"
    assert arm["input"]["workflow"] == "revise-pr"
    # The guard reads the implement step's structured output for `pr`; identity threads as params.
    assert arm["input"]["requirePrFrom"] == "{{implement.output}}"
    assert arm["input"]["repo"] == "{{params.repo}}"
    assert arm["input"]["slug"] == "{{params.slug}}"


def test_review_pr_golden(snapshot) -> None:
    """The review-pr template (publish-native): setup → review with engine tokens."""
    rendered = helm.render_workflow(
        "review-pr",
        values={"reviewPr.repo": "owner/h"},
        include_local=False,
    )
    assert rendered == snapshot


def test_review_pr_with_spec_golden(snapshot) -> None:
    """review-pr with a spec param: renders an ===ORIGINAL SPEC=== section and a params.spec
    token; the spec-less golden must remain byte-identical to its snapshot (no drift)."""
    rendered = helm.render_workflow(
        "review-pr",
        values={"reviewPr.repo": "owner/h", "reviewPr.spec": "Add login flow with OAuth2."},
        include_local=False,
    )
    assert rendered == snapshot


def test_review_pr_spec_absent_when_no_spec_value() -> None:
    """When reviewPr.spec is empty (the default), the render must contain no spec section and
    no params.spec token — a spec-less chain gets a byte-identical render."""
    rendered = helm.render_workflow(
        "review-pr",
        values={"reviewPr.repo": "owner/h"},
        include_local=False,
    )
    assert "ORIGINAL SPEC" not in rendered
    assert "params.spec" not in rendered


def test_review_pr_publish_mode_opens_param_slots() -> None:
    """PR number and focus are always engine tokens (publish-native template)."""
    definition = json.loads(
        helm.to_wire_json(
            helm.render_workflow(
                "review-pr",
                values={"reviewPr.repo": "owner/h"},
                include_local=False,
            )
        )
    )
    assert [s["id"] for s in definition["steps"]] == ["setup", "review"]
    review_task = definition["steps"][1]["input"]["task"]
    assert "{{params.pr}}" in review_task
    assert "{{params.focus}}" in review_task
    assert "{{params.repo}}" in review_task  # the target repo is a fire-time identity token
    # The verdict rides the validated structured block, never a marker.
    assert "OUTPUT CONTRACT" in review_task and "verdict" in review_task
    # Executor is claude-agent — the loop's pinned reviewer (trust model; no longer claude-coder).
    assert definition["steps"][0]["input"]["agentId"] == "claude-agent"
    assert definition["steps"][1]["activity"] == "run-claude"


def test_review_pr_repo_is_a_fire_param_not_required() -> None:
    """repo is a fire-time identity param (owner/name), no longer required at publish — review-pr
    renders with no reviewPr.repo set, emitting {{params.repo}} as an engine token in the prose."""
    definition = json.loads(
        helm.to_wire_json(helm.render_workflow("review-pr", values={}, include_local=False))
    )
    review_task = definition["steps"][1]["input"]["task"]
    assert "{{params.repo}}" in review_task


def test_plugin_setup_steps_with_marketplaces_golden(snapshot) -> None:
    """h.pluginSetupSteps with a marketplace set: baked URL + {{params.plugins}} token."""
    rendered = helm.render_workflow(
        "test-plugin-setup",
        values={
            "plugins.marketplaces[0]": "https://example.com/marketplace.json",
            "publish": "true",
        },
        include_local=False,
    )
    assert rendered == snapshot


def test_plugin_setup_steps_empty_is_noop() -> None:
    """No plugins.marketplaces → helper emits nothing; setup has only the two h.setupSteps cmds."""
    rendered = helm.render_workflow("test-plugin-setup", values={}, include_local=False)
    definition = json.loads(helm.to_wire_json(rendered))
    setup_cmds = definition["steps"][0]["input"]["setup"]
    assert len(setup_cmds) == 2
    assert all("install-plugins" not in c["cmd"] for c in setup_cmds)


def test_plugin_setup_steps_publish_mode_has_params_token() -> None:
    """publish=true + a marketplace → the install cmd holds the open {{params.plugins}} slot."""
    rendered = helm.render_workflow(
        "test-plugin-setup",
        values={
            "plugins.marketplaces[0]": "https://example.com/marketplace.json",
            "publish": "true",
        },
        include_local=False,
    )
    definition = json.loads(helm.to_wire_json(rendered))
    setup_cmds = definition["steps"][0]["input"]["setup"]
    # Find the install-plugins command
    plugin_cmd = next(c["cmd"] for c in setup_cmds if "install-plugins" in c["cmd"])
    # Verify the command structure: params token and unquoted marketplace URL
    assert "{{params.plugins}}" in plugin_cmd
    assert "https://example.com/marketplace.json" in plugin_cmd
    # Verify token and URL are present in rendered output
    assert "{{params.plugins}}" in rendered
    assert "https://example.com/marketplace.json" in rendered


def test_plugin_setup_steps_marketplace_url_with_query_params() -> None:
    """Marketplace URL with query parameters (e.g., token=abc) is passed correctly to the script."""
    rendered = helm.render_workflow(
        "test-plugin-setup",
        values={
            "plugins.marketplaces[0]": "https://example.com/marketplace.json?token=abc",
            "publish": "true",
        },
        include_local=False,
    )
    definition = json.loads(helm.to_wire_json(rendered))
    setup_cmds = definition["steps"][0]["input"]["setup"]
    plugin_cmd = next(c["cmd"] for c in setup_cmds if "install-plugins" in c["cmd"])
    # URL with query params should be present as-is in the command
    assert "https://example.com/marketplace.json?token=abc" in plugin_cmd
    # Params token should still be present
    assert "{{params.plugins}}" in plugin_cmd


def test_bootstrap_repo_publish_golden(snapshot) -> None:
    """bootstrap-repo publish mode: the genesis template's rendered contract is pinned."""
    rendered = helm.render_workflow(
        "bootstrap-repo", values={"publish": "true"}, include_local=False
    )
    assert rendered == snapshot


def test_bootstrap_repo_contract_in_three_places() -> None:
    """The declared contract is identical on the step input and top-level, and the epilogue
    is rendered into the task (structured-workflow-outputs §1 — no drift possible)."""
    rendered = helm.render_workflow(
        "bootstrap-repo", values={"publish": "true"}, include_local=False
    )
    definition = json.loads(helm.to_wire_json(rendered))
    agent = next(s for s in definition["steps"] if "outputContract" in s["input"])
    assert agent["input"]["outputContract"] == definition["outputs"]
    assert "===OUTPUT CONTRACT===" in agent["input"]["task"]


def test_answer_publish_golden(snapshot) -> None:
    """answer publish mode: the bare panelizable task template (docs/plans/panels-as-a-modifier.md
    — successor of the retired hand-built agent-panel; a roster panelizes it at fire time)."""
    rendered = helm.render_workflow("answer", values={"publish": "true"}, include_local=False)
    assert rendered == snapshot


def test_answer_is_one_contract_step_with_panel_synthesis() -> None:
    """Structure contract: ONE contract-carrying step (what panelize replicates), open identity
    slots, and a top-level panelSynthesis join rule for roster runs."""
    rendered = helm.render_workflow("answer", values={"publish": "true"}, include_local=False)
    definition = json.loads(helm.to_wire_json(rendered))
    (step,) = definition["steps"]
    assert step["id"] == "answer"
    assert step["activity"] == "{{params.runActivity}}"
    assert step["input"]["outputContract"] == definition["outputs"]
    assert "===OUTPUT CONTRACT===" in step["input"]["task"]
    assert definition["outputs"]["required"] == ["answer"]
    assert "answer" in definition["panelSynthesis"]
    assert "disagreements" in definition["panelSynthesis"]
