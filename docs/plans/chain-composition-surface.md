**Status:** IMPLEMENTED through slice D (2026-07-09, round 7) — the format, inline overlay in a
chain (compose-on-fire), per-workflow flags, and fire-time identity are live; slices E (per-workflow
watch budgets) and F (parallel strategy) remain. Vocabulary note: a chain's members are called
**workflows** — the interim word "hop" was retired in round 7. This plan extends
[workflow-composition.md](./workflow-composition.md): it designed the v2 items that plan deferred —
**inline overlay inside a chain** and **per-workflow flag overrides** — and formalizes the CLI
surface they live in.
**Living doc** — update Decisions as they resolve and append to the Progress log.

# The h CLI format: primitives, verbs, and the chain expression

## Framing

The composition primitives landed (overlay operator, durable chain engine), but the CLI surface
grew by accretion: `h feature` predates the primitives, `h workflow compose` composes *templates*
under the workflow noun, chain's `-t` named workflow-kinds rather than templates, and every flag was
chain-wide because per-workflow granularity had no spelling. This plan formalizes the surface as a
direct projection of the architecture's own composition stack, then fills the deferred gaps
(inline overlay in a chain; per-workflow granularity) inside that structure.

Current state, concretely:

- `h workflow compose -t a -t b [--save key]` — renders templates publish+composable, `overlay()`s
  by step id, prints or saves. (`cli/h/src/h_cli/commands/workflow.py`)
- `h chain run -t <name> -t <name> --slug … --spec …` — the `-t` values were members of a
  hardcoded table (`HOP_SPECS`: `feature-pr`, `pr-review`, `revise`), a misnomer this plan fixes.
  (`cli/h/src/h_cli/commands/chain.py`)
- Engine: `ChainWorkflow` is `{kind, key, fresh?, instanceId?}` — no per-workflow params field; no `parallel`
  strategy yet (deferred in workflow-composition Phase 5).

---

## 1. The format

### 1.1 Invocation form

```
h <primitive> <verb> [operands…] [flags…]
```

The primitive nouns are the architecture's own vocabulary (the composition stack plus the
supervision registries) — the CLI is the primitives' porcelain:

> **templates —(compose)→ workflow definitions —(run)→ workflows —(chain run)→ chains**

Each noun's composition verb IS the arrow to the next level of the stack:

| Arrow | Command | Composition axis |
|---|---|---|
| templates → workflow definition | `h template compose` | spatial (overlay: one run, one agent context) |
| definition → workflow | `h workflow run` | execute (a durable run) |
| workflows → chain | `h chain run` | temporal (sequence/parallel across runs) |

`-t` always means template; `-w` always means workflow. Each noun owns its letter everywhere
(Decision 1, locked).

### 1.2 Dash discipline (fundamentals, made normative)

The POSIX/GNU convention: **dash count encodes spelling, never semantics.** `-x` (short: one
letter, bundleable, typing-optimized) and `--word` (long: self-documenting, reading-optimized) are
two spellings of the *same* option and must behave identically; bare `--` ends options; bare `-` is
stdin. The tools that gave a single dash its own meaning (X11 `-name`, Java `-jar`) are the
historical warts. h follows the convention strictly:

- Short flags are reserved for the high-frequency introducers: `-w`, `-t`, `-p` (and `-a`/`-m` as
  true aliases of `--agent`/`--model` if wanted — same behavior, shorter spelling).
- **Scope is never carried by dash count. Scope is carried by *position*** (§1.5) — the instrument
  ordered grammars actually use (ffmpeg options bind to the adjacent file, gcc `-x` applies to
  subsequent files, `find` predicates evaluate in order).

### 1.3 The primitive × verb grid

● exists today · ○ planned by this design · — not applicable

| verb | `template` | `workflow` | `chain` | `watch` |
|---|---|---|---|---|
| `compose` | ○ (relocated from `workflow compose`) | ●→relocates | inline, via `run`'s expression | — |
| `run` | — | ● | ● (gains the expression) | — |
| `list` | ○ (the chart templates) | ● | ● | ● |
| `get` | ○ (render/show one) | ● (saved definition, by key) | ○ (router exists, CLI gap) | ● |
| `status` | — | ● (run instance, by id) | covered by `get` | — |
| `publish` | ○ (≡ `compose <t> --save <t>`, unification candidate) | ●→relocates | — | — |
| `terminate` | — | ● (stop a running instance) | ○ (short-circuit a chain) | — |
| `delete` | — | — | ○ (remove a registration) | ● |

Verb hygiene: **`terminate`** stops a *running thing*; **`delete`** removes a *registration/row*.
**`get`** reads a stored definition/row; **`status`** reads a run instance. `h workflow`
deliberately spans both objects (definitions and their runs) — definitions exist to be run.

