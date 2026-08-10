# Contributing

See [README.md](./README.md) for stack overview, local dev setup, and the port map.
See [CLAUDE.md](./CLAUDE.md) for key gotchas, dev commands, and architecture notes.

## Setup

```sh
# Install JS dependencies (hoisted to repo root)
bun install --frozen-lockfile

# Install Python dependencies (shared uv workspace)
uv sync --frozen

# Build all workspace packages (Turborepo resolves order)
bun run build
```

## Pre-PR checks

Run these before opening a pull request:

```sh
# TypeScript type-check, lint, and unit tests (run from the package directory)
bun run lint
bun run test

# h CLI tests including golden snapshots. The cli/h/tests path is REQUIRED: the root
# pyproject's testpaths excludes cli/h, so a bare invocation runs packages/py instead
# and reports a green that checked the wrong suite.
uv run --package h-cli pytest cli/h/tests
```

## Branches and PRs

- Branch from `main` with `feature/<slug>` (e.g. `feature/add-retry-policy`)
- Keep PRs small and focused — one concern per PR
- Include `Closes #<issue-number>` in the PR body
