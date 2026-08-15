# Review context fidelity — the reviewer sees what the repo says about itself

Status: Complete — both changes built, unit- and end-to-end-verified 2026-08-15; durable context lifted
Established: 2026-08-15
Lifted to:
- [CLAUDE.md](../../../CLAUDE.md) Key gotchas — the `GitCheckout` named-strategy vocabulary, the
  "a PR head is not a branch you can name" trap, and the additive-setup rule (plus the corrected
  skills-install line in the h-skills section).
- [skills/author-workflow-template](../../../skills/author-workflow-template/SKILL.md) §6 — which
  checkout strategy a new template picks and why a read-only agent still wants a checkout.
- `git-client.ts` — the `GitCheckout` doc comment carries the strategy split's rationale at the
  code; `review-pr.tmpl.yaml`'s worktree step carries the three-failure-modes argument beside the
  step it justifies.
- Tests as the executable record: `git-client.test.ts` (three `detached` cases, one per failure
  mode), `worktree-route.test.ts` (defaulting + passthrough), `execute.test.ts` (substrate parity).

## The problem

A review must judge a change against the rules the target repository states about itself. Today's
reviewers cannot, for two independent reasons — one prose, one structural.

**Prose.** The steering awareness in the review templates is three hard-coded root filenames,
offered as a suggestion:

| Template | What it says | Line |
| --- | --- | --- |
| `review-pr` | "the repository's conventions (CLAUDE.md, README.md, ARCHITECTURE.md if present)" | `review-pr.tmpl.yaml:110,116` |
| `review-spec` | "read CLAUDE.md, README.md, and architecture guidance as relevant" | `review-spec.tmpl.yaml:57` |
| `review-plan` | criterion 5 FIT names no file at all; its premise check is gated on "*if* a checkout is present" | `review-plan.tmpl.yaml:78,87` |

Note the inversion: `verify.tmpl.yaml:44` and `revise-pr.tmpl.yaml:145` tell the IMPLEMENTER and the
REVISER to go read "steering docs, and any scripts under `scripts/` or `Makefile`". The one agent
whose entire job is conformance has the narrowest instruction of the three.

**Structural, and the larger half.** `review-pr` has exactly two steps — `setup` and `run-claude`.
No `clone-repo`, no `create-worktree`. Everything is read through the GitHub MCP. So there is no cwd
checkout, and Claude Code's automatic steering discovery never fires: root `CLAUDE.md`, nested
per-directory `CLAUDE.md`, `@imports`, `.claude/skills/`, `.claude/rules`, `AGENTS.md`,
`.cursor/rules` — none of it loads. Nothing enters context unless the prose named an exact path
and the agent chose to fetch it.

Worse than absent: the `setup` step (`_helpers.tpl:20-23`) installs **h's own** skills into
`~/.claude/skills` and `cp`s `h-runtime.md` over `~/.claude/CLAUDE.md`. For a non-h target the only
AUTO-LOADED steering the reviewer has is h's. `h-runtime.md:5` says of itself: *"It is runtime
context, separate from the rules of whatever repository you are working in."* The install
contradicts the document.

Panelizing does not help: `panelize.py` replicates the same contract-carrying step per agent, so
every panelist inherits the identical blind spot and the judge only merges verdicts. A panel buys
model diversity, not context.

## The two changes

### A. Setup becomes additive

h owns a file outright and REFERENCES it from a managed block; it never truncates a file it does
not own.

```
~/.claude/h-runtime.md     h overwrites freely — h's file
~/.claude/CLAUDE.md        append-or-replace ONLY between markers, preserving everything else
```

Decisions:

- **Inline the content between markers, not `@h-runtime.md`.** An import is one line and
  self-updating, but if imports are not honoured in user memory the steering vanishes SILENTLY.
  Inline has no mechanism dependency. (Operator call, 2026-08-15.)
