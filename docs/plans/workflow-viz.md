# Workflow viz — a live force-directed view of runs, chains, and engines

> **Phase: experimental research.** This document is the running log of a
> visualization initiative (`web/`), not a finished spec. We are exploring what
> D3 v7 can do for h's runtime graph — expect the layout section to keep growing
> with variants, some frozen as baselines and some superseded. The steering
> summary lives in the root `CLAUDE.md` (Observability → Viz) and `web/README.md`.

## Goal

A web frontend that shows, at a glance and in motion, what the h runtime is doing: which
workflows are running, how chains sequence them, what the watcher/cron engines hold, and
where money/attention is going. A data-visualization exercise first: shapes, colors, and
motion carry the state; detail lives one click away. Read-only — the viz never mutates
runtime state (the CLI and MCP surfaces stay the only write paths).

Inspiration: `stiproot/linear-graph` `web/` — Vue 3 + D3 v7 force-directed tree with typed,
styled edge layers, a legend that explains every encoding, and a details panel driven by
selection. We reuse its bones: `buildTree`-style pure graph assembly from a flat list,
layered edges, zoomable SVG.

## Data sources (all existing, all read-only)

| Source | Surface | Feeds |
| --- | --- | --- |
| saved workflows | `GET :8003/workflow/list` | template/definition nodes |
| instance status | `GET :8003/workflow/status/:id` | node color (RUNNING/COMPLETED/FAILED) |
| watch rows | `GET :8003/watch/list` | supervision ring on watched instances |
| chain rows | `GET :8003/chain/list` | chain hub nodes + sequencing edges + cursor |
| cron rows | `GET :8003/cron/list` | recurrence nodes (recur + discover), budgets |
| run ledger | obs-mcp (fs reader) | per-run cost/turns/model on the detail panel |

Gap to close: the run ledger is MCP-only today. obs-mcp is a plain Fastify app — add a
read-only JSON route (`GET /api/runs?instanceId=`) beside `/sse`, reusing the existing
`IObservabilityService` port. No new service, no sidecar change.

The `wf:` rows (goal/resolved) ride in via `dapr-mcp`'s state read only if needed later;
increment 1 works without them.

## Graph model

Nodes (shape = kind, color = state):

- **workflow instance** — circle; grey pending → pulsing blue running → green done /
  red failed. Size ∝ recent cost (ledger), so expensive runs are literally bigger.
- **chain** — diamond hub; its members orbit it, edges ordered; the cursor edge highlighted.
- **watch** — ring drawn around its subject instance (not a separate node): amber while
  watching, red when it terminated/retried.
- **cron (recur)** — clock-badged square, edge to the workflow it re-fires; badge shows
  fires/budget.
- **cron (discover)** — the same square with a fan-out edge per fired issue instance.
- **saved workflow (template)** — small hollow node; instances cluster around it.

Edges: sequencing (chain member order, solid), supervision (watch → subject, dashed
amber), recurrence (cron → workflow, dotted), fired-by (discover → instance, thin grey).
Legend explains every shape/color/dash, linear-graph style.

## Stack & layout

