import { resolveAgent, UnknownAgentError } from "./agents.ts";
import type { LocalAgentType } from "./models.ts";

/**
 * What an activity NAME means on the local substrate.
 *
 * A workflow definition names activities; the service substrate looks them up in workflow-svc's
 * activity registry, and this is that registry's local-substrate counterpart. It is a CLOSED
 * vocabulary in three parts:
 *
 *  - **agent** — `run-claude`/`-codex`/`-openhands`/`-pi`. The service path reaches these
 *    strategies through a Dapr invoke and an agent service's `/run`; here they are the same call
 *    without the network.
 *  - **builtin** — the provisioning steps a run needs before an agent can work.
 *  - **refused** — activities that only mean something where there is an engine, a registry or a
 *    cluster. These FAIL LOUD, naming what they need. Silently skipping a `register-cron` would
 *    report a recurrence that was never armed; silently skipping `run-itest` would report a gate
 *    that never ran. Both are worse than a refusal.
 */
export type ActivityKind =
  | { readonly kind: "agent"; readonly agent: LocalAgentType }
  | { readonly kind: "builtin"; readonly name: BuiltinActivity }
  | { readonly kind: "refused"; readonly reason: string };

export const BUILTIN_ACTIVITIES = ["setup", "create-worktree"] as const;
export type BuiltinActivity = (typeof BUILTIN_ACTIVITIES)[number];

const isBuiltin = (name: string): name is BuiltinActivity =>
  (BUILTIN_ACTIVITIES as readonly string[]).includes(name);

/**
 * Activities this substrate deliberately will not run, and why. The reason is the whole point:
 * each names the thing local execution does not have, so the operator knows whether to compose
 * differently or use the service substrate.
 */
const REFUSED: Readonly<Record<string, string>> = {
  "write-wf-row": "it writes the wf: status registry, which only workflow-svc owns",
  // Not a missing capability — a DIFFERENT workspace. The activity sweeps an agent SERVICE's
  // shared workspace over Dapr; this substrate's own worktrees are the operator's, under
  // h-worktrees/, and `h worktrees sweep` is their collector.
  "gc-worktrees":
    "it collects an agent service's shared workspace. Local worktrees are yours: sweep them " +
    "with `h worktrees sweep [--prune-untracked]`",
  "register-cron": "arming a recurrence needs the cron engine (a workflow never recurs itself)",
  "register-discover": "arming a discovery cron needs the cron engine",
  "run-itest":
    "the integration gate deploys an ephemeral k8s namespace. Compose without it, or pass its " +
    "skip/skipReason break-glass so the waiver is recorded, or run this on the service substrate",
  // Agents that exist only as a service: no agent-cli strategy drives them.
  "run-kimi": "kimi runs only as a service (no agent-cli strategy)",
  "run-stub": "the stub agent exists only as an itest service",
  "run-dapr-agent": "dapr-agent runs only as a service",
  "run-dapr-claude-loop": "dapr-claude-loop-agent runs only as a service",
  "run-langgraph": "langgraph-agent runs only as a service",
  "run-claude-managed": "claude-managed-agent runs only as a service",
};

/** An activity name no substrate knows — a definition bug, never a silent skip. */
export class UnknownActivityError extends Error {
  constructor(readonly activity: string) {
    super(
      `unknown activity '${activity}' — local execution runs run-<agent> plus ` +
        `${BUILTIN_ACTIVITIES.join(", ")}.`,
    );
    this.name = "UnknownActivityError";
  }
}

/** An activity the local substrate declines, with the reason it declines it. */
export class RefusedActivityError extends Error {
  constructor(
    readonly activity: string,
    reason: string,
  ) {
    super(`'${activity}' cannot run on the local substrate: ${reason}.`);
    this.name = "RefusedActivityError";
  }
}

/** Classify one resolved activity name. Throws on an activity no substrate knows. */
export function classifyActivity(name: string): ActivityKind {
  const refused = REFUSED[name];
  if (refused) return { kind: "refused", reason: refused };
  if (isBuiltin(name)) return { kind: "builtin", name };
  if (name.startsWith("run-")) {
    try {
      return { kind: "agent", agent: resolveAgent(name.slice("run-".length)) };
    } catch (cause) {
      if (cause instanceof UnknownAgentError) throw new UnknownActivityError(name);
      throw cause;
    }
  }
  throw new UnknownActivityError(name);
}
