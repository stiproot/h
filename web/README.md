# h — runtime graph (`web/`)

> **Status: experimental — research phase.** This is a data-visualization
> sandbox, not a shipped product. We are actively *experimenting* with how to
> represent h's runtime (workflows, chains, and the watcher/cron engines) — the
> layout variants below coexist on purpose because the right visual language is
> still an open question. D3 v7 is the chosen medium for that exploration.
> Expect churn, dead ends, and frozen "we liked this one" baselines living
> beside their in-progress successors. `docs/plans/workflow-viz.md` is the
> running research log; treat it as a notebook, not a spec.

A live, read-only force-directed view of what the h runtime is doing: workflow
instances (circles, colored by status, sized by run cost), chain hubs (diamonds)
with ordered member edges, watch rings around supervised instances, cron squares
(recur + discover) with their re-fire edges, and per-run agent satellite dots.
Increments 2+3 of `docs/plans/workflow-viz.md`.

Standalone Vite + Vue 3 + D3 v7 package — deliberately **not** part of the bun
workspace (see the plan doc for why). Because it sits outside the workspace,
this experimentation never touches the production build/lockfile machinery —
please keep it that way (no turbo/Dockerfile/CI wiring).

## Run

Requires the h stack's read surfaces up:

- workflow-svc on `:8003` (`/workflow/*`, `/watch/list`, `/chain/list`, `/cron/list`)
- obs-mcp on `:8013` (`/api/runs`, `/api/run/:id`)

```sh
cd web
bun install
bun run dev        # http://localhost:5173
```

The dev server proxies `/svc/*` → `localhost:8003` and `/obs/*` → `localhost:8013`
(prefix stripped), so the app fetches same-origin — no CORS setup.

`bun run build` produces static assets in `dist/`; serve them behind any proxy
that mirrors the same two rules (the planned compose `viz` profile uses nginx).

## Layouts

Four layouts behind the title-bar switcher, also addressable as `?layout=` (for
headless snaps: `bun run snap 'http://localhost:5173/?layout=timeline' out.png`):

- `force` (default) — organic topology, the baseline.
- `clusters` — same simulation + `forceX/forceY` status anchors: running / done /
  failed / pending buckets, engines (chain hubs + crons) in the center.
- `orbits` — `forceRadial` rings: engines innermost, instances mid-ring, run
  satellites outermost.
- `timeline` — no simulation: a `scaleTime` Gantt, one lane per instance (newest
  top), one bar per agent run colored by agent; concurrent runs stack into
  sub-rows so parallelism is visible.

`force`/`clusters`/`orbits` share the one simulation component
(`ForceGraph.vue` + pure force modules under `src/lib/layouts/`); `timeline` is
its own component over the pure `layouts/timeline.js` geometry.

## How it works

- `src/lib/api.js` — every fetch; one 5s sweep of the list endpoints plus the
  status of the ~30 most recently active instances. `Promise.allSettled`
  throughout, so a dead service dims its slice instead of blanking the graph.
- `src/lib/buildGraph.js` — **pure** assembly: registry rows + ledger runs +
  statuses in, `{ nodes, links, rings }` out. No fetches, no DOM — unit-testable
  with `node -e`.
- `src/components/ForceGraph.vue` — diffing renderer: node/link objects keep
  identity across sweeps, and the d3 simulation is reheated **only when the
  topology changes**; pure state changes (status color, cost radius, rings,
  satellites) mutate attributes in place.
- `src/components/DetailsPanel.vue` — selection-driven; expanding a run row
  lazily fetches `/obs/api/run/:runId` and shows the output tail.
- `src/lib/constants.js` — the whole visual vocabulary (colors, shapes, edge
  styles, legend rows) in one place.

## Encodings (also in the on-screen legend)

| mark | meaning |
| --- | --- |
| circle | workflow instance — grey pending/unknown, blue+pulse running, green completed, red failed/terminated; radius ∝ √(total run cost) |
| dashed ring | watcher supervision — amber watching, red terminated/retried |
| diamond | chain hub — solid edges to members in order, cursor edge highlighted blue |
| square + ⏱ | cron — amber active, grey inactive; label `fires/maxFires`; dotted edge to the re-fired instance (recur), thin grey edges to fired issue instances (discover) |
| small dots | agent runs orbiting their instance — orange claude, teal openhands, purple pi; tooltip shows model/cost/turns |

## Driving the page headlessly (bun + playwright)

One-time: `bunx playwright install chromium` (the package is a devDependency).

```sh
bun run snap http://localhost:5173/ out.png                          # settled overview
bun run snap http://localhost:5173/ out.png --click panel-smoke-2    # click a node, panel open
```

`scripts/snap.js` waits one data sweep (`--settle` ms, default 9000), optionally clicks the
graph node whose label contains the given text, and writes a PNG — also the seed for E2E tests,
since it exercises the same selectors a user's click does.
