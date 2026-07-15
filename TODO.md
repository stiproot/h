# TODO 

## Format
- [ ] example of something to do/check

##
- [ ] Move h steering (`h-runtime.md`) out of `apps/claude-agent/` to a repo-root dir delivered via an env (mirror the `skills/` + `H_SKILLS_DIR` pattern), so it's reusable across agents and the agent service stays lean. NOTE: the path is baked into `h.setupSteps` in `cli/charts/workflows/templates/_helpers.tpl` — update it (and re-bless the goldens) when this moves.
