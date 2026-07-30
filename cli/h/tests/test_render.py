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
    "run-itest",
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


def test_compose_implement_verify_create_pr_creates_five_steps() -> None:
    """implement ⊕ verify ⊕ create-pr: five steps; check in implement, PR-opening in create-pr."""
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
    assert [s["id"] for s in merged["steps"]] == [
        "worktree",
        "setup",
        "plan",
        "implement",
        "create-pr",
    ]
    implement_task = next(s for s in merged["steps"] if s["id"] == "implement")["input"]["task"]
    # verify prose (acceptance check) is in the implement step
    assert "===ACCEPTANCE CHECK===" in implement_task
    # commit prose is in the implement step (composable mode)
    assert "ONLY what the feature touched" in implement_task
    create_pr = next(s for s in merged["steps"] if s["id"] == "create-pr")
    # PR-opening prose is in the create-pr step, not implement
    assert "open (or update) a pull request" in create_pr["input"]["task"]
    # exactly one outputContract declarer (create-pr, not implement)
    declarers = [s for s in merged["steps"] if "outputContract" in s.get("input", {})]
    assert len(declarers) == 1 and declarers[0]["id"] == "create-pr"


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


def test_composable_implement_commits_without_pushing(hostile_spec: Path) -> None:
    """composable=true ends implement with commit-but-no-push instructions (no PR; create-pr owns those)."""
    rendered = helm.render_workflow(
        "implement",
        values={"implement.slug": "hostile-fixture", "composable": "true"},
        file_values={"implement.spec": hostile_spec},
        include_local=False,
    )
    definition = json.loads(helm.to_wire_json(rendered))
    assert [s["id"] for s in definition["steps"]] == ["worktree", "setup", "plan", "implement"]
    implement = definition["steps"][3]["input"]["task"]
    assert "ONLY what the feature touched" in implement  # commit prose present
    assert "do not push" in implement.lower()  # no push
    assert "do not commit or push" not in implement  # standalone closer is absent in composable mode
    assert "open (or update) a pull request" not in implement  # PR-opening is create-pr's job


def test_compose_implement_create_pr_appends_create_pr_step() -> None:
    """overlay(feature[composable], create-pr) appends a new create-pr step — NOT extending implement."""
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
    # create-pr appends a NEW step (id: create-pr), separate from implement.
    assert [s["id"] for s in merged["steps"]] == ["worktree", "setup", "plan", "implement", "create-pr"]
    implement = next(s for s in merged["steps"] if s["id"] == "implement")["input"]["task"]
    # Implement has commit prose but no PR-opening prose.
    assert "First persist the plan" in implement
    assert "ONLY what the feature touched" in implement
    assert "open (or update) a pull request" not in implement
    create_pr_step = next(s for s in merged["steps"] if s["id"] == "create-pr")
    # create-pr step carries fire-time identity, cwd, and outputContract.
    assert create_pr_step["activity"] == "{{params.runActivity}}"
    assert create_pr_step["cwd"] == "{{worktree.worktreePath}}"
    assert "outputContract" in create_pr_step["input"]
    # PR-opening prose and fire-time params are in the create-pr step.
    assert "open (or update) a pull request" in create_pr_step["input"]["task"]
    assert "{{params.issueNumber}}" in create_pr_step["input"]["task"]
    assert "feature/{{params.slug}}" in create_pr_step["input"]["task"]


def test_arm_revise_golden(snapshot) -> None:
    """arm-revise overlay (§10, Job 2): a lone register-cron step arming a revise-until-merged
    cron."""
    rendered = helm.render_workflow(
        "arm-revise-pr", values={"publish": "true"}, include_local=False
    )
    assert rendered == snapshot


def test_compose_implement_verify_create_pr_arm_revise_appends_the_arm_step() -> None:
    """implement ⊕ verify ⊕ create-pr ⊕ arm-revise: six steps; arm-revise reads create-pr output."""
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
        "create-pr",
        "arm-revise-pr",
    ]
    arm = next(s for s in merged["steps"] if s["id"] == "arm-revise-pr")
    assert arm["activity"] == "register-cron"
    assert arm["input"]["workflow"] == "revise-pr"
    # The guard reads the create-pr step's structured output for `pr`; identity threads as params.
    assert arm["input"]["requirePrFrom"] == "{{create-pr.output}}"
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


def test_review_pr_spec_slot_always_open() -> None:
    """The spec param follows the focus pattern: the render always declares params.spec AND
    always carries the ===ORIGINAL SPEC=== section with its token, so a chain can thread a
    spec at FIRE time (chart-time gating would silence it — PR #80 round-1 finding). With no
    spec value the section is inert/empty; behavior, not bytes, matches the spec-less past."""
    rendered = helm.render_workflow(
        "review-pr",
        values={"reviewPr.repo": "owner/h"},
        include_local=False,
    )
    assert "===ORIGINAL SPEC===" in rendered
    assert "{{params.spec}}" in rendered
    assert 'spec: ""' in rendered  # params.spec slot is always declared


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
    """answer publish mode: the bare panelizable task template
    (docs/plans/impl/panels-as-a-modifier.md -- successor of the retired hand-built agent-panel;
    a roster panelizes it at fire time)."""
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


