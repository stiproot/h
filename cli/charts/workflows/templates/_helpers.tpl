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
- cmd: "if [ -f $AGENT_APP_DIR/steering/h-lab-runtime.md ]; then cp $AGENT_APP_DIR/steering/h-lab-runtime.md ~/.claude/CLAUDE.md; fi"
{{- end }}
