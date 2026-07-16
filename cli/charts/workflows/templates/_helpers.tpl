{{/*
h.token — emit a workflow-engine string-interpolation token, e.g. {{worktree.worktreePath}}.
Built with printf so the engine's {{...}} delimiters never collide with Go-template delimiters;
workflow templates never hand-escape them. Usage:
  cwd: {{ include "h.token" "worktree.worktreePath" | quote }}
(For object-valued references prefer the engine's {"$ref": "step.field"} form, which needs no
helper — it is plain YAML/JSON with no delimiter overlap at all.)
*/}}
{{- define "h.token" -}}
{{- printf "{{%s}}" . -}}
{{- end }}

{{/*
h.setupSteps — the shared claude-agent workspace setup block: install the h skills and the
h runtime steering into the agent's user-global ~/.claude. $H_SKILLS_DIR and $AGENT_APP_DIR
are agent-side shell env vars, expanded where the setup cmd runs — inert text to both helm
and the workflow engine (this is exactly the class of token that made envsubst need an
allowlist; here it needs nothing).
*/}}
{{- define "h.setupSteps" -}}
- cmd: "mkdir -p ~/.claude/skills && cp -r $H_SKILLS_DIR/. ~/.claude/skills/"
- cmd: "if [ -f $AGENT_APP_DIR/steering/h-runtime.md ]; then cp $AGENT_APP_DIR/steering/h-runtime.md ~/.claude/CLAUDE.md; fi"
{{- end }}

{{/*
h.pluginSetupSteps — optional per-run Claude Code plugin provisioning.
Trust split:
  - SOURCES (plugins.marketplaces in values) are curated config, baked at publish time.
  - WHICH plugins to install is fire-time: the `plugins` param (space-separated
    name@marketplace tokens), always emitted as {{params.plugins}}.
No-op: if {{params.plugins}} is empty at runtime the script exits immediately —
no marketplace is added, no plugin is touched. Emits nothing when plugins.marketplaces
is empty in values. Requires h.setupSteps to precede it (script ships via H_SKILLS_DIR).
*/}}
{{- define "h.pluginSetupSteps" -}}
{{- $mps := ((.Values.plugins).marketplaces) | default list -}}
{{- if $mps -}}
{{- $pluginsToken := include "h.token" "params.plugins" -}}
- cmd: {{ printf "bash ~/.claude/skills/install-plugins.sh \"%s\" %s" $pluginsToken ($mps | join " ") | quote }}
{{- end -}}
{{- end }}

{{/*
h.outputContractEpilogue — the per-step INSTANCE of the output contract
(docs/plans/structured-workflow-outputs.md §2): rendered from the template's declared schema so
instruction and contract cannot drift. The shared PROTOCOL rule lives in h-runtime.md (installed by
h.setupSteps); this block supplies the schema adjacent to the task it governs. The declaring
template appends it to its final agent step's task (nindent to the block scalar), sets the SAME
schema as that step's `outputContract` input (the rung-2 validation seam), and emits it top-level
as `outputs:` (the registration surface). Pass the schema dict:
  {{ include "h.outputContractEpilogue" $schema | nindent 8 }}
At most ONE atom in a composition declares a contract — overlay() fails loud on two.
*/}}
{{- define "h.outputContractEpilogue" -}}
===OUTPUT CONTRACT===
End your final message with a fenced ```json code block containing a single JSON
object matching this schema. The block is machine-validated: a missing or
mismatching block fails this step. Nothing may follow the block.
{{ . | toPrettyJson }}
{{- end }}