- `web/` — **frontend only** (NOT under `apps/` — that is a blanket bun-workspace glob, and
  joining it would drag the viz into turbo + every Dockerfile's lockfile COPY dance): Vite +
  Vue 3 + D3 v7 (mirroring linear-graph's web/,
  including its pure `lib/buildGraph.js` assembly + component split: ForceGraph / FilterBar
  / DetailsPanel). No backend of its own: the Vite dev server (and the compose nginx
  sibling) proxies `/svc/*` → workflow-svc:8003 and `/obs/*` → obs-mcp:8013, dodging CORS
  without adding a service.
- Poll loop: one `fetch` sweep every 5s (list + status of non-terminal instances + the
  three registry lists), diffed into the reactive graph — D3 simulation reheats only on
  topology change, color/state updates mutate in place (no jarring relayout).
- Not in the bun/turbo workspace graph initially (its own package.json, like cli/h is for
  uv) — `bun install` inside apps/viz; a `run-viz.sh` script + compose `viz` profile
  (nginx serving `vite build` output with the same proxy rules).

## Increments

1. **Read surface** — obs-mcp `GET /api/runs` (+ `GET /api/run/:id`); golden-free unit
   test on the route.
2. **Static graph** — apps/viz scaffold; one sweep → force graph of instances + chains +
   watches + crons, legend, shapes/colors as above. Hardcoded proxy config, `bun run dev`.
3. **Live state** — the 5s diff loop, pulsing running-state, cost-sized nodes, details
   panel (instance → status timeline, watch policy, ledger cost/turns/model).
4. **Filters** — by repo/slug (wf identity), by state, by kind; time horizon (hide
   terminal runs older than N hours).
5. **Compose profile** — `viz` profile (nginx + built assets + proxy), README + CLAUDE.md
   wiring.

## Layout research & variants (2026-07-17)

What D3 v7 actually offers for this graph, and which shapes earn a variant:

- **d3-force** (current baseline) — `forceSimulation` + link/manyBody/center/collide. The
  under-used pieces are the *positioning* forces: `forceX`/`forceY` pull nodes toward
  per-group anchors (clusters/swimlanes emerge from the same simulation), and
  `forceRadial` pins nodes to rings around a center. Organic, handles cross-links
  (chain + cron + discover edges) natively; weak at showing order/time.
- **d3-hierarchy** (`tree`/`cluster`/`pack`/`partition`/`treemap`) — tidy trees and
  containment views; needs a synthetic root and a spanning tree (our graph is a forest
  with cross-links — linear-graph's buildTree trick). Radial `tree()` reads well for
  "engines at the center, instances around them"; treemap/pack answer *where does the
  cost go* better than node size does.
- **Scales as layout** (`scaleTime` × lanes) — no layout module at all: a timeline/Gantt
  is just x = startedAt→endedAt bars in per-instance lanes. The ONLY view that shows
  *concurrency* — a panel's three parallel branches render as literally overlapping bars,
  and chain sequencing reads left-to-right. The orchestration-native view.
- **Not in core, noted**: d3-dag (Sugiyama layered DAGs — right if chains get long),
  d3-sankey (cost flow template→instance→agent), edge bundling (`curveBundle`) for hairball
  control. Deferred until the graph density demands them.

Variants implemented behind a top-bar switcher (URL `?layout=` param so `bun run snap`
captures each; one pure module per layout, shared graph data):

1. **force** — the baseline organic topology (unchanged).
2. **clusters** — same simulation + `forceX/forceY` anchors by *status* (running / done /
   failed / engines): a triage view — everything alive is in one visual bucket.
3. **orbits** — `forceRadial` rings by kind: engine hubs (chains/crons) innermost,
   instances mid-ring, their run satellites outermost; the "h as a solar system" view.
4. **timeline** — `scaleTime` Gantt: per-instance lanes, run-level bars colored by agent,
   chain edges drawn as left-to-right connectors; shows parallelism and duration honestly.

## Engine-centric iteration (2026-07-17, second pass)

`orbits` is FROZEN as a baseline (byte-identical; it is the shape we liked) — iteration
happens in a new fifth mode, **`engines`**, its engine-centric evolution. The layout draws
h's actual control topology as nested orbital systems:

- **Dead center: the tick.** One synthetic hub node for the `workflow-cron-tick` — the
  single 60s clock that drives every engine scan (watch, chain, cron, discover). Faint
  dotted spokes tick → each engine: the drive shafts.
- **Ring 1: the engines.** Chain diamonds + cron squares spaced on an inner ring.
- **Per-engine orbits.** Each engine carries its own local guide circle; its subjects sit
  ON that circle — chain members at angles encoding their ORDER (clockwise from 12,
  cursor member highlighted, an arc arrow tracing the sequence direction), a cron's fired
  instances likewise. Sequence becomes circular geometry.
- **Outer belt: unmanaged instances** — anything no engine owns drifts to a faint
  outermost ring. The picture *is* the org chart: driven work inside, ad-hoc work outside.

Same shared simulation (forceRadial for rings + per-subject anchor forces + collide),
same details panel/sweep/satellites/watch rings. `?layout=engines`.

## Non-goals

- No writes (no terminate/fire buttons in increment 1–5; if ever added they go through
  the existing HTTP surfaces with explicit confirmation).
- No new persistence — the viz renders what the registries already hold.
- No auth story yet (localhost tool, same trust domain as the MCP ports).