def test_plan_publish_golden(snapshot) -> None:
    """plan publish mode: implement's planning half, split out so the plan is a chain-visible
    artifact (docs/plans/impl/chain-plan-atom.md, docs/plans/spec-review-pipeline.md)."""
    rendered = helm.render_workflow("plan", values={"publish": "true"}, include_local=False)
    assert rendered == snapshot


def test_run_itest_golden(snapshot) -> None:
    """run-itest overlay atom (Phase 2 gate): a lone itest step carrying the worktree path token."""
    rendered = helm.render_workflow("run-itest", values={"publish": "true"}, include_local=False)
    assert rendered == snapshot


def test_run_itest_skip_golden(snapshot) -> None:
    """run-itest skip mode (break-glass): step emits skip+reason instead of the path token."""
    rendered = helm.render_workflow(
        "run-itest",
        values={"publish": "true", "itest.skip": "true"},
        include_local=False,
    )
    assert rendered == snapshot


def test_run_itest_is_one_step_with_worktree_token() -> None:
    """Structure contract: ONE step (id=itest, activity=run-itest) with the worktree path token."""
    import yaml

    rendered = helm.render_workflow("run-itest", values={"publish": "true"}, include_local=False)
    definition = yaml.safe_load(rendered)
    assert definition["role"] == "overlay"
    (step,) = definition["steps"]
    assert step["id"] == "itest"
    assert step["activity"] == "run-itest"
    assert step["input"]["worktreePath"] == "{{worktree.worktreePath}}"


def test_run_itest_skip_emits_skip_flag() -> None:
    """Skip mode: worktreePath is absent; skip=true and skipReason are present."""
    import yaml

    rendered = helm.render_workflow(
        "run-itest",
        values={"publish": "true", "itest.skip": "true"},
        include_local=False,
    )
    definition = yaml.safe_load(rendered)
    (step,) = definition["steps"]
    assert step["input"]["skip"] is True
    assert "worktreePath" not in step["input"]
    assert "skipReason" in step["input"]


def test_compose_implement_run_itest_create_pr_appends_itest_step() -> None:
    """implement ⊕ run-itest ⊕ create-pr: itest gates BEFORE create-pr; create-pr embeds itest tokens."""
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
        _atom("run-itest"),
        _atom("create-pr"),
    )
    assert [s["id"] for s in merged["steps"]] == [
        "worktree",
        "setup",
        "plan",
        "implement",
        "itest",
        "create-pr",
    ]
    itest = next(s for s in merged["steps"] if s["id"] == "itest")
    assert itest["activity"] == "run-itest"
    assert itest["input"]["worktreePath"] == "{{worktree.worktreePath}}"
    create_pr_step = next(s for s in merged["steps"] if s["id"] == "create-pr")
    # create-pr task embeds the itest scalar field tokens for PR body evidence.
    assert "{{itest.class}}" in create_pr_step["input"]["task"]
    assert "{{itest.outputTail}}" in create_pr_step["input"]["task"]


def test_composed_implement_pr_full_order_single_declarer() -> None:
    """implement ⊕ verify ⊕ run-itest ⊕ create-pr ⊕ arm-revise-pr:
    itest gates BEFORE create-pr; exactly one outputs declarer (create-pr)."""
    from h_cli.infrastructure.overlay import overlay

    atoms = [
        json.loads(
            helm.to_wire_json(
                helm.render_workflow(
                    name,
                    values={"publish": "true", "composable": "true", "verify.cmd": "bun run lint"},
                    include_local=False,
                )
            )
        )
        for name in ["implement", "verify", "run-itest", "create-pr", "arm-revise-pr"]
    ]
    merged = overlay(*atoms)
    ids = [s["id"] for s in merged["steps"]]
    assert ids == ["worktree", "setup", "plan", "implement", "itest", "create-pr", "arm-revise-pr"]
    assert ids.index("itest") < ids.index("create-pr")
    declarers = [s for s in merged["steps"] if "outputContract" in s.get("input", {})]
    assert len(declarers) == 1 and declarers[0]["id"] == "create-pr"
    assert merged["steps"][-1]["input"]["requirePrFrom"] == "{{create-pr.output}}"
    create_pr = next(s for s in merged["steps"] if s["id"] == "create-pr")
    assert create_pr["activity"] == "{{params.runActivity}}"
    assert "outputs" in merged
    assert "pr" in merged["outputs"]["properties"]


def test_plan_stops_at_the_plan_and_declares_it() -> None:
    """Structure contract: worktree → setup → plan and STOP — the split from `implement` is the
    whole point, so an implement step appearing here would silently defeat it. The plan step is
    read-only (permissionMode) and reports through the declared contract."""
    rendered = helm.render_workflow("plan", values={"publish": "true"}, include_local=False)
    definition = json.loads(helm.to_wire_json(rendered))
    assert [step["id"] for step in definition["steps"]] == ["worktree", "setup", "plan"]

    plan_step = definition["steps"][-1]
    assert plan_step["activity"] == "{{params.runActivity}}"
    assert plan_step["input"]["permissionMode"] == "plan"
    assert plan_step["input"]["cwd"] == "{{worktree.worktreePath}}"
    assert plan_step["input"]["outputContract"] == definition["outputs"]
    assert "===OUTPUT CONTRACT===" in plan_step["input"]["task"]
    assert definition["outputs"]["required"] == ["plan"]
    # Panelizable like `answer`: one contract-carrying step plus a join rule for roster runs.
    assert "plan" in definition["panelSynthesis"]