- **Skills copy becomes no-clobber.** In a container `~/.claude` starts empty so behaviour is
  unchanged; on the local substrate the operator's own same-named skill wins. h ships `linear` and
  `h-issues` — generic enough to collide. Cost accepted: a stale h skill in a persistent home
  never refreshes.
- Shipped as `skills/install-steering.sh` rather than a `cmd:` one-liner — precedent
  `skills/install-plugins.sh`; shell that edits the operator's HOME should be reviewable.

### B. Checkout becomes a named strategy, and the reviewer gets a worktree

**The trap that shaped this.** `addWorktree` decides via `branchExistsEffect`, which checks
`refs/heads/<branch>` — a LOCAL ref in a `--depth 1` pre-clone. Ask it for a PR's head branch and:

- the branch is not local → it fetches `origin/main` and creates a NEW branch at MAIN's tip under
  the PR branch's name. The reviewer reviews main and cannot tell.
- **fork PRs have no branch on origin at all**, so nothing resolves them by name.
- in the h-builds-h loop `review-pr` runs on the same clone right after `implement-pr`, where
  `feature/<slug>` DOES exist locally and is held by the implementer's worktree — reuse-by-branch
  (`git-client.ts:238`) would return the implementer's dirty worktree to the reviewer.

And `review-pr` carries `pr` (a number), never a head branch. The mechanism that covers all three
is GitHub's PR ref, which exists on origin for every PR including forks.

**So checkout stops being flat optional fields and becomes a closed strategy union**, mirroring
`GitAuth` in the same file (`git-client.ts:22`) — a named strategy chosen in step config, where
adding one is a change in two places (the union, the wire schema) and selecting one is DATA:

```ts
export type GitCheckout =
  | { kind: "branch";   branch?: string; baseRef?: string; remoteBase?: string }
  | { kind: "detached"; ref: string; fetch?: { remoteRef: string; depth?: number } }
```

`branch` is today's WRITE strategy (implement, plan, revise) — behaviour unchanged. `detached` is
the READ strategy: check out an existing commit-ish with NO branch, fetching `remoteRef` into `ref`
first so the ref need not exist in a shallow pre-clone. Detached is the honest state for a
read-only agent, creates no branch in the shared clone, and cannot collide with the implementer.

**GitHub PR semantics stay OUT of git-core** — `refs/pull/N/head` is a GitHub convention, while
`detached{ref, fetch}` is pure git. The sugar lives in the template, which is where "review a PR"
is a concept. That is what makes the strategy explorable: `head` vs `merge` becomes a `-p`, not a
deploy.

```yaml
params:
  prRef: "head"          # head | merge — WHAT the review looks at
steps:
  - id: worktree
    activity: create-worktree
    input:
      checkout:
        kind: detached
        ref: "refs/remotes/origin/pr/{{params.pr}}/{{params.prRef}}"
        fetch:
          remoteRef: "refs/pull/{{params.pr}}/{{params.prRef}}"
          depth: 1
```

Strategies the data may take us to, which this shape admits without redesign: `merge` (review the
PR as merged into main — catches semantic conflicts `head` misses), a deepened fetch (local
`git diff base...head`), a `tag`/`sha` audit checkout, a fork-remote strategy.

**Atomic cutover** (per the repo convention): the flat `branch`/`baseRef`/`remoteBase` fields are
DELETED in the same change set, not left as a second way to say the same thing — two spellings is
exactly the corner this change exists to avoid.

Accepted limitation, stated in the prose rather than paid for: the pre-clone is depth-1, so a
fetched PR head has no merge-base with main and `git diff origin/main...HEAD` does not work
locally. The reviewer gets the DIFF from the GitHub MCP; the worktree's job is CONTEXT (steering
discovery, precedent and duplicate-work greps).

## Touchpoints