`h feature` is not a primitive — it is **porcelain** (git's porcelain/plumbing distinction): sugar
that renders + fires the feature template with spec/slug conventions. It stays, documented as
shorthand for the primitive grammar, and never grows primitive-only capabilities. (`h trigger` —
firing a `workflow-trigger` event — is a plausible future noun; out of scope here.)

### 1.4 Command signatures

```sh
h template compose ATOM [ATOM…] [--save KEY]        # overlay; prints without --save
h template list
h template get ATOM                                 # rendered view of one template

h workflow run KEY [-p k=v]… [--instance-id ID] [--fresh]
                   [--watch] [--budget DUR] [--retry N] [--agent A] [--model M]
h workflow list | get KEY | status ID | terminate ID

h chain run EXPR --slug S --spec SPEC [--issue N] [--strategy STRAT] [--max-iterations N]
h chain list | get ID | delete ID | terminate ID

h watch list | get ID | delete ID
```

### 1.5 The chain expression (EXPR) — topology AND workflow-level config, both positional

```
EXPR    := FLAG* STAGE STAGE*        # FLAGs before the first workflow = chain-wide defaults
STAGE   := WF ( "--parallel" WF )*    # workflows joined by infix --parallel form one parallel group
WF      := ( "-w" KEY | "-t" ATOM ATOM* ) FLAG*
FLAG := "--agent" A | "--model" M | "--budget" DUR | "--fresh" | "--kind" K
```

- **Stages run sequentially** (adjacency is the unmarked default: fire the next stage when the
  current one reaches terminal).
- **`--parallel` is an infix connector** (locked): `A --parallel B --parallel C` is one three-way
  group; an implied **join barrier** ends each group (the next stage fires when ALL members reach
  terminal). Shell precedent (`a & b; c`).
- **A FLAG binds to the workflow it follows** (suffix-binding — reads as prose: "workflow pr-review,
  with agent openhands, model deepseek"). Before the first workflow, it sets the chain-wide default a
  workflow can override. Suffix-binding is chosen over ffmpeg's forward-binding (options-before-the-
  file), which is that tool's most notorious confusion.
- `--agent`/`--model` are **workflow-identity config** — heterogeneity is the primary case, not the
  exception (the plan's reviewer independence is structural: review runs on a *different* agent
  than implement; the one live chain on record ran feature on openhands/DeepSeek, review on
  claude-coder). They belong on the workflow.
- A `-t` group's templates share one agent context (spatial); every stage/workflow boundary is a context
  handoff (temporal). The syntax keeps the boundary visible.

```sh
# implement with claude/opus, review with openhands/deepseek, revise fresh
h chain run --slug dark-mode --spec dark-mode.md \
    -t feature verify create-pr --agent claude --model opus \
    -w pr-review --agent openhands --model deepseek --budget 15m \
    -w revise --fresh

# homogeneous chain: an identity default before the first workflow, no repetition
h chain run --slug ci-sweep --spec ci.md --agent openhands \
    -w lint --parallel -w typecheck  -w report

# chain of one — uniform engine supervision as the degenerate case
h chain run --slug dark-mode --spec dark-mode.md -w feature-pr
```

(Globals first per §1.6. Identity flags are legal on BOTH workflow forms — identity is fire-time
params, §1.9 — provided the saved workflow was published with identity param slots; the CLI fails
loud when it wasn't.)

### 1.6 Flag scoping: two tiers, one principle

**Scope is position; dash count is spelling (§1.2).** The tier split follows what the flag
describes:

| Tier | What | Where it lives |
|---|---|---|
| **Chain-identity** | `--slug`, `--spec`, `--issue`, `--strategy`, `--max-iterations` — properties a workflow could never own | ordinary Typer-declared flags, anywhere on the line |
| **Workflow-scoped (topology + workflow-identity)** | workflow order, `--parallel` grouping, `--agent`, `--model`, `--budget`, `--fresh`, `--kind` | inside EXPR, bound by position; before the first workflow = chain-wide default |

The earlier selector design (`--agent pr-review=claude-coder`, bare = all) is **superseded**: it
treated agent/model as chain config with rare exceptions, and the premise was wrong — per-workflow
identity is the norm. Position also dissolves the problem selectors existed to solve: workflows no
longer need names or index addressing at all.

**Name-disjointness rule (implementation-critical):** a flag name used inside EXPR must NOT be
Typer-declared on `h chain run` — click consumes declared options wherever they appear in argv,
which would rip workflow flags out of the expression and destroy their position. So `--agent`,
`--model`, `--budget`, `--fresh`, `--kind`, `--parallel` are hand-parsed only; `--slug`, `--spec`,
`--issue`, `--strategy`, `--max-iterations` are Typer-declared only. The two sets stay disjoint
forever. (`--budget` thereby *moves* from Typer to EXPR: before the first workflow = whole-chain wall
clock, today's semantics; after a workflow = that workflow's watch budget.)

**Placement convention — globals first.** Everything chain-scoped precedes the first workflow:
`h chain run <chain-identity flags> <identity defaults> <EXPR>`. For FLAG defaults this is
grammar (a prefix FLAG *must* precede the first workflow to be a default); for Typer-declared flags
it is documented style, not enforcement — click consumes declared flags wherever they appear and
does not report position (precedent: git's global flags before the subcommand). One reading rule
falls out: **left of the first workflow = the chain; right of a workflow = that workflow.**

### 1.7 Value conventions (normative)

- `-p key=value` params; a `value` of `@path` splices that file's content.
- Durations: `45m`, `2h`, or bare milliseconds.
- `--save NAME` names composition output explicitly (never `mv`-style last-operand, §2.4).
- Operand lists are space-separated (`rm`-style); any token starting with `-` ends the list.

### 1.8 Parsing (implementation note)

`h template compose`'s operands are variadic positionals — click-native. `h chain run`'s EXPR is a
small ordered language no flag parser models (variadic option values + cross-option ordering +
infix connectors + position-scoped flags), so it is **hand-parsed deliberately** (ffmpeg precedent,
owning its scoped grammar): chain-identity flags stay Typer-declared (help/validation intact); the
command sets `allow_extra_args` + `ignore_unknown_options` so EXPR tokens fall through to
`ctx.args` **in order**, feeding a small STAGE/WF/FLAG parser. Honest costs: EXPR's grammar is
documented in the docstring, not auto-generated help; completions don't cover it. Accepted because
the grammar earns it — a linear value-grammar cannot express parallel groups or positional scope.

### 1.9 Identity is fire-time: params, not bake

Today the chart bakes identity at **render time** — `runActivity` (run-claude vs run-openhands)
selects each agent step's `activity`, `agentId` the workspace owner, per-step `models.*` the model
inputs — none are `{{params.*}}` slots, so a published definition's identity is frozen. Round 5
briefly accepted that as a seam (`-w` fires as-baked, only `-t` takes identity flags). Asking
*what actually stops a fire-time override* dissolved it (grounded in a read of the engine):

- **`model` and `agentId` need no engine change at all.** They live in `step.input`, and
  `resolveRefs` (`generic.workflow.ts` → `resolve-refs.ts`) interpolates `{{params.x}}` inside any
  string, recursively through the whole input. A template that emits
  `model: "{{params.modelImplement}}"` is fire-time-overridable today.
- **Only the `activity` field is frozen — by one line.** `genericWorkflow` calls
  `getActivity(step.activity)` on the raw literal *before* any resolution. Resolving the activity
  name against the params first (failing LOUD on an unresolved token or unknown resulting
  activity — never a silent fallback) unfreezes agent selection.

So identity becomes **first-class params with publish-time defaults**:

- Templates emit `activity: "{{params.runActivity}}"`, `agentId: "{{params.agentId}}"`,
  `model: "{{params.model…}}"`, and a rendered `params:` defaults block (values.yaml /
  values.local.yaml supply the *defaults* now, not the finals). The server side already merges:
  `StoredWorkflow.params` + `toRequest` apply fire-time params over stored defaults key-by-key —
  `h workflow publish` just has to pass the rendered defaults through (it currently doesn't).
- The CLI maps the user-facing pair: `--agent openhands` → `runActivity=run-openhands,
  agentId=openhands-agent` (from the CLI's existing agent registry — an explicit table, no naming
  convention magic); `--model X` → the model param(s) for the workflow's agent steps.
- Uniform across workflow forms: identity FLAGs become **fire-time params** whether the workflow is `-w`
  (published key) or `-t` (composed-on-fire) — one mechanism, no seam. In chains they ride the
  per-workflow params field (Decision 12).
- Fail-loud edge: a saved workflow published *before* identity params exist has no slots — the CLI
  detects the absence (stored `params` defaults lack `runActivity`) and errors "republish to make
  identity overridable", never silently fires the baked identity under a flag that claims
  otherwise.

What this deliberately is NOT: a structural fire-time patch mechanism ("replace step 3's input").
Overriding a *declared param slot* keeps the definition the single source of structure; arbitrary
fire-time step surgery would be the config-mutates-structure anti-pattern the composition plan
killed with `feature --pr`. Params in, structure fixed.

**Known limitation (accepted 2026-07-09):** not every agent service honors a configurable `model`
(and the dapr agent does not expose its agent SDK/adapter as configurable either). `--model` on a
workflow targeting such an agent flows through the params plumbing but is ignored by the runner. This
is acceptable for now — the surface and plumbing land first; per-agent model/SDK support is added
later, agent by agent. The CLI does not gate on it.

**Security carve-out discovered in implementation (2026-07-09, needs a ruling):** `pr-review`'s
executor is hardcoded to claude-coder DELIBERATELY — its MCP surface is github-only because the PR
diff is untrusted third-party text (no workflows/dapr/obs tools, no Linear/Notion secrets).
Identity-as-params would let any fire re-point the reviewer at a full-tool agent, so slice C gave
pr-review the `modelReview` param only and left its executor frozen. **RULED (2026-07-09):**
`--agent` on a frozen-executor workflow logs a warning and defaults to the hardcoded executor — never
an error, never silent compliance. The future allowlist of minimal-surface reviewer agents is
sketched in [reviewer-identity-security.md](./reviewer-identity-security.md) (stub, to flesh out).

---

## 2. Rationale record (how we got here)

### 2.1 Why spaces, not `+` (round 1 → 2)

Round 1 leaned `-t feature+verify+create-pr` because native click can neither take variadic option
values (`nargs='+'` is argparse; click refuses by design) nor preserve cross-option ordering — one
repeated flag with a value-grammar looked forced. `--parallel` changed the calculus: connectors
make the chain command an expression language anyway, so hand-parsing became a toll worth paying,
and space-separated groups (the `rm`/`mv` operand idiom) fell out for free.

### 2.2 Why no "chart" level below template (leaning NO, Decision 5)

Proposal considered: *charts → templates → workflows → chains*, with `-c`. Pushback, three grounds:

1. **Closure beats depth.** `rm a b c` needs no new noun because grouping files doesn't create a
   new *kind*. Same here: **template ⊕ template = template** — a composition is itself
   parameterized, composable, saveable. If templates are closed under overlay, atoms are just
   compositions of arity 1, not a separate type. (Mechanically nearly true already: `overlay()`
   takes rendered definitions, and a saved composition's steps are exactly that — Decision 11 makes
   closure deliberate.)
2. **"Chart" is taken.** In helm's own vocabulary the chart is the *package*
   (`cli/charts/workflows/`) and the atoms are its *templates* — "charts make up templates" inverts
   the tool the word comes from.
3. **Phase 3 just paid for a vocabulary migration** (family → template, code + docs). Re-slicing
   again buys no expressive power (see 1).

Revisit only if an artifact below template ever needs its own lifecycle (registry, verbs).

### 2.3 Why verbs stay (no bare-noun invocation)

`h workflow w1` puts names in the subcommand slot: is `h workflow list` the verb or a workflow
named `list`? This ambiguity is why gh spells `gh pr view 123`. `run` costs four keystrokes and
removes the collision class.

### 2.4 Why explicit `--save`, not `mv`-style last-operand output

In `h template compose t1 t2 t3`, all operands are the same kind of name — nothing disambiguates an
output. `mv` survives last-is-dest only because the filesystem usually disambiguates
(dest-is-a-directory). The failure mode here is silent: compose t1⊕t2, save as t3, when the user
meant compose all three and print. `--save NAME` keeps intent unambiguous.

### 2.5 Why position carries per-workflow scope, not selectors and not dash count (round 4)

Three candidate mechanisms for "this flag applies to that workflow":

- **Dash count** (`-agent` workflow-local vs `--agent` chain-global): **rejected on fundamentals** —
  the POSIX/GNU contract is that `-a` and `--agent` are the same option; overloading dash count
  with scope makes a one-keystroke difference carry a silent semantic difference (§1.2).
- **Selectors** (`--agent pr-review=claude-coder`, bare = all): round 2–3's leaning. Superseded —
  it presumed agent/model are chain config with rare per-workflow exceptions, and the premise was wrong:
  heterogeneous workflows are the *point* of a chain (structural reviewer independence; "review with
  openhands+deepseek, implement with claude+opus" is the motivating use case, and the one live
  chain ran exactly that way). It also required naming/indexing workflows, a whole addressing scheme.
- **Position** (FLAG binds to the workflow it follows): adopted. It is the instrument ordered
  grammars already use, it was already paid for by `--parallel`, and it deletes the addressing
  scheme — position IS the address.

Suffix-binding (flags after their workflow) over ffmpeg's forward-binding: reads as prose and avoids
ffmpeg's most notorious confusion. Prefix position (before the first workflow) = chain-wide default,
overridable per workflow.

### 2.6 Precedent survey

| Pattern | Precedent | Where it landed in h |
|---|---|---|
| Variadic operands | `rm a b c`, `cat` | `-t`/`compose` operand groups |
| Hand-parsed ordered expression | ffmpeg output scoping, `find` predicates | the chain EXPR |
| Infix connectors | shell `&&` / `|` / `&` | `--parallel` |
| Position-scoped options | ffmpeg per-file options, gcc `-x`, `find` predicate order | FLAGs (suffix-binding) |
| Short/long aliasing, never re-semantics | POSIX guidelines, GNU standards; X11 `-name` as the wart | dash discipline (§1.2) |
| Shape-driven resolution | docker image refs, kubectl `-f`, `git checkout <ref-or-path>` | a workflow is a key (`-w`) or a constructor of one (`-t` group → compose-on-fire) |
| Type-qualified tokens | kubectl `pod/web-0`, bazel `//pkg:target`, nix `nixpkgs#hello` | escape hatch if names ever collide; not the default |
| Subcommand carries the type | gh `pr`/`issue` | `h template` / `h workflow` / `h chain` / `h watch` |
| Porcelain over plumbing | git | `h feature` atop the primitive grammar |
| Everything-in-a-file | CI YAML, buildx bake, nextflow | the chainfile (§3, deferred) |
| Last-operand output | `mv src… dest` | **rejected** (§2.4) |

## 3. The chainfile (deferred, complementary)

```yaml
# chain.yaml
slug: dark-mode
strategy: loop-until-clean
workflows:
  - compose: [feature, verify, create-pr]
    agent: claude
    model: opus
  - workflow: pr-review
    agent: openhands
    model: deepseek
  - workflow: revise
    fresh: true
```

Full expressiveness (arbitrary DAGs, rich per-workflow config), versionable, honors "YAML canonical,
JSON at the wire" — but an *authoring* surface, not an *inline* one. The escape hatch for when a
chain outgrows a command line. Note the workflow shape mirrors EXPR's WF + FLAGs one-to-one — the
chainfile is the same grammar in YAML.

## 4. Engine-side implications (the honest tensions)

1. **Unfreeze the `activity` field (one line + a guard).** `genericWorkflow` resolves
   `step.activity` against the params before `getActivity`; an unresolved token or unknown
   resulting activity fails the step loudly. This is the whole engine cost of fire-time identity
   (§1.9) — `model`/`agentId` already resolve, being step inputs.
2. **`ChainWorkflow` grows per-workflow config.** FLAGs land as fields/params on the workflow row —
   agent/model as fire-time params merged over what `chain-workflows.ts buildParams` produces, budget as
   a per-workflow watch policy, fresh as today. Small model + scan change; single-writer unchanged.
3. **An inline-composed workflow still needs a `kind`.** Threading is engine code keyed on the closed
   `ChainWorkflowKind` literal. Leaning: **infer from the group's terminal atom** (`… create-pr` emits
   `===PR===` ⇒ the `feature-pr` contract — honest magic; the markers ARE the contract), with the
   `--kind` FLAG as the explicit override.
4. **Arbitrary `-w` keys vs the well-known table.** Validation moves to "key exists (or group
   composes) + kind resolvable"; the old `HOP_SPECS` became the `WELL_KNOWN`/`KIND_FIRE` hint
   tables for well-known names.
   A `revise`-kind workflow re-fires the implement workflow's instance, so the CLI resolves its key to that
   workflow's (possibly derived) key.
5. **Parallel groups need the Phase-5 `parallel` strategy** (fan-out, blackboard aggregation, join
   barrier) — deferred until a multi-reviewer chain exists. The grammar lands first, erroring
   clearly on `--parallel`; the model likely evolves `workflows: ChainWorkflow[]` → `stages: ChainWorkflow[][]`
   (a stage = parallel group, one-workflow stage as the degenerate case) — EXPR's STAGE maps onto it 1:1.
6. **Compose-on-fire publishes a derived key.** A `-t` group auto-publishes its overlay before
   registering the chain. Identity no longer differentiates renders (it's params, §1.9), but
   renders still bake host-local config (values.local.yaml), so one canonical name can silently
   mean different definitions across hosts/time; leaning instead to **chain-scoped keys**
   (`<chainId>-w<N>` — readable, collision-free, idempotent per chain; re-firing the same chain
   reuses them). Cross-chain reuse is forfeited (publishing is cheap); explicit reuse remains
   `h template compose … --save NAME` + `-w NAME`. (Decision 10.)

## 5. Implementation slices (proposed)

Each slice independently shippable; A–C are CLI-only; cuts are atomic (no alias windows), per the
no-migration-windows convention.

- **Slice A — the `h template` noun.** `h template compose|list|get`; `h workflow compose` deleted
  in the same cut. `publish` unification (Decision 14's `≡ compose <t> --save <t>`) decided here or
  explicitly deferred. Existing compose tests relocate; goldens untouched.
- **Slice B — the EXPR parser as a pure function.** `parse_expr(tokens) → {defaults, stages}`
  (sibling of `overlay.py`: dependency-free, exhaustively unit-tested) — grouping, `--parallel`,
  suffix-binding, prefix defaults, unknown-flag errors. No wiring yet.
- **Slice C — identity params (§1.9).** Engine: resolve `step.activity` before `getActivity`
  (fail-loud guard). Templates: identity literals → `{{params.runActivity}}` /
  `{{params.agentId}}` / `{{params.model…}}` tokens + a rendered `params:` defaults block;
  `h workflow publish` passes the defaults through to `save`. CLI: the `--agent` →
  `{runActivity, agentId}` mapping table; verify runners treat an empty model param as
  AGENT_MODEL-default. Goldens re-blessed deliberately. Independent of A/B.
- **Slice D — `h chain run` cutover (atomic).** Wire the parser via `ctx.args`
  (`allow_extra_args` + `ignore_unknown_options`); identity FLAGs → per-workflow fire-time params
  (uniform for `-w` and `-t`; fail-loud on slotless saved workflows); compose-on-fire
  (chain-scoped keys); kind inference (terminal atom + `--kind`); `HOP_SPECS` → hints;
  `ChainWorkflow.params` + scan merge in the engine; the old `-t <workflow-kind>` spelling cut in the same
  change. `--parallel` errors clearly ("needs the Phase-5 engine"). respx wire tests assert the
  exact `/chain/run` bodies.
- **Slice E — engine: per-workflow budget + arbitrary keys.** Per-workflow watch/budget registered on workflow
  fire; registration validation moves to "key exists + kind resolvable".
- **Slice F — parallel (workflow-composition Phase 5).** `workflows` → `stages` (`ChainWorkflow[][]`),
  fan-out/join in the scan, unlock `--parallel`.

## Decisions

1. **`-w` = workflow definition; `-t` = template — each noun owns its letter everywhere.**
   (**LOCKED** 2026-07-09. Chain's `-t` changes meaning — workflow-kind → template-group — in the same
   cut that introduces `-w`.)
2. **Space-separated operand groups, no `+` operator.** (**LOCKED** 2026-07-09.)
3. **`h <primitive> <verb>` as the formal structure; nouns = the architecture's primitives;
   `h feature` reclassified as porcelain.** (**LOCKED** direction 2026-07-09.)
4. **`--parallel` is an infix connector; adjacency = sequential; implied join barrier per group.**
   (**LOCKED** 2026-07-09 — structure must be explicit; there is no way to know a workflow is parallel
   unless the expression says so.)
5. **Per-workflow config is position-scoped in EXPR (FLAGs, suffix-binding; prefix = chain-wide
   default). `--agent`/`--model` are workflow-identity config, on the workflow.** (**LOCKED** direction
   2026-07-09, round 4 — supersedes the selector design; dash-count-as-scope rejected on
   fundamentals. Binding direction (suffix) and prefix-default semantics still open to refinement.)
6. **Dash discipline: dash count encodes spelling only; short flags reserved for high-frequency
   introducers; scope is always positional.** (**LOCKED** as a normative convention, round 4.)
7. **No "chart" level / no `-c` — two composable nouns, closure over depth.** (**LOCKED** by
   default 2026-07-09 — uncontested through rounds 2–5; revisit only if an artifact below template
   ever needs its own lifecycle. §2.2.)
8. **Verbs stay; no bare-noun invocation.** (**LOCKED** by default 2026-07-09; §2.3.)
9. **Compose output named by explicit `--save`, not `mv`-style last operand.** (**LOCKED** by
   default 2026-07-09; §2.4.)
10. **Derived key for compose-on-fire: chain-scoped (`<chainId>-w<N>`), not globally-canonical.**
    (Open — leaning chain-scoped: renders bake host-local values, so a canonical key can silently
    alias different definitions; chain-scoped keys are readable, collision-free, idempotent per
    chain. Explicit reuse stays `h template compose … --save NAME` + `-w NAME`.)
11. **Closure: a saved composition is itself composable** (template ⊕ template = template; e.g.
    `h template compose feature-pr extra-atom`). (Open — this is what makes the chart level
    unnecessary, so make it true deliberately.)
12. **`ChainWorkflow` per-workflow config fields + scan merge.** (Open — engine prerequisite for Decision 5.)
13. **Kind resolution for `-t` groups: infer from terminal atom; `--kind` FLAG override.**
    (Open.)
14. **Relocations: `h workflow compose` → `h template compose`; `h workflow publish` ≡
    `h template compose <t> --save <t>` (unify?); old chain `-t` cut atomically.** (Open — leaning
    atomic cut per the no-migration-windows convention.)
15. **`workflows` → `stages` (list-of-groups) in the chain model when `--parallel` lands.** (Open.)
16. **Typer/EXPR name-disjointness: flags parseable inside EXPR are never Typer-declared on
    `h chain run` (click would consume them and destroy position); `--budget` moves to EXPR.**
    (Open — leaning locked-by-mechanics, round 4.)
17. **Placement: globals first** — everything chain-scoped (chain-identity flags + identity
    defaults) precedes the first workflow; grammar-enforced for FLAGs, documented style for Typer
    flags. Reading rule: left of the first workflow = the chain; right of a workflow = that workflow.
    (**LOCKED** 2026-07-09, round 5.)
18. **Identity is fire-time params, uniform across `-w` and `-t`** — templates expose
    `runActivity`/`agentId`/`model…` param slots with publish-time defaults; the engine resolves
    the `activity` field (the one-line unfreeze); the CLI maps `--agent`/`--model` to params;
    slotless saved workflows fail loud under identity flags. (**LOCKED** 2026-07-09, round 6 —
    supersedes round 5's baked-identity seam, which rested on "what IS" rather than "what could
    be": the only frozen field was frozen by one unresolved lookup. Structural fire-time patching
    stays rejected — params in, structure fixed.)

## Progress log

- **2026-07-09 (round 1)** — Initial exploration: the two axes (inline overlay in a workflow; per-workflow
  granularity), the native-click parser constraint (then believed to force one workflow flag + a
  `+`-operator value grammar), the workflow-reference insight (every workflow value resolves to a saved
  workflow via compose-on-fire), the precedent survey, flag candidates (leaning `-w`).
- **2026-07-09 (round 2)** — Noun grammar settled: `-t` templates / `-w` workflows (locked),
  space-separated groups replace `+` (locked), `h template` as a top-level noun, chain-of-one as
  the degenerate case. Parser "wall" re-weighed as a toll: `--parallel` + ordered groups make the
  chain expression a small language worth hand-parsing (ffmpeg precedent) via ordered `ctx.args`.
  Pushbacks recorded: no `-c`/chart level (closure argument), keep verbs, explicit `--save` over
  `mv`-style output. Flagged the `--parallel` sketch/intent mismatch for an explicit ruling.
- **2026-07-09 (round 3)** — Formalized the surface as `h <primitive> <verb> [operands] [flags]`:
  primitive × verb grid, command signatures, the EXPR grammar, and a three-tier flag-scoping
  principle (topology positional; config global-with-selector-exceptions). `--parallel` locked as
  infix with implied join barrier. `h feature` reclassified as porcelain.
- **2026-07-09 (round 4)** — **Scoping corrected and unified on position.** The selector tier was
  built on a wrong premise: `--agent`/`--model` are not chain config with rare exceptions but
  **workflow-identity config** — heterogeneous workflows are the primary case (structural reviewer
  independence; "implement with claude/opus, review with openhands/deepseek"). Revisited `-` vs
  `--` fundamentals and made dash discipline normative (dash count = spelling, never scope; the
  X11/Java single-dash-long style is the anti-pattern), which killed the dash-count-as-scope idea
  and pointed at position — already paid for by `--parallel`. EXPR gains FLAGs (`--agent`,
  `--model`, `--budget`, `--fresh`, `--kind`), suffix-bound to their workflow, prefix position = chain
  default. Selector addressing (names/indexes) deleted wholesale — position IS the address. New
  mechanics constraint recorded: Typer/EXPR flag-name disjointness (Decision 16); `--budget` moves
  into EXPR (prefix = whole-chain wall clock, per-workflow = watch budget). Chainfile workflow shape aligned
  1:1 with WF + FLAGs.
- **2026-07-09 (round 5)** — **Pre-implementation close-out.** Locked the uncontested leanings (no
  chart level; verbs stay; explicit `--save`) and the globals-first placement convention (grammar
  for FLAG defaults, style for Typer flags; reading rule: left of the first workflow = the chain).
  Grounded the identity question in the charts: `runActivity`/`agentId`/`models.*` are render-time
  values, not params — a published definition's identity is frozen. That yields the **identity
  seam** (§1.9, Decision 18 — the one open ruling): `-w` fires as-published and errors on identity
  flags; `-t` renders at fire time and takes them; arity-1 `-t` groups make any template
  identity-configurable. Derived keys re-leaned chain-scoped (`<chainId>-w<N>`) since identity
  values make a globally-canonical key need a fingerprint. Implementation sliced A–E (template
  noun → pure EXPR parser → chain cutover → engine per-workflow budget/keys → parallel).
- **2026-07-09 (round 6)** — **The identity seam dissolved: identity is fire-time params
  (Decision 18 locked).** Asking "what actually stops an invocation-time override?" and reading
  the engine gave the answer: nothing but one raw lookup. `resolveRefs` already interpolates
  `{{params.x}}` recursively through every step input — `model` and `agentId` are
  fire-time-overridable with zero engine change once templates emit tokens; only
  `step.activity` is consumed unresolved (`getActivity` on the literal), a one-line unfreeze with
  a fail-loud guard. Identity therefore becomes declared param slots with publish-time defaults
  (values.yaml supplies defaults, not finals; `StoredWorkflow.params` + `toRequest` already merge
  fire-time over stored — publish just needs to pass the defaults through). `--agent` maps to
  `{runActivity, agentId}` via the CLI's agent registry (explicit table, no naming-convention
  magic). Identity FLAGs now legal on both workflow forms; slotless legacy saves fail loud.
  Structural fire-time patching explicitly rejected (params in, structure fixed — the
  `feature --pr` lesson). Slices re-cut A–F with identity params as its own slice (C).
- **2026-07-09 (slices A–C landed).** Three commits, each shippable, suites green (h-cli 130,
  workflow-svc 140):
  **A** — `h template compose|list|get` (variadic positionals, `--save`); `h workflow compose`
  deleted in the same cut; every chart/runbook/script reference moved to the new spelling
  (issue-sweep golden re-blessed, one line); `compose_templates()` exported for chain
  compose-on-fire. **B** — `chain_expr.py`: pure `parse_expr(tokens) → ChainExpr{defaults,
  stages}` with the full FLAG grammar, 33 tests as the grammar's spec; not yet wired into
  `h chain run` (slice D). **C** — the activity unfreeze (`resolveTokenString`, fail-loud;
  generic.workflow resolves the activity name before `getActivity`); feature.yaml publish mode
  emits identity tokens + a `params:` defaults block (non-publish renders proven byte-identical);
  `h workflow publish` and `h template compose --save` pass defaults through; `overlay()` merges
  atoms' `params` key-wise. **Discovered:** pr-review's hardcoded executor is a security invariant
  (untrusted diff → minimal MCP surface), not a bakeable default — it got `modelReview` only; the
  `--agent`-on-pr-review question is now an explicit open ruling (see Framing). Next: slice D
  (chain cutover) — blocked on that ruling only for the pr-review workflow; everything else is ready.
- **2026-07-09 (ruling + slice D landed).** Frozen-executor ruling: `--agent` on such a workflow WARNS
  and keeps the published executor (never errors, never silently complies) — captured in the new
  stub plan [reviewer-identity-security.md](./reviewer-identity-security.md). **Slice D:**
  `h chain run` is the EXPR surface — Typer keeps only chain-identity flags
  (`--slug/--spec/--issue/--strategy/--max-iterations`); the expression tokens fall through via
  `allow_extra_args`+`ignore_unknown_options` to `parse_expr`. `-w` resolves well-known names
  (feature-pr/pr-review/revise — `HOP_SPECS` became the `WELL_KNOWN`/`KIND_FIRE` hint tables) or
  any saved key with an explicit `--kind`; `-t` groups compose-on-fire (overlay → publish under
  the chain-scoped key `<slug>-w<N>`, kind inferred from the terminal atom, `--kind` override); a
  revise workflow's key is rewritten to the implement workflow's (possibly derived) key. Identity FLAGs →
  per-workflow fire-time params via `AGENT_IDENTITY` (explicit table in config.py) + per-kind model
  slots; `-w` workflows with identity flags are slot-checked against the stored defaults (fail loud on
  `--agent`, warn on `--model`). Engine: `ChainWorkflow.params` + fireHop merges workflow params OVER
  buildParams. `--parallel` and per-workflow `--budget` error/warn clearly (slice E/F). BREAKING:
  chain `--budget` moved into the EXPR prefix and is a duration token (`90m`), no longer bare
  minutes; old `-t <workflow-kind>` spelling cut atomically (use `-w`). Suites green: h-cli 138
  (+9 chain tests), workflow-svc 141. Remaining: slice E (per-workflow watch budgets), slice F
  (parallel strategy + `stages` model).
- **2026-07-09 (round 7) — "hop" retired; a chain's members are workflows.** The interim word was
  inherited jargon (and exactly the third-noun smell Decision 1's letter-ownership was meant to
  kill). Swept atomically across engine, wire, CLI, tests, and docs: `ChainHop`→`ChainWorkflow`,
  row/wire field `hops`→`workflows`, ledger `hopsFired`→`workflowsFired`, derived ids/keys
  `-h<N>`→`-w<N>`, `chain-hops.ts`→`chain-workflows.ts`, grammar nonterminals HOP/HOPFLAG→WF/FLAG,
  CLI `WorkflowRef`/`WorkflowConfig`, prose per-hop→per-workflow. Historical identifiers
  (`HOP_SPECS`) remain in this log as records of deleted code. BREAKING (dev-only): chain rows and
  ledgers persisted before the rename no longer decode — clear stale `chain:sub:*`/`chain:ledger:*`
  keys. Suites green: h-cli 138, workflow-svc 141.
