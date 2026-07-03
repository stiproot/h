# Workflow payloads

Task and workflow definitions consumed by the `scripts/invoke-workflow-*.sh` scripts.

Two kinds live here:

- **This directory (committed)** — generic demo and pattern payloads that exercise the
  h machinery itself (skill search, multi-agent handoff, persistence, scheduling,
  repo Q&A, …). They reference nothing org-specific and work on any deployment.
- **`domain/` (gitignored)** — payloads that encode *your* organisation's workflows:
  real repo names, internal plugin/skill names, production-ops instructions, feature
  specs. See [domain/README.md](./domain/README.md).

Naming conventions (both directories):

- `<name>-task.json` / `<name>-task.template.json` — plain-English tasks for the
  workflow-agent, dispatched via `invoke-workflow-agent.sh <name>` (which searches
  this directory first, then `domain/`). `.template` files carry `${VARS}` rendered
  by `envsubst`.
- `<name>-workflow[.template].json` — explicit step-sequenced workflow definitions
  POSTed to workflow-svc by a dedicated `invoke-workflow-<name>.sh` wrapper.
