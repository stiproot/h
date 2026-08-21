---
name: author-workflow-template
description: Author a new h workflow chart template (or modify one) correctly — the template gate, render modes, the structured output contract in its three places, overlay/composition rules, goldens, and publishing. Use whenever creating a workflow template under cli/charts/workflows/templates/, adding a step to one, making a workflow chain-compatible, or changing what a workflow reports. Applies to the h repo's chart templates only.
---

# Author an h workflow template

A template under `cli/charts/workflows/templates/<name>.tmpl.yaml` renders (via helm, client-side only)
into a workflow definition: `steps:` (+ optional `params:`, `outputs:`). Follow this checklist —
every item is load-bearing; skipping one breaks other templates or silently drops your contract.

## 0. Vocabulary (mandatory)

Name things with the canonical dictionary — ARCHITECTURE.md#glossary in the h repo: steps invoke
activities; chain members (in stages) fire workflows; threaded state is the chain data. Retired
terms fail `bun run lint` (the banlist lives in scripts/check-vocabulary.mjs), so template prose
written against the glossary passes the guard by construction. A template name is an imperative
verb phrase in kebab-case (`implement`, `review-pr`, `improve-plugin`); its file is
`<name>.tmpl.yaml`, while gates and CLI operands use the bare `<name>`.

## 1. Name, role, and summary (mandatory)

Declare exactly one plain top-level `role:` inside the template gate:

- `standalone` — a complete workflow that runs alone.
- `base` — complete and deliberately extensible by overlays.
- `overlay` — a fragment that is meaningless alone and must be composed with a base.

The CLI refuses to publish or inline-run an overlay alone and rejects an all-overlay `-t` group.

Beside `role:`, declare exactly one plain top-level `summary:` — ONE line saying what the
workflow does, shown by `h template list` as the template's catalog line. It is required on
every stock template (`scripts/check-templates.mjs` fails the lint without it). The rich
documentation stays in the helm comment block; the summary is the catalog line, not the docs.

## 2. The template gate (mandatory)

Helm evaluates EVERY template file even under `-s`, so your body must be wrapped:

```yaml
{{- if eq (.Values.template | default "") "<name>" }}
role: standalone
summary: One line saying what this workflow does — the `h template list` catalog line.
...
{{- end }}
```

The gate value must equal the filename with `.tmpl.yaml` removed. Without the gate, your
template's `required` values break every other template's render.

## 3. Render modes

- **Default** — a concrete one-off definition (bakes literals).
- **`--set publish=true`** — per-run inputs become `{{params.x}}` engine tokens (emit them with the
  `h.token` helper, never literal `{{ }}`); identity (runActivity/agentId/model*) becomes params
  with values-baked defaults. This is the mode `h workflow publish` and `h template compose` use.
  **The `params:` defaults block is a CONTRACT, not just defaults**: every OPTIONAL param the
  steps reference must appear in it (an empty default like `clonePath: ""` or `focus: ""` marks
  it author-sanctioned optional), and every REQUIRED content param (e.g. a worktree template's
  `slug`) must be ABSENT from it. `h chain run`'s registration-time input validation reads the
  block exactly that way: a referenced param
  that is neither in the block nor supplied by the member's kind contract / declared `--input`s
  is REFUSED at registration. An optional param missing from the block breaks every chain that
  names the workflow.
- **`--set composable=true`** — an overlay ATOM: render only the step fragments you contribute;
  omit standalone closers. Overlay (⊕) merges by step `id`: same id → your `input.task` APPENDS to
  the existing task and your `input.setup` list CONCATENATES onto the existing one (base first —
  so a setup-contributing atom extends, never clobbers); every other input field is later-wins;
  new id → appended step. Every step needs an `id`.

## 4. The structured output contract (when a machine consumes your output)

Decide first: does anything MACHINE-read this workflow's result — a chain threads it, the goal
handshake reads it, an arm-cron guard checks it, another workflow consumes it? If NO (purely
human-read), skip this section entirely. If YES, declare the contract ONCE and render it THREE
ways (they must never drift — define the schema in a named helper and include it everywhere):

```yaml
{{- define "h.contract.<name>" -}}
type: object
required: [<the fields a consumer cannot proceed without>]
properties:
  <field>: { type: integer|string|..., description: ... }
{{- end }}
```

1. **Step input** — on the FINAL agent step:
   `outputContract: {{ include "h.contract.<name>" . | fromYaml | toJson }}`
   This is the enforcement seam: the run activity validates the agent's final fenced ```json block
   against it; a missing/mismatching block FAILS the step (watcher retries). The validated object
   lands in the step result as `structured`.
2. **Task epilogue** — at the END of that step's task prose:
   `{{ include "h.outputContractEpilogue" (include "h.contract.<name>" . | fromYaml) | nindent 8 }}`
   (generated from the schema, so instruction and contract cannot drift; the agent-global protocol
   rule in h-runtime.md tells the agent what an ===OUTPUT CONTRACT=== block means).
3. **Top-level declaration** — after `steps:`:
   `outputs:` + `{{- include "h.contract.<name>" . | nindent 2 }}`
   This is the workflow's typed output signature: chain registration validates `--capture`/`--until`
   mappings against it; `h workflow publish` / compose persist it on the saved workflow.

