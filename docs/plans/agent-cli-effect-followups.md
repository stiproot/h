**Status:** STUB — not started. Two deferred follow-ups from the `agent-cli` Effect/simplification
pass (the pass itself landed: dead code removed, dual Promise/Effect build API unified to one
`buildInvocation → Effect`, `AgentStreamParser` collapsed to `parseLine`, `Stream.mkString` +
`Effect.timed` in the runner; −122 LOC, 39 tests green). Both items below are **behaviour-changing**,
which is why they were held back for a deliberate call. **Living doc** — see the Progress log.

# agent-cli — Effect follow-ups (command-existence check + logging)

## Context

`packages/js/agent-cli` is the shared agent-CLI invoker: a `Context.Tag` service (`invoker.ts`) over a
strategy-per-agent contract (`agents/{claude,openhands,pi}.ts`), driven by an Effect + `@effect/platform`
`Command`/`Stream` process runner (`agents/run-process.ts`). Consumers: `claude-agent`,
`openhands-agent`, `pi-agent` (each wires a `*InvokerLive` layer). The recent pass Effect-ified the
easy wins; these two remaining pockets each change an observable behaviour, so they need their own
decision + validation rather than riding the mechanical refactor.

## Follow-up 1 — drop the pre-flight `which`, detect spawn `ENOENT`

**Today.** `agents/run-process.ts` calls `commandExists(prepared.command)` before spawning; that helper
(`agents/shared.ts`) runs a **synchronous blocking** `execSync("which <cmd>")` — a whole subprocess per
invocation — purely to return the exit-127 "Command not found" `InvocationResult` when the CLI is absent.

**Change.** Remove the pre-flight `which`. Let `Command.start` fail, catch the spawn error, and map an
`ENOENT` cause to the same exit-127 structured result. Removes a blocking subprocess from the hot path
and one more imperative escape hatch.

**The snag (why it's not mechanical).** Under the privilege-drop path (`SUB_AGENT_UID` set, container
mode — docs/plans/agent-process-identity.md) the runner spawns `sudo -u #<uid> -- <cmd> …`. A *missing
inner command* then surfaces as **sudo's own** exit 127, not a spawn `ENOENT` on the parent — so the
error shape and the "Command not found" stdout message differ between the direct and sudo paths. Options:
- (a) map both `ENOENT` and sudo's 127 to the exit-127 result (keep behaviour uniform across paths);
- (b) keep a check only on the sudo path, drop it on the direct path;
- (c) accept a slightly different message under sudo and document it.

**Contract to preserve.** `invoker.test.ts` asserts `exitCode === 127` and `stdout` contains
`"Command not found"` when the command does not exist — must stay green (extend it to cover the sudo
path).

**Est.** S. Touches `run-process.ts` (+ delete `commandExists`/`resolveCommand` from `shared.ts` if no
other caller remains — grep first).

## Follow-up 2 — replace the chalk logger with Effect logging

**Today.** `lib/logger.ts` is a hand-rolled `Logger` (chalk-colored `console.log`/`warn`/`error`,
`verbose` gates `debug`). After `ensureReady` was deleted, the only consumer left is
`run-process.ts`'s four `log.debug`/`log.error` lines. `chalk` is a package dependency solely for this.

**Change.** Replace the `log.*` calls with `Effect.logDebug` / `Effect.logError`, delete `lib/logger.ts`,
`createLogger`, the `Logger` type, and the `chalk` dependency from `package.json`.

**The snag.** Effect suppresses `logDebug` unless the runtime's `minimumLogLevel` is `Debug`, and routes
through the `Logger` layer (structured, not raw chalk to stdout). Consumers set no log level today, so
verbose-mode debug output — and its format/routing — **changes**. Decide the mapping for the `verbose`
flag: either set `minimumLogLevel` from `verbose` at the invoker boundary, or drop the flag and let the
consumer's `Logger` layer own verbosity. Confirm no consumer scrapes the current chalk stdout format.
Note the raw agent stdout/stderr passthrough in `run-process.ts` (`process.stdout.write(bytes)`) is
separate and stays untouched — this only concerns h's own diagnostic lines.

**Est.** S. Touches `run-process.ts`, `invoker.ts` (stops building the logger), deletes `lib/logger.ts`,
edits `package.json`.

## Non-goals

- The event-accumulation `StreamEvent[]` mutable array in `run-process.ts` — pragmatic within its scoped
  Effect; folding it purely fights the `onEvent` side-effect for no real gain. Left as-is deliberately.
- Any change to the public export surface (`AgentInvoker` tag, `*InvokerLive`, `InvocationResult`,
  `LiteLlmError`, `classifyStop`). Both follow-ups are internal.

## Progress log

- (stub created) — scoped from the agent-cli Effect pass; both items awaiting a go-ahead on their
  behaviour-change decision.
