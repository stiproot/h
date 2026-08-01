# tools/diagrams — the composable diagram-generation toolkit

The modules behind the generated diagrams in `docs/diagrams/` (protocol: the `diagrams`
skill). A package in all but manifest — deliberately NOT a `packages/js/*` workspace member:

- **It must stay zero-build.** The `--check` entry runs in `bun run lint` BEFORE `turbo
  build` (guards are pre-toolchain, able to run when `dist/` is hollow), so nothing here may
  need compilation.
- **It must never ship in an app image.** Workspace membership would cost Dockerfile-COPY
  parity across every app (`check-dockerfiles`) for a dev-only tool.
- **Type information needs no dependency edge.** Extractors read other packages' SOURCE via
  the TypeScript compiler API (the repo's pinned `typescript`); a future checker-based
  extractor loads their tsconfigs from disk. Nothing imports their runtime.

`tools/` is the home for dev/operator tooling with its own identity (`tools/ci-runner/` is
the sibling) — not guards (those stay in `scripts/`), not shipped code. If this grows into a
real family (sequence-from-template generators, Python extractors), graduation is in place:
add a package.json HERE (a standalone bun package on the `web/` precedent, OUTSIDE the
workspace glob) — still never `packages/js/*` unless runtime code imports it.

## Modules

| Module | Pure over | Job |
| --- | --- | --- |
| `sanitize.mjs` | text | Type-text → mermaid-safe member text (the 4 documented rules) |
| `ts-extract.mjs` | source text (`fromSource`) | TS AST → class body lines per manifest entry (interface / union / const / module / schema — Effect `Schema.Struct` consts, spreads + shared-fields + `as const` + `.pipe` resolved) |
| `py-extract.py` + `py-extract.mjs` | source text (`extractPyFromSource`) | Python AST (stdlib `ast`, shelled via `python3`) → class body lines (class incl. dataclasses / module + consts); the sanitize rules translated to Python syntax live in the .py, line capping stays JS-side |
| `mermaid-class.mjs` | manifest + injected extractor | classDiagram assembly; realization edges from const annotations |
| `managed-doc.mjs` | doc text | `<!-- gen:c4-code {json} -->` manifest parse + fence replacement |

Thin CLIs compose them: `gen-code-diagram.mjs` (regenerate / `--check`; the lint entry —
dispatches the extractor by the manifest entry's file extension, `.py` → py-extract, else
ts-extract; the `external` kind is a fully-curated box for collaborators with no extractable
source) and
`render.sh` (mermaid → PNG; self-provisions mermaid-cli into the gitignored `.deps/` here via
`bun add` — bun is the repo's package manager). `python3` on PATH is a lint-path requirement
once a managed doc references a `.py` file — the same interpreter the repo's uv stack already
needs. Tests: `diagrams.test.mjs` on the repo's
`node --test` convention (root `bun run test`). A new generator (e.g. sequence-from-template) = a new extractor + a new
assembler module + a thin CLI — the doc plumbing and sanitizer are shared (the Python
extractor is the first proof of that seam: `mermaid-class.mjs` composed it unchanged).