Schema dialect is a FAIL-CLOSED subset: `type` (object/array/string/number/integer/boolean/null),
`properties`, `required`, `items`, `enum`, `const` (+ title/description). Any other keyword rejects
the whole contract at run time — do not use it.

Rules:
- **One declarer per composition.** In a `template compose a b c` group, exactly ONE atom may
  declare `outputs:` (overlay fails loud on two). The declaring atom owns the composed workflow's
  signature — if another atom contributes a reported field (as verify.yaml contributes
  `verify: PASS|FAIL`), add that field to the DECLARER's contract and have the contributor's prose
  instruct the agent to include it in the final block.
- **No output markers.** Never instruct "end with ===SOMETHING=== then a value" — that convention
  is retired; report exclusively via the block's fields (skip/failure reasons go in a `skipped`
  string field). `===X===` headings are fine as prompt SECTION delimiters for input content
  (specs, issue numbers) — nothing parses them.
- **Required means required.** A field a downstream consumer cannot proceed without goes in
  `required`; a field that is legitimately absent in some outcomes (e.g. `pr` when the push was
  skipped) stays optional, and the chain fails loud downstream — that is correct behavior.

## 5. Chain participation (optional)

A chained workflow stays chain-agnostic: params in, declared structured output out, runnable
standalone. The engine threads state via kind contracts (`implement-pr`, `review-pr`, `revise-pr` in
workflow-svc `chain-members.ts`) or declarative member mappings (`--capture BB=FIELD`,
`--input PARAM=BB`, `--until PATH=VALUE` on `h chain run`, validated against your `outputs:` at
registration). A novel recurring shape earns a new kind (code + closed literal); a one-off shape
uses the flags.

## 6. Standard step plumbing

- Agent steps: `activity: run-claude` (or `{{params.runActivity}}` token for fire-time identity),
  `cwd: {{ h.token "worktree.worktreePath" }}` when working in a worktree, optional `model`.
- Worktree steps: `activity: create-worktree` takes a NAMED `checkout` strategy — pick by whether
  your workflow WRITES or READS.
  - Writing (commits land on a branch): `checkout: {kind: branch, branch: "feature/…"}`, plus
    `remoteBase` when you want the freshly-fetched remote tip.
  - Reading (review, audit, scout): `checkout: {kind: detached, ref: …, fetch: {remoteRef: …}}` —
    no branch is created, so nothing collides with a concurrent run holding the same one.
  - **Reviewing a PR? You cannot name its branch.** A PR head is not a local ref in the shallow
    pre-clone, so the branch strategy would silently cut a new branch from `origin/main` and
    review MAIN; a fork PR has no branch on origin at all. Fetch `refs/pull/{{params.pr}}/head`
    detached instead, as `review-pr.tmpl.yaml` does — and expose the `head`/`merge` choice as a
    param rather than baking it.
  - A read-only agent generally still WANTS a checkout: it is what makes the target repo's own
    steering (root and nested CLAUDE.md/AGENTS.md, `.claude/`, `.cursor/rules`, its gate commands)
    discoverable at all. Through an API alone, nothing enters context unless your prose named an
    exact path — so an agent judging a repo against its own conventions needs the tree.
- Setup: `{{- include "h.setupSteps" . | nindent 8 }}` installs skills + the h-runtime steering,
  ADDITIVELY — it never overwrites a CLAUDE.md or a same-named skill it did not write. Keep any
  setup step you add to that rule: on the local substrate this is the operator's own HOME.
- Cross-step references: `{{stepId.field}}` in strings, `{"$ref": "stepId.field"}` for typed
  values — dotted paths reach into results (e.g. `{{plan.structured.plan}}`).
- Org/repo config (clonePath, models, verifyCmd, gitAuth) bakes from values.yaml +
  values.local.yaml at publish time; per-run content rides `-p key=value` at fire time. Never bake
  a secret; never make config a fire-time param.
- Plugin provisioning (opt-in): `{{- include "h.pluginSetupSteps" . | nindent 8 }}` in the
  `setup:` block, after `h.setupSteps`. Marketplace SOURCES (`plugins.marketplaces` in values)
  bake at publish time; WHICH plugins to install is the `plugins` fire-time param (space-separated
  `name@marketplace` tokens, always `{{params.plugins}}`). Empty param = runtime no-op — no
  marketplace is added, no plugin touched. Omit when the template never needs plugins.

## 7. Verify and ship

1. Render it: `helm template x cli/charts/workflows -s templates/<name>.tmpl.yaml --set template=<name>
   --set publish=true [...]` — check the contract appears in all three places and
   `steps[].input.outputContract == outputs`.
2. Run the CLI tests: `uv run --package h-cli pytest cli/h/tests` (the path is required — a bare
   invocation runs the wrong suite and still reports green) — then re-bless goldens ONLY deliberately
   (`--snapshot-update`) and review the `.ambr` diff; the goldens are the chart's contract tests.
3. Publish/republish: `uv run h workflow publish <name>` (or `h template compose ... --save <key>`
   for compositions). A saved workflow does NOT update itself when the template changes.
4. If a doc names the template's behavior (CLAUDE.md, the runbook), update it in the same change.
