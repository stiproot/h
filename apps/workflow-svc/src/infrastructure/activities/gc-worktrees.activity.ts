import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import { invokeAgentMethod, runActivity } from "../activity-runtime.ts";

/**
 * Step input, as the ENGINE hands it over — which is why the scalar fields are `unknown`.
 *
 * A `{{params.x}}` token resolves to whatever `-p x=v` put there, and `-p` values are strings by
 * construction. So a param-driven boolean arrives as `"true"`, not `true`, and a param-driven
 * number as `"86400000"`. The route's contract is properly typed, so SOMETHING has to normalize;
 * this activity is that boundary — the last place that still knows the value came through token
 * substitution.
 */
type Input = {
  workflowInstanceId: string;
  // Spared from collection along with anything the caller names: the sweeping run's own workspace.
  workspaceId?: string;
  minAgeMs?: unknown;
  pruneUntracked?: unknown;
  keep?: unknown;
  dryRun?: unknown;
  agentId?: string;
  traceparent?: string;
};

/** `true`/`"true"` → true; absent or blank → undefined (let the route keep its own default). */
const asBool = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toLowerCase() === "true";
};

/** A finite number, however it arrived; anything unparseable is undefined, never 0. */
const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A space-separated param, or an already-structured list. */
const asList = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().split(/\s+/);
};

type GcEntry = {
  path: string;
  branch?: string;
  outcome: "removed" | "kept";
  reason?: string;
  untracked: string[];
  bytes?: number;
};

type GcReport = { removed: GcEntry[]; kept: GcEntry[]; bytesReclaimed?: number };

/**
 * Invokes an agent's /worktree/gc to collect the worktrees h has finished with.
 *
 * The counterpart of `create-worktree`, and it targets an AGENT for the same reason that one
 * does: the shared workspace is on the agent services' filesystem and workflow-svc mounts none
 * of it. Collection is ordinary work fired as an ordinary workflow step — deliberately NOT an
 * engine action. A chain that finalizes cannot be the one to clean up, because the runs that
 * leak worst are the ones that never reach a finalize; sweeping by age from outside any single
 * run's lifecycle is what catches those.
 *
 * Returns the full report, so a template's output contract can surface what was refused and why
 * rather than just a count.
 */
export async function gcWorktreesActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<GcReport> {
  const {
    workflowInstanceId,
    workspaceId,
    minAgeMs,
    pruneUntracked,
    keep,
    dryRun,
    agentId,
    traceparent,
  } = input as Input;
  const targetAgent = agentId ?? "claude-agent";
  return runActivity(
    invokeAgentMethod({
      label: "gc-worktrees",
      appId: targetAgent,
      method: "worktree/gc",
      body: {
        workflowInstanceId,
        workspaceId,
        minAgeMs: asNumber(minAgeMs),
        pruneUntracked: asBool(pruneUntracked),
        keep: asList(keep),
        dryRun: asBool(dryRun),
      },
      span: "client",
      parse: "json",
    }).pipe(Effect.map((json) => json as GcReport)),
    traceparent,
  );
}
