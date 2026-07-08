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

{{/*
h.prEpilogue — the commit / push / open-PR / respond-to-review prose appended to a feature run's
FINAL step when createPr is opted in. It has ONE home here because it was previously duplicated
verbatim between feature.yaml's `implement` and `verify` steps (they share the commit/push/#20
inline-resolve steps 1/2/4 word-for-word, differing only in the decision preamble, the step-3 PR
body phrase, and the closing marker line — all switched on `.variant`).

Context (a dict):
  variant     — "implement" or "verify"; selects the three per-step framing differences.
  slug        — the feature slug (branch feature/<slug>).
  createPr    — the value emitted under ===CREATE PR===: literal 'true' (direct) or the
                {{params.createPr}} engine token (publish mode).
  issueNumber — the value emitted under ===ISSUE===: a number for `Closes #N`, else empty/token.
  gitAuth     — "ssh" swaps the push instruction to the agent-mounted key; else a one-shot token URL.

Authored at column 0; the caller pipes it through `nindent 8` and strips the trailing spaces
`nindent` leaves on blank lines (regexReplaceAll " +\n" … "\n"), so the block scalar's blank-line
separators stay truly empty. Output starts at ===CREATE PR=== and ends at the marker line with no
trailing newline — the caller supplies the surrounding blank lines.
*/}}
{{- define "h.prEpilogue" -}}
===CREATE PR===
{{ .createPr }}

===ISSUE===
{{ .issueNumber }}

The value under ===CREATE PR=== above decides how this run ends. If it is not
{{- if eq .variant "verify" }}
exactly 'true', leave everything as uncommitted working-tree changes. If it IS
'true' and your verdict is PASS (never open a PR for a failing change):
{{- else }}
exactly 'true', leave everything as uncommitted working-tree changes — do not
commit or push. If it IS 'true':
{{- end }}
1. Commit ONLY what the feature touched, on branch feature/{{ .slug }}, with a
   concise conventional commit message. Add files individually (never `git add -A`
   or `git commit -a`). Two harness artifacts must NEVER ship: restore the runner's
   MCP merge with `git checkout -- .mcp.json` (when the repo tracks that file), and
   leave plan-feature-{{ .slug }}.md uncommitted (run context, not feature code).
{{- if eq (.gitAuth | default "") "ssh" }}
2. Push the branch: git push origin feature/{{ .slug }} — the origin remote's SSH
   transport is already authenticated (agent-mounted key). If the push is rejected
   for auth, skip it and say so under ===PR=== — do not retry with credentials.
{{- else }}
2. Push the branch. The origin remote has no credentials — derive <owner>/<repo>
   from `git remote get-url origin` and push with a one-shot token URL:
   git push "https://x-access-token:${GH_TOKEN}@github.com/<owner>/<repo>.git" feature/{{ .slug }}
   Never write the token into git config or the remote URL; if GH_TOKEN is unset,
   skip the push and say so under ===PR===.
{{- end }}
3. Open a pull request against the repository's default branch with the github
   MCP tool create_pull_request: title from the feature, body summarizing the
   spec, the plan, and {{ if eq .variant "verify" }}the verify verdict{{ else }}what you implemented{{ end }}. If the value under ===ISSUE===
   above is a number N, include the line `Closes #N` on its own line in the PR
   body, so the merge auto-closes that issue. If a PR for this branch already
   exists, your push has updated it — do not open a duplicate.
4. If a PR for this branch already existed before this push (this is a revise
   run, not a first-time creation), respond to review feedback:
   a. Find the PR number: use the github MCP tool to list pull requests by
     head branch feature/{{ .slug }}.
   b. Fetch UNRESOLVED review threads: pull_request_read with method
     get_review_comments on that PR. Each thread has an isResolved field, a
     thread node id (PRRT_...), and comments with numeric ids.
   c. For each unresolved thread that this run actually addressed, reply inline
     with add_reply_to_pull_request_comment (body: "Addressed in <sha>:
     <what changed>"), then resolve it with pull_request_review_write method
     resolve_thread passing the thread node id.
   d. Do NOT reply to or resolve threads this run did not address.
   e. Never APPROVE or REQUEST_CHANGES on the PR.
{{- if eq .variant "verify" }}
After the ===VERIFY=== block, end your response with the exact marker ===PR===
on its own line, then the PR URL — or SKIPPED and the reason — on the next line.
{{- else }}
End your response with the exact marker ===PR=== on its own line, then the PR
URL — or SKIPPED and the reason — on the next line.
{{- end }}
{{- end }}