| File | Change |
| --- | --- |
| `packages/js/git-core/src/git-client.ts` | `GitCheckout` union; `addWorktreeEffect` strategy branches |
| `packages/js/git-core/src/index.ts` | export the union |
| `packages/js/agent-server/src/worktree-route.ts` | wire contract |
| `apps/workflow-svc/.../create-worktree.activity.ts` | `Input` + body forward |
| `packages/js/local-runtime/src/domain/models.ts`, `execute.ts`, `git-workspace.ts`, `delegate.ts` | parity — both substrates share git-core |
| `cli/charts/.../{implement,plan,revise-pr}.tmpl.yaml` | cut over to `checkout: {kind: branch}` |
| `cli/charts/.../{review-pr,review-spec}.tmpl.yaml` | `worktree` step + `cwd` + steering-discovery prose |
| `cli/charts/.../_helpers.tpl`, `skills/install-steering.sh` | additive setup |
| `cli/h/tests/*.ambr` | goldens re-bless |

## Running log

- **2026-08-15** — Audit found both halves. Design settled with the operator: strategy union over
  flat fields, PR sugar in the template, atomic cutover. Building.
- **2026-08-15** — Built and green: `bun run lint` (30/30 incl. every content guard), `bun run
  test` (30/30), `uv run --package h-cli pytest cli/h/tests` (468, 18 goldens re-blessed and diffed
  by hand — the diff is exactly the setup cmds, `branch:` → `checkout:`, and review-pr/-spec's new
  step), `make lint-py`.
- **2026-08-15 — findings worth keeping:**
  - **The hex boundary refused the obvious shape.** `git-core` is in `.dependency-cruiser.cjs`'s
    `IO_PACKAGES`, so `local-runtime`'s domain cannot import `GitCheckout` even as a type. Rather
    than weaken the rule, the domain declares a structurally identical `CheckoutSpec` and
    `git-workspace.ts` assigns it straight into `addWorktree` — which makes drift a COMPILE error
    rather than a convention. Better than the import would have been.
  - **The branch fetch was silently non-forced.** Consolidating both strategies onto one `fetchInto`
    helper turned `<src>:<dst>` into `+<src>:<dst>`, so a rewritten `origin/<remoteBase>` now
    updates instead of failing non-fast-forward. Incidental, and a fix — git's own default remote
    refspec is forced for exactly this reason.
  - **`review-spec` needed the checkout more than `review-pr` did.** Its premise check ("is this
    true of the repository TODAY?") is the criterion it lives or dies by, and it was being asked to
    verify claims about a repo it could only fetch one file at a time from.
  - **The tests were indexing steps positionally.** Three CLI tests read `steps[1]` as "the review
    step"; inserting a worktree broke them. Now they select by id — the assertion that was meant.
  - **`review-plan` got the prose half only** (FIT criterion 5). It has no `repo`/`pr` param and no
    checkout of its own — on `--local` it already runs in one, and on the service substrate a plan
    can legitimately be reviewed with no repo at all, so its "when a checkout is present" hedge is
    correct rather than weak.

## Open

- **The panel still has one blind spot the checkout does not fix.** `panelize.py` replicates the
  same step per agent, so panelists share whatever the prose says — diversity of model, not of
  attention. A steering-focused panelist (one branch prompted purely on conformance) is a cheap
  experiment now that the tree is there. *Revisit when:* a review panel misses a conformance
  finding a single reviewer would have caught, or the next time panel composition is being tuned.
- **Depth-1 means no local diffing.** The reviewer cannot run `git diff base...HEAD`; the diff
  comes from the GitHub MCP and the prose says so. *Revisit when:* a review needs base-relative
  analysis the MCP diff cannot answer — the fix is a `depth`/deepen knob the strategy already has
  a slot for, not a redesign.

## Related

- `reviewer-identity-security.md` — the reviewer's EXECUTOR surface (who runs it). Distinct axis
  from this plan's WHAT IT SEES; they do not block each other.
- `spec-review-pipeline.md` — `review-spec`/`review-plan` came from there; both inherit change A,
  and `review-spec` inherits change B.
