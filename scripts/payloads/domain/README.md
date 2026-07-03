# Domain-specific payloads (gitignored)

Everything in this directory except this README is **gitignored**. It is the home for
payloads that encode organisation-specific workflow content — the things that make a
task *yours* rather than part of the h machinery:

- real repository names and paths
- internal plugin/skill names (`tessl install <org>/<plugin>`)
- production-ops instructions and issue-tracker conventions
- feature-request specs (under `feature-requests/`, consumed by
  `invoke-workflow-feature-request.sh`)

The invoke scripts look here automatically:

- `invoke-workflow-agent.sh <name>` resolves `<name>-task[.template].json` from
  `../` first, then from this directory — so domain tasks are invoked exactly like
  the committed demo tasks.
- `invoke-workflow-grooming.sh` expects `grooming-task.template.json` here.
- `invoke-workflow-feature-request.sh` expects `feature-request-task.template.json`
  here and resolves bare spec names against `feature-requests/`.
