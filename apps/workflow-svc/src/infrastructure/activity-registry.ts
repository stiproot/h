import { type FileSystem, HttpClient, HttpClientRequest } from "@effect/platform";
import { DaprInvokeError } from "core";
import type { DaprInvokerTag } from "core-dapr";
import { Effect, type ManagedRuntime } from "effect";
import { injectTraceContext, withTraceparentParent } from "telemetry";

import { cloneRepoActivity } from "./activities/clone-repo.activity.ts";
import { copySessionActivity } from "./activities/copy-session.activity.ts";
import { createWorktreeActivity } from "./activities/create-worktree.activity.ts";
import { runClaudeActivity } from "./activities/run-claude.activity.ts";
import { runClaudeCoderActivity } from "./activities/run-claude-coder.activity.ts";
import { runClaudeManagedActivity } from "./activities/run-claude-managed.activity.ts";
import { runDaprAgentActivity } from "./activities/run-dapr-agent.activity.ts";
import { runDaprClaudeLoopActivity } from "./activities/run-dapr-claude-loop.activity.ts";
import { runLanggraphActivity } from "./activities/run-langgraph.activity.ts";
import { runOpenhandsActivity } from "./activities/run-openhands.activity.ts";
import { setupActivity } from "./activities/setup.activity.ts";

export const activities = [
  setupActivity,
  cloneRepoActivity,
  createWorktreeActivity,
  runClaudeActivity,
  runClaudeCoderActivity,
  runClaudeManagedActivity,
  runDaprClaudeLoopActivity,
  runLanggraphActivity,
  runOpenhandsActivity,
  runDaprAgentActivity,
  copySessionActivity,
];

export function getActivity(name: string) {
  switch (name) {
    case "setup":
      return setupActivity;
    case "clone-repo":
      return cloneRepoActivity;
    case "create-worktree":
      return createWorktreeActivity;
    case "run-claude":
      return runClaudeActivity;
    case "run-claude-coder":
      return runClaudeCoderActivity;
    case "run-claude-managed":
      return runClaudeManagedActivity;
    case "run-dapr-claude-loop":
      return runDaprClaudeLoopActivity;
    case "run-langgraph":
      return runLanggraphActivity;
    case "run-openhands":
      return runOpenhandsActivity;
    case "run-dapr-agent":
      return runDaprAgentActivity;
    case "copy-session":
      return copySessionActivity;
    default:
      throw new Error(`Unknown activity: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// The activity-to-Effect bridge. The Dapr WorkflowRuntime invokes activities as bare
// `async (ctx, input)` callbacks on its own schedule, outside Effect (refactor map §3);
// each activity's BODY is an Effect run through ONE shared ManagedRuntime handle,
// injected once from index.ts at startup. A per-activity ManagedRuntime rebuild is
// forbidden — it would tear down and rebuild every layer on each activity call (§6).
// ---------------------------------------------------------------------------

/** Everything an activity effect may yield from the shared runtime. */
export type ActivityEnv = DaprInvokerTag | HttpClient.HttpClient | FileSystem.FileSystem;

export type ActivityRuntime = ManagedRuntime.ManagedRuntime<ActivityEnv, never>;

let activityRuntime: ActivityRuntime | undefined;

/** Set once from the composition root, before the WorkflowRuntime starts. */
export function setActivityRuntime(runtime: ActivityRuntime): void {
  activityRuntime = runtime;
}

/**
 * Runs one activity's Effect body on the shared runtime. `withTraceparentParent` is the
 * Effect sibling of the legacy `contextFromTraceparent` re-attachment: the originating
 * request's traceparent rides the workflow input across Dapr's async/replay boundary
 * (see generic.workflow.ts) and re-parents this fiber's spans under that trace.
 */
export function runActivity<A, E>(
  effect: Effect.Effect<A, E, ActivityEnv>,
  traceparent: string | undefined,
): Promise<A> {
  if (!activityRuntime) {
    return Promise.reject(new Error("activity runtime not initialised"));
  }
  return activityRuntime.runPromise(withTraceparentParent(effect, traceparent));
}

/**
 * One Dapr service-invocation POST from an activity to an agent, preserving the legacy
 * per-activity wire behaviour exactly: same URL, same JSON body, and the legacy error
 * text `${label} failed: ${status} ${text}` (carried in the DaprInvokeError's cause).
 *
 * `span: "client"` reproduces the legacy `withClientSpan` sites (setup/clone/worktree):
 * a CLIENT span named `invoke ${appId}/${method}` whose traceparent is injected into the
 * outgoing headers so the callee continues the trace. The activities that historically
 * made bare fetches (claude-managed, dapr-agent, dapr-claude-loop, langgraph) pass
 * `span: "none"` — no span, no injected headers, exactly as before.
 */
export function invokeAgentMethod(opts: {
  readonly label: string;
  readonly appId: string;
  readonly method: string;
  readonly body: unknown;
  readonly span: "client" | "none";
  /** "json" parses the response body; "ignore" leaves it unread (the legacy void invokes). */
  readonly parse: "json" | "ignore";
}): Effect.Effect<unknown, DaprInvokeError, HttpClient.HttpClient> {
  const { label, appId, method, body, span, parse } = opts;
  const effect = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const daprBase = `http://localhost:${process.env.DAPR_HTTP_PORT ?? "3500"}`;
    // Read the traceparent inside the span region so the header carries the CLIENT span.
    const headers = span === "client" ? yield* Effect.sync(() => injectTraceContext({})) : {};
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(`${daprBase}/v1.0/invoke/${appId}/method/${method}`).pipe(
        HttpClientRequest.setHeaders(headers),
      ),
      body,
    );
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text;
      return yield* new DaprInvokeError({
        cause: new Error(`${label} failed: ${response.status} ${text}`),
        appId,
        method,
      });
    }
    return parse === "json" ? yield* response.json : undefined;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DaprInvokeError ? cause : new DaprInvokeError({ cause, appId, method }),
    ),
  );
  return span === "client"
    ? effect.pipe(
        Effect.withSpan(`invoke ${appId}/${method}`, {
          kind: "client",
          attributes: { "dapr.app_id": appId, "dapr.method": method },
        }),
      )
    : effect;
}
