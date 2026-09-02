---
name: author-h-template
description: Author a domain workflow chart template in a repo that consumes h — the consumer chart layout under .h/charts/workflows/, the vendored helpers (h.token, h.outputContractEpilogue), the template gate, params-as-contract, the structured output contract in its three places, and how to verify a render without h's repo-side guards. Use whenever creating or modifying a workflow template under this repo's .h/charts/, adding a step or param to one, or changing what a domain workflow reports. For running templates, use the use-h skill instead.
---

# Author a domain workflow template (consumer chart)

A consumer repo's domain templates live in its own helm chart —
`.h/charts/workflows/templates/<name>.tmpl.yaml` — rendered client-side (no cluster) by the
h CLI into a workflow definition: `steps:` (+ optional `params:`, `outputs:`). The chart is
the repo's to own and version: h finds it via `.h/config.toml`'s `charts_dir` and resolves
template names against the search path (this chart primary, h's stock chart fallback — a name
present in both shadows the stock one). The chart's committed `values.yaml` is ALSO layered
over h's stock defaults whenever a stock template renders from this repo — so repo facts a
stock overlay needs (`verify.cmd`, `worktree.seed`) belong there, declared once.

Copy the starting skeleton from the [starter chart](references/starter-chart.md) when the
chart or a new template doesn't exist yet. Then follow this checklist — each item is
load-bearing.

## 1. Chart layout and the vendored helpers

```
.h/charts/workflows/
├── Chart.yaml            # name: workflows; helm is a client-side templating engine here
├── values.yaml           # identity defaults + one block per template
└── templates/
    ├── _helpers.tpl      # VENDORED from h's stock chart: h.token, h.outputContractEpilogue
    └── <name>.tmpl.yaml  # one template per workflow
```

Vendor exactly the two helpers the authoring contract needs: `h.token` (emits engine tokens
like `{{params.env}}` via printf, so the engine's delimiters never collide with helm's) and
`h.outputContractEpilogue` (renders the output-contract instruction from the schema, so
instruction and contract cannot drift). Do NOT vendor h's setup helpers — local-substrate
runs skip setup steps, and a consumer chart provisions nothing. If a render breaks after an
h upgrade, re-vendor from h's `cli/charts/workflows/templates/_helpers.tpl`.

## 2. Name, gate, role (mandatory)

The template name is an imperative kebab-case verb phrase (`simulate-skate-game`,
`groom-backlog`); the file is `<name>.tmpl.yaml`. Helm evaluates EVERY template file even
when rendering one, so the body MUST be wrapped in the gate, and declare exactly one `role:`:

```yaml
{{- if eq (.Values.template | default "") "<name>" }}
role: standalone
summary: One line saying what this workflow does — the `h template list` catalog line.
...
{{- end }}
```

Without the gate, this template's `required` values break every other template's render —
including h's stock ones on the same search path. `role:` is `standalone` (complete, runs
alone), `base` (complete, extensible by overlays), or `overlay` (a fragment; the CLI refuses
to run it alone). `summary:` is the one-line catalog entry `h template list` shows beside
the role — declare it the same plain top-level way (a template without one lists as "—").

## 3. Params are a contract, not just defaults

The rendered `params:` block is read as the template's input contract: every OPTIONAL param
the steps reference must appear in it (an empty default marks it author-sanctioned optional);
every REQUIRED per-run param must be ABSENT from it, so a missing value fails loud at fire
time instead of silently rendering empty. Config (environment names, rosters, model ids)
bakes from `values.yaml`; per-run content rides `-p key=value` at fire time. Never bake a
secret; never make config a fire-time param.

Fire-time identity stays open: emit `activity: {{ include "h.token" "params.runActivity" | quote }}`
with `runActivity`/`agentId` defaults in `params:`, so `--agent` can swap the executor per
fire.

## 4. The structured output contract (when a machine reads the result)

If anything machine-consumes this workflow's result — a chain threads it, a driver parses it,
another workflow reacts to it — declare the schema ONCE in a named helper and render it in
THREE places (they must never drift):

1. **Step input** — `outputContract:` on the final agent step (the enforcement seam: the
   run validates the agent's final fenced ```json block against it; a missing or mismatching
   block fails the step).
2. **Task epilogue** — `h.outputContractEpilogue` appended to that step's task prose.
3. **Top-level `outputs:`** — the workflow's typed output signature.

The schema dialect is a FAIL-CLOSED subset: `type`, `properties`, `required`, `items`,
`enum`, `const` (+ `title`/`description`). Any other keyword rejects the whole contract at
run time. Fields a consumer cannot proceed without go in `required`; fields legitimately
absent in some outcomes stay optional. Never invent `===MARKER===` output conventions — the
fenced JSON block is the only machine-read channel. A purely human-read workflow skips this
section entirely.

## 5. Safety posture in the template itself

A domain template that mutates external state (a database, a live service, real accounts)
encodes its own guardrails: pin the safe environment as a values default (`env: "local"`),
and make the task prose REFUSE the dangerous target explicitly rather than trusting the
param never arrives. The template is the one artifact every fire goes through — a guardrail
anywhere else can be bypassed by composition.

## 6. Verify

A consumer chart is deliberately outside h's repo-side guards (goldens, template lint) — the
render IS your check, so actually run it:

```sh
h template list                  # the new name appears, owned by this chart
h template get <name>            # rendered definition: gate ok, params right, contract in
                                 # all three places (outputContract == outputs)
h workflow run <name> --local --instance-id <name>-smoke [-p …]   # a real smoke run
```

If the repo carries validation for its chart (a values.schema.json, a CI render check), keep
it green in the same change. Document the template where the repo documents its tooling —
what it does, its params, and what its `notes`/output fields mean.
