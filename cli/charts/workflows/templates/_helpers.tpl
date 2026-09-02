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
h runtime steering into the agent's user-global ~/.claude. $H_SKILLS_DIR and $H_RULES_DIR
are agent-side shell env vars, expanded where the setup cmd runs — inert text to both helm
and the workflow engine (this is exactly the class of token that made envsubst need an
allowlist; here it needs nothing).

BOTH steps are ADDITIVE, and that is load-bearing rather than tidy. h's steering is the runtime
the agent is inside, NOT the rules of the repository it is working on — h-runtime.md's own first
paragraph says exactly that — so it has no business replacing either. The old form `cp`'d over
~/.claude/CLAUDE.md and clobbered whatever was there; on the local substrate that file is the
OPERATOR's own memory, destroyed on every --with-setup run. install-steering.sh writes only
between its markers, and `cp -n` lets a same-named skill already present win.

The skills copy serves a CONTAINERISED agent, whose home is its own. h's skills are otherwise
self-contained in the repo — a session or local agent working in an h checkout loads them from
`.claude/skills/` (symlinks to `skills/`), so nothing needs installing into the operator's home,
and `--with-setup` locally is the one path that would put them there.
*/}}
{{- define "h.setupSteps" -}}
- cmd: "mkdir -p ~/.claude/skills && cp -rn \"${H_SKILLS_DIR:?H_SKILLS_DIR must be set to the h skills root}\"/. ~/.claude/skills/"
- cmd: "if [ -f \"${H_RULES_DIR:-}\"/h-runtime.md ]; then bash \"${H_SKILLS_DIR:?H_SKILLS_DIR must be set to the h skills root}\"/install-steering.sh \"$H_RULES_DIR\"/h-runtime.md; fi"
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
Safe to leave open in publish mode: {{params.plugins}} can be empty at fire-time; the
runtime script guards against it, so callers need not. When marketplaces are configured,
the helper always emits this step; fire-time params control which plugins install.
*/}}
{{- define "h.pluginSetupSteps" -}}
{{- $mps := ((.Values.plugins).marketplaces) | default list -}}
{{- if $mps -}}
{{- $pluginsToken := include "h.token" "params.plugins" -}}
- cmd: {{ printf "bash ~/.claude/skills/install-plugins.sh \"%s\" %s" $pluginsToken (join " " $mps) | quote }}
{{- end -}}
{{- end }}

{{/*
h.outputContractEpilogue — the per-step INSTANCE of the output contract
: rendered from the template's declared schema so
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
{{- with .required }}

MANDATORY — the block MUST carry {{ range $i, $k := . }}{{ if $i }}, {{ end }}`{{ $k }}`{{ end }}.
Omitting {{ if gt (len .) 1 }}any one of them{{ else }}it{{ end }} fails the step even when the
work itself succeeded, and a long run is exactly when this gets forgotten: on 2026-08-22 a
revise-pr run rebased a branch, fixed five review findings, replied, resolved the threads and
force-pushed — 28 minutes and $7.93 — then omitted one required field and was reported as a
failed step. Re-read this line before you write the block.
{{- end }}
{{ . | toPrettyJson }}
{{- end }}

{{/*
h.worktreeSeed: the `seed` input of a create-worktree step, from the shared `.Values.worktree.seed`
list (see values.yaml). Emits NOTHING when the list is empty so a definition without seeding renders
byte-identical to before the input existed; the step input sits at six spaces in every template that
cuts a worktree, which is what the literal indent below assumes.
*/}}
{{- define "h.worktreeSeed" -}}
{{- with .Values.worktree.seed }}
      seed: {{ toJson . }}
{{- end }}
{{- end -}}
