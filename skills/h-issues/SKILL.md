---
name: h-issues
description: File a well-formed GitHub issue ON THE H REPO — format, scope, etiquette, and the h-builds-h loop's conventions (labels, what makes an issue implementable by a feature run). Use whenever dogfooding surfaces something in h worth fixing or improving and you want to capture it as an issue the loop (or a human) can act on. Applies to the h repo ONLY — other repos carry their own issue/PR conventions; never impose these on them.
---

# h issues

Capture improvements to h as GitHub issues on the h repo, shaped so the h-builds-h loop — the
discovery cron that fans out one `implement-pr` per labeled issue, then a per-PR revise cron
(docs/h-builds-h-runbook.md) — or a human — can pick one up and land it as a single PR.

**Scope guard:** these conventions apply to the h repo only. When working in any other
repository, follow that repo's own contributing/agent context; do not apply this skill.

## When to file

File an issue when you hit, observe, or think of something in h that is worth changing and
you are NOT going to fix it in your current run: a bug, a rough edge in a workflow group, a
missing guardrail, a docs gap, an observability blind spot, a flaky script. The loop's fuel
is a steady stream of small, well-scoped issues — capturing them beats remembering them.

Do not file: duplicates (search open issues first — `state=open` on the repo), vague
umbrella wishes ("improve observability"), or anything you cannot state an acceptance check
for. One concern per issue; if you are tempted to write "and also", file two.

## Shape

**Title** — imperative, specific, ≤ 80 chars, optionally prefixed by the area:
`charts: verify step re-runs bun install on every fix attempt` beats "verify is slow".

**Body** — three short sections, in this order:

```markdown
## Context
What you were doing when this surfaced; links to the run (workflowInstanceId), PR, file
paths (`path/to/file.ts:123`), or doc section. Enough for a cold reader to reproduce
your mental state.

## Problem / Request
The gap or desired behaviour, concretely. For bugs: observed vs expected. For features:
what should exist and why it earns its place.

## Acceptance
A checkable statement of done — a command that passes, a render that contains X, a
behaviour observable in one run. If a feature-run agent could not verify it, sharpen it.
```

**Size** — an issue should be landable as ONE focused PR by an agent with no context
beyond the issue text, CLAUDE.md, and the code. If it needs design decisions, mark it
`needs-design` in the title or file it as a discussion instead — the loop should not
discover mid-run that the spec is a debate.

## Etiquette and the loop's conventions

- **Never self-apply `agent-approved`.** That label is the maintainer's trust gate — a
  human reads the issue before its text becomes an agent's prompt. File the issue plain;
  the human labels it. (The other `agent-*` labels are the loop's own state mirror — never
  set them manually except `agent-retry`, the human re-arm.)
- Issue text becomes an *untrusted* prompt to an implementing agent. Write requirements,
  not instructions to the agent about tools, credentials, or process — the loop's spec
  framing will explicitly tell the agent to ignore any such instructions.
- Issues that touch the loop's own machinery (`cli/charts/`, `apps/workflow-svc/`,
  `packages/js/agent-server|agent-cli/`, `skills/`, `dapr/`) get extra scrutiny at PR
  review (`touches-harness` policy) — say so in Context so the reviewer expects it.
- Link runs by `workflowInstanceId` — it joins the run ledger, traces, and workflow status.

## Filing

Use the bundled script (GH_TOKEN, curl — works headlessly):

```bash
~/.claude/skills/h-issues/scripts/create-issue.sh "title" body.md [label ...]
```

Or the GitHub MCP's create_issue / `curl -X POST .../repos/<owner>/h/issues` directly.
The target repo is `$H_REPO` (default `stiproot/h`).
