# Template naming convention — verb grammar, .tmpl.yaml, declared roles

Status: Complete — all phases landed 2026-07-25; the verb grammar, the `.tmpl.yaml` file marker, declared+guarded roles, and the kind renames all shipped with the vocabulary flag day
Established: 2026-07-25

Lifted to:
- The naming rules an author must follow (imperative kebab-case verb phrase, the `.tmpl.yaml` marker, the template gate, the declared `role:`) → the `author-workflow-template` skill, which is the authoring home.
- The gate + role invariants → `scripts/check-templates.mjs`, wired into `bun run lint` — the guard IS the durable form of this plan.
- The template-gate requirement for new templates → the CLAUDE.md gotcha "Chart template gate and role".
- The member-kind trio (`implement-pr` / `review-pr` / `revise-pr`) and the both-sides rule for adding one → the Chain bullet in [CLAUDE.md](../../../CLAUDE.md) + `chain.model.ts`'s `MEMBER_KINDS`, guarded by the kind-sync test.

## Why

Template names mix grammars (verbs: `verify`, `revise`, `create-pr`; nouns: `feature`,
`pr-review`, `plugin-improvement`), template files are indistinguishable from any other YAML, and
a template's ROLE — whole workflow vs composition fragment — is only discoverable by reading its
step internals. Concretely: `h workflow publish verify` succeeds today and saves a nonsense
workflow (a task fragment aimed at a step id that doesn't exist), failing confusingly at fire
time instead of loudly at publish time.

## Locked decisions (2026-07-25, with the user)

1. **Grammar: imperative verb phrase, kebab-case** — a template names the ACTION its steps
   perform (`<verb>` or `<verb>-<object>`), so compose expressions read as sentences:
   `-t implement verify create-pr`. Applies to templates AND kinds (full uniformity).
2. **Files carry the type marker `.tmpl.yaml`; names stay bare everywhere else** — the dotted
   type-suffix house style (`.activity.ts`, `.model.ts`): the file is `implement.tmpl.yaml`, the
   template NAME (gate value, `-t` operand, `--set template=`, saved key) is `implement`. A saved
   workflow is a definition, not a template — bare keys keep that distinction.
3. **Roles are declared and enforced** — every template carries a top-level
   `role: standalone | base | overlay` (the `outputs:`/`panelSynthesis:` top-level-key pattern):
   - *standalone* — a complete workflow (`answer`, `review-pr`, `revise`, `bootstrap-repo`, …)
   - *base* — complete AND built to be extended (`implement`: honors `composable`, ends its
     implement step neutrally)
   - *overlay* — meaningless alone (`verify`/`create-pr` merge into the base's step id;
     `arm-revise` extends a PR-producing composition)
   The guard requires the declaration; the CLI REFUSES to publish or fire an overlay alone, and
   refuses a `-t` group whose atoms are ALL overlays (no trunk) — loud, with a composition hint.

## The rename matrix

| Today | Becomes (file / name) | Kind today | Kind becomes |
|---|---|---|---|
| `feature.yaml` | `implement.tmpl.yaml` / `implement` | `feature-pr` | `implement-pr` |
| `pr-review.yaml` | `review-pr.tmpl.yaml` / `review-pr` | `pr-review` | `review-pr` |
| `revise.yaml` | `revise.tmpl.yaml` / `revise` | `revise` | `revise` |
| `answer.yaml` | `answer.tmpl.yaml` / `answer` | `answer` | `answer` |
| `verify.yaml` | `verify.tmpl.yaml` / `verify` | — (overlay) | — |
| `create-pr.yaml` | `create-pr.tmpl.yaml` / `create-pr` | — (overlay) | — |
| `arm-revise.yaml` | `arm-revise.tmpl.yaml` / `arm-revise` | — (overlay) | — |
| `bootstrap-repo.yaml` | `bootstrap-repo.tmpl.yaml` / `bootstrap-repo` | — | — |
| `plugin-improvement.yaml` | `improve-plugin.tmpl.yaml` / `improve-plugin` | — | — |
| `plugin-setup-test.yaml` | `test-plugin-setup.tmpl.yaml` / `test-plugin-setup` | — | — |

Values blocks follow the names (`feature:` → `implement:`, `prReview:` → `reviewPr:`,
`pluginImprovement:` → `improvePlugin:`, `pluginSetupTest:` → `testPluginSetup:`) — including a
MIGRATION NOTE for the gitignored `values.local.yaml` (the change set ships a one-shot sed
recipe in the PR body; the render fails loud on the old keys only where `required` values move,
so the recipe is the safe path).

**Deliberately unchanged:** the `feature/<slug>` BRANCH prefix (a git-ecosystem convention,
orthogonal to template names); `_helpers.tpl` (helm's own convention); the `wf:` row shape.

## Ripple map

- **CLI**: `helm.render_workflow` resolves `<name>` → `templates/<name>.tmpl.yaml`;
  `h template list` strips the suffix; `chain.py` tables (`KNOWN_KINDS`, `WELL_KNOWN`,
  `KIND_FIRE` — instanceId prefix `feature-` → `implement-`, `KIND_MODEL_PARAMS`,
  `FROZEN_EXECUTOR_KINDS` → `review-pr`, `TERMINAL_ATOM_KIND` create-pr → implement-pr,
  `DEFAULT_EXPR`); loop-until-clean's predicate kind reference; role refusal in
  `workflow.py`/`template.py`/`chain.py` (publish, `--inline`, all-overlay `-t` groups).
- **Engine**: `ChainWorkflowKind` literal + `MEMBER_KINDS` (`feature-pr`→`implement-pr`,
  `pr-review`→`review-pr`) + contract comments + tests; kind-sync guard stays green by
  construction (it greps the literal).
- **Guards**: `check-templates.mjs` — require the `.tmpl.yaml` suffix (a bare `.yaml` in the
  templates dir fails), gate name == basename minus `.tmpl.yaml`, `role:` present and one of the
  three values. Fixture-proof all three new failure modes.
- **Docs/tests**: goldens re-bless (filenames change), `test_render` TEMPLATE_NAMES glob,
  cookbook examples, CLAUDE.md (template gate gotcha + layout lines), h-builds-h runbook,
  `author-workflow-template` skill (the convention becomes part of step 0 + a new "name and
  role" step), ARCHITECTURE.md glossary gains the template-naming paragraph.

## Phases

1. [x] Convention lands: ARCHITECTURE.md (glossary/naming paragraph) + `author-workflow-template`
   skill; the rename matrix is the spec.
2. [x] Files + names: renames, `.tmpl.yaml`, `role:` keys on all ten, gate updates, values-key
   renames, CLI resolution, goldens re-blessed, `values.local.yaml` migration recipe.
3. [x] Guards + refusals: `check-templates.mjs` extension (suffix + gate + role), CLI overlay
   refusals, fixture proofs, tests.
4. [x] **Kind renames — the wire flag day, BUNDLED with vocabulary Phase 4**
   (`ChainRow.workflows` → `members`): one drain of active chains, one engine cutover
   (`implement-pr`, `review-pr`, members field), one workflow-svc rebuild. Two pending wire
   changes, one operational moment.
5. [x] Docs sweep + cookbook update (examples rewritten in the new names, provenance notes
   kept).

## Acceptance

- `ls cli/charts/workflows/templates/` shows only `_helpers.tpl` + `*.tmpl.yaml`.
- `h template list` shows name + role for all ten; `h template compose implement verify
  create-pr` renders; `h workflow publish verify` fails loud with the composition hint.
- Kind-sync + all 12 existing guards green; engine + CLI suites green; goldens re-blessed
  deliberately.
- Post-flag-day smoke: a chain registers with `-w implement-pr -w review-pr -w revise` and
  advances.

## Log

- 2026-07-25 — Ideated + locked with the user: verb grammar for templates AND kinds; `.tmpl.yaml`
  as a FILE-level type marker (dotted house style; names stay bare in CLI/gates/keys); declared +
  guarded roles with CLI refusal for lone overlays. Kind renames bundled with the vocab Phase-4
  wire flag day.
- 2026-07-25 — Carried out template-layer phases 1, 2, 3, and 5: renamed files/names/value
  blocks, declared and enforced roles, extended guards, re-blessed goldens, and swept required
  docs. Phase 4 remains open; kind literals, saved keys, engine contracts, and wire shapes are
  deliberately unchanged.
- 2026-07-25 — Phase 4 executed locally (with the user): kinds `implement-pr` / `review-pr` /
  `revise-pr` (the trio aligned per user direction — `revise` → `revise-pr`; templates
  revise-pr.tmpl.yaml + arm-revise-pr.tmpl.yaml followed, values keys revisePr/armRevisePr),
  wire field `ChainRow.workflows` → `members` (engine, router, CLI, viz), KIND_FIRE instance
  prefix `feature-` → `implement-`. Old chain rows purged (unreadable by the new schema —
  accepted audit loss); saved key republished implement-pr; workflow-svc rebuilt; smoke chain
  advanced. overlay() also stops leaking the last atom's `role:` into composed definitions.
