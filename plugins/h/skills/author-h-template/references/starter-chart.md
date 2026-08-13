# Starter consumer chart

The minimal chart a consumer repo vendors to author domain workflow templates. This is the
shape validated live by the first consumer chart (trxy's `simulate-skate-game`, 2026-08-13).
Copy the four files, then replace the skeleton template with your own.

Wire it up once in `<repo>/.h/config.toml`:

```toml
charts_dir = ".h/charts"
```

## `.h/charts/workflows/Chart.yaml`

```yaml
apiVersion: v2
name: workflows
description: >-
  This repo's domain workflow templates for the h local substrate. Each template under
  templates/ renders one workflow definition body as YAML — NOT a Kubernetes manifest; helm
  is used purely as a client-side templating engine (helm template, no cluster). Consumed by
  `h workflow run <template> --local` from this repo (charts_dir in .h/config.toml).
type: application
version: 0.1.0
```

## `.h/charts/workflows/values.yaml`

```yaml
# Fire-time identity defaults ({{params.*}} slots stay open in publish mode; these bake the
# defaults). The local substrate maps run-claude → the operator's authenticated claude CLI.
agentId: claude-agent
runActivity: run-claude

# Render modes (set by the h CLI, never by hand): --set template=<name> gates which template
# body evaluates; publish/composable select slot emission (see h's stock chart).
publish: false

# One block per template, e.g.:
# doThing:
#   env: "local"        # pin the safe environment as the default
```

## `.h/charts/workflows/templates/_helpers.tpl`

Vendored from h's stock chart (`cli/charts/workflows/templates/_helpers.tpl`) — the minimal
authoring contract: `h.token` and `h.outputContractEpilogue`. The setup helpers
(`h.setupSteps` / `h.pluginSetupSteps`) are deliberately NOT vendored — local-substrate runs
skip setup steps, and a consumer chart provisions nothing.

```yaml
{{/*
h.token — emit a workflow-engine string-interpolation token, e.g. {{params.env}}.
Built with printf so the engine's {{...}} delimiters never collide with Go-template delimiters.
*/}}
{{- define "h.token" -}}
{{- printf "{{%s}}" . -}}
{{- end }}

{{/*
h.outputContractEpilogue — the per-step INSTANCE of the output contract, rendered from the
template's declared schema so instruction and contract cannot drift. The declaring template
appends it to its final agent step's task, sets the SAME schema as that step's outputContract
input, and emits it top-level as outputs:.
*/}}
{{- define "h.outputContractEpilogue" -}}
===OUTPUT CONTRACT===
End your final message with a fenced ```json code block containing a single JSON
object matching this schema. The block is machine-validated: a missing or
mismatching block fails this step. Nothing may follow the block.
{{ . | toPrettyJson }}
{{- end }}
```

## `.h/charts/workflows/templates/do-thing.tmpl.yaml` (skeleton)

```yaml
{{- /*
do-thing workflow — one sentence on what it drives, and through which of this repo's tools
(MCP servers, scripts). Fire-time params listed here.

Run:  h workflow run do-thing --local
*/ -}}
{{- define "my.contract.doThing" -}}
type: object
required:
  - status
  - notes
properties:
  status:
    type: string
    description: completed | incomplete | failed
  notes:
    type: string
    description: frictions worth fixing — tools that refused, rules that surprised; empty if none
{{- end }}
{{- if eq (.Values.template | default "") "do-thing" }}
role: standalone
{{- $v := .Values.doThing }}
{{- $contract := include "my.contract.doThing" . | fromYaml }}
params:
  runActivity: {{ .Values.runActivity | default "run-claude" | quote }}
  agentId: {{ .Values.agentId | quote }}
  env: {{ $v.env | quote }}
steps:
  - id: work
    activity: {{ include "h.token" "params.runActivity" | quote }}
    input:
      outputContract: {{ $contract | toJson }}
      task: |-
        <the whole brief: goal, the tools to use, the decision rules, what done looks like.
        The agent starts cold — this prose is everything it knows about the domain. Refuse
        dangerous targets here explicitly, e.g.: if env is not "local", STOP and report.>

        Environment: {{ include "h.token" "params.env" }}
        {{ include "h.outputContractEpilogue" $contract | nindent 8 }}
outputs:
  {{- include "my.contract.doThing" . | nindent 2 }}
{{- end }}
```

Notes that keep the first render green:

- The contract helper name is namespaced to the repo (`my.contract.*` — pick your repo's
  prefix), never `h.contract.*`, so a search-path collision with a stock template cannot
  redefine it.
- A `notes`-style friction field in the contract is cheap and pays for itself: every run
  reports what the domain surface made awkward, which is exactly the feedback loop a domain
  MCP wants.
- Verify with `h template list` (name appears, owned by this chart), `h template get do-thing`
  (contract in all three places), then a `--local` smoke run.
