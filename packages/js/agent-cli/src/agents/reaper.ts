import { spawnSync } from "node:child_process";

/**
 * Orphan reaping: the invoker owns its CLI subprocess — no CLI
 * (or grandchild it spawned) may outlive its contract and keep billing a provider invisibly.
 * Observed live on the Moonshot $20 day: an agent app died mid-run and its CLI subprocess survived
 * re-parented, ran to completion, and billed with no ledger entry at all.
 *
 * What the platform already gives us: `@effect/platform-node` spawns the child `detached` on
 * POSIX, making it a session/process-group leader (pgid == pid), and its scope release
 * group-kills (`kill(-pid)`) a still-running or nonzero-exited process. What it does NOT cover —
 * and this module does:
 *
 * 1. **App death.** `process.exit()` (the agent apps' SIGTERM/SIGINT/uncaught paths) runs no
 *    Effect finalizers for in-flight runs. Every live run registers here and a lazily-installed
 *    `process.on("exit")` hook reaps the groups with SIGKILL (the app is dying — nothing left to
 *    escalate). Not covered: SIGKILL/OOM of the app itself — in container mode the PID namespace
 *    dies with PID 1 anyway; the host-mode SIGKILL residual is the plan's documented gap.
 * 2. **The dropped-uid group.** Under the sudo privilege drop (SUB_AGENT_UID) the CLI runs as a
 *    uid this process cannot signal: a `kill(-pid)` from here reaches only sudo itself (POSIX
 *    delivers to the members you may signal), which relays to its one command child —
 *    grandchildren survive. The reap shells `sudo -u #uid kill -- -pgid`, the identity allowed
 *    to take the whole group (sudoers: `agent-svc ALL=(agent-cli) NOPASSWD:SETENV: ALL`).
 * 3. **Clean-exit leftovers.** The platform's release skips cleanup when the CLI exited 0 — a
 *    background child the agent left running would linger. The run finalizer (run-process.ts)
 *    group-kills on every scope close, including normal completion.
 */

export interface LiveRun {
  /** The spawned child's pid == its process-group id (detached spawn): the CLI itself, or
   *  `sudo` on the privilege-drop path (the command child inherits sudo's group). */
  readonly pid: number;
  /** Set when the CLI runs as a dropped uid this process cannot signal directly. */
  readonly subAgentUid: string | undefined;
}

const liveRuns = new Set<LiveRun>();
let exitHookInstalled = false;

/** Register a spawned run for shutdown reaping. Installs the process-exit hook on first use. */
export function registerLiveRun(pid: number, subAgentUid: string | undefined): LiveRun {
  const run: LiveRun = { pid, subAgentUid };
  liveRuns.add(run);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // 'exit' fires on process.exit() (the agent apps' SIGTERM/SIGINT/uncaught paths all call it)
    // and on natural exit; handlers must be synchronous — killRunGroup is.
    process.on("exit", () => reapAll("SIGKILL"));
  }
  return run;
}

export function unregisterLiveRun(run: LiveRun): void {
  liveRuns.delete(run);
}

/** How many runs are currently registered (test/introspection surface). */
export function liveRunCount(): number {
  return liveRuns.size;
}

/** Kill every registered run's process group. Synchronous, never throws. */
export function reapAll(signal: NodeJS.Signals): void {
  for (const run of [...liveRuns]) {
    killRunGroup(run, signal);
    liveRuns.delete(run);
  }
}

/**
 * Kill one run's process group; ESRCH (already gone) and EPERM are swallowed — reaping is
 * best-effort by design, the accounting of what it missed lives in the ledger, not here.
 */
export function killRunGroup(run: LiveRun, signal: NodeJS.Signals = "SIGTERM"): void {
  // Privilege-drop path first: the dropped uid's members are unreachable from this uid, so the
  // group kill runs AS that uid via sudo (never throws; a non-zero status is best-effort noise).
  if (run.subAgentUid !== undefined) {
    spawnSync("sudo", [
      "--non-interactive",
      "-u",
      `#${run.subAgentUid}`,
      "kill",
      `-${signal.replace(/^SIG/, "")}`,
      "--",
      `-${run.pid}`,
    ]);
  }
  // Our own group kill: reaches the members this uid may signal (the CLI in host mode; sudo —
  // which relays to its command — in container mode).
  try {
    process.kill(-run.pid, signal);
    return;
  } catch {
    // No such group (already gone) — fall back to the single pid.
  }
  try {
    process.kill(run.pid, signal);
  } catch {
    // Already gone.
  }
}
