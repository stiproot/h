# Implementation Plan: MCP_CONFIG_MODE=replace for claude-coder

## Context
During an h-builds-h e2e run, claude-coder (the stripped agent for untrusted specs) gained access
to `actor_state_set` via the dapr MCP server. Root cause: `mergeMcpConfig` unions the incoming
source's servers with whatever the cwd's `.mcp.json` already contains — and the target repo is h
itself, whose tracked `.mcp.json` ships `dapr`/`workflows`/`obs`. Fix: an opt-in
`MCP_CONFIG_MODE=replace` env that causes the runner to overwrite the cwd's servers entirely
instead of merging.

## Changes

**`apps/claude-agent/src/infrastructure/mcp-config.ts`**
Add a `mode: 'merge' | 'replace' = 'merge'` third parameter to `mergeMcpConfig`. In replace mode,
short-circuit identically to the `existing === null` case: return `serialize(incomingJson)` — no
cwd content influences the output.

**`apps/claude-agent/src/infrastructure/claude-runner.ts`**
- Add `mcpConfigMode` to `claudeRunnerConfig` via
  `Config.string("MCP_CONFIG_MODE").pipe(Config.withDefault("merge"))`.
- Add `mcpConfigMode: string` to `ClaudeRunnerConfig` type and thread it through `resolveConfig`.
- Pass `cfg.mcpConfigMode as 'merge' | 'replace'` as the third arg to `mergeMcpConfig`.

**`apps/claude-agent/src/infrastructure/mcp-config.test.ts`**
Add one test: `"replace mode yields only the incoming servers regardless of cwd content"` — asserts
that an existing file with `dapr` + `tessl` + `someProjectSetting: true` is completely overridden
so only the incoming `dapr` + `obs` servers survive.

**`docker-compose.yml`**
Add `- MCP_CONFIG_MODE=replace` to the `claude-coder` service's `environment` block.

**`cli/scripts/run-claude-coder.sh`**
Add `export MCP_CONFIG_MODE=replace` after the existing `export MCP_CONFIG_SRC=...` line.

## Verification
1. `bun run test` in `apps/claude-agent` — new replace-mode test passes, all existing tests unchanged.
2. `bun run lint` in `apps/claude-agent` — no type errors.
3. Manual: after a worktree-based run against h via claude-coder, confirm the cwd's `.mcp.json`
   contains only `github`, not `dapr`/`obs`/`workflows`.
