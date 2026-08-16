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
  | { readonly kind: "refused"; readonly reason: string; readonly why: RefusalClass };

/**
 * WHY an activity is refused, and the distinction is the whole point of separating them.
 *
 * The list used to be flat — every entry read "local execution does not have this" — which quietly
 * conflated two different futures. `run-itest` needs an ephemeral k8s namespace and always will;
 * `register-cron` needs a cron engine that this substrate is in the process of growing. Written as
 * one list, the second kind is indistinguishable from the first, and "1-to-1 parity" becomes an
 * open-ended chase with no way to say what is finished.
 *
 *  - `pending`   — the capability is coming; the reason names WHAT it is waiting for.
 *  - `permanent` — it needs a cluster, a service, or a workspace this substrate does not and will
 *                  not have. Saying so out loud is what bounds the parity work.
 *
 * `scripts/check-refusal-classification.mjs` holds the list to that shape.
 */
export type RefusalClass = "pending" | "permanent";

export const BUILTIN_ACTIVITIES = ["setup", "create-worktree"] as const;
export type BuiltinActivity = (typeof BUILTIN_ACTIVITIES)[number];

const isBuiltin = (name: string): name is BuiltinActivity =>
  (BUILTIN_ACTIVITIES as readonly string[]).includes(name);

/**
 * Activities this substrate deliberately will not run, and why. The reason is the whole point:
 * each names the thing local execution does not have, so the operator knows whether to compose
 * differently or use the service substrate.
 */
type Refusal = { readonly why: RefusalClass; readonly reason: string };

const REFUSED: Readonly<Record<string, Refusal>> = {
  // PENDING — waiting on machinery this substrate is growing.
  "write-wf-row": {
    why: "pending",
    reason:
      "writing a wf: status row needs the engine BRACKET that adds it (never a template step). " +
      "The KV registry exists; the bracket lands with the cron engine that reads the goal flag",
  },
  "register-cron": {
    why: "pending",
    reason: "arming a recurrence needs the cron engine (a workflow never recurs itself)",
  },
  "register-discover": { why: "pending", reason: "arming a discovery cron needs the cron engine" },

  // PERMANENT — needs a cluster, a service, or a workspace that is not this substrate's.
  "gc-worktrees": {
    why: "permanent",
    // Not a missing capability — a DIFFERENT workspace. The activity sweeps an agent SERVICE's
    // shared workspace over Dapr; this substrate's own worktrees are the operator's, under
    // h-worktrees/, and `h worktrees sweep` is their collector.
    reason:
      "it collects an agent service's shared workspace. Local worktrees are yours: sweep them " +
      "with `h worktrees sweep [--prune-untracked]`",
  },
  "run-itest": {
    why: "permanent",
    reason:
      "the integration gate deploys an ephemeral k8s namespace. Compose without it, or pass its " +
      "skip/skipReason break-glass so the waiver is recorded, or run this on the service substrate",
  },
  // Agents that exist only as a service: no agent-cli strategy drives them.
  "run-kimi": { why: "permanent", reason: "kimi runs only as a service (no agent-cli strategy)" },
  "run-stub": { why: "permanent", reason: "the stub agent exists only as an itest service" },
  "run-dapr-agent": { why: "permanent", reason: "dapr-agent runs only as a service" },
  "run-dapr-claude-loop": {
    why: "permanent",
    reason: "dapr-claude-loop-agent runs only as a service",
  },
  "run-langgraph": { why: "permanent", reason: "langgraph-agent runs only as a service" },
  "run-claude-managed": { why: "permanent", reason: "claude-managed-agent runs only as a service" },
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
    readonly why: RefusalClass = "permanent",
  ) {
    // The class is in the message because the two refusals call for different responses: a
    // `pending` one may be worth waiting for or running on the service substrate today, while a
    // `permanent` one means compose differently. A reader should not have to grep to tell which.
    super(
      `'${activity}' cannot run on the local substrate (${why}): ${reason}.` +
        (why === "pending" ? " Run it on the service substrate meanwhile." : ""),
    );
    this.name = "RefusedActivityError";
  }
}

/** Classify one resolved activity name. Throws on an activity no substrate knows. */
export function classifyActivity(name: string): ActivityKind {
  const refused = REFUSED[name];
  if (refused) return { kind: "refused", reason: refused.reason, why: refused.why };
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
