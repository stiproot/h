import type { ChainWorkflowKind } from "./models/chain.model.ts";

/**
 * The engine-coded workflow port contracts — how each workflow KIND threads state through the chain's
 * blackboard (the row's `data`). This is the durable, machine-code home of what Phase 1 proved live
 * as the CLI's `CHAIN_TEMPLATES` closures (cli/h/src/h_cli/commands/chain.py): `buildParams(data)`
 * reads the blackboard for a workflow's fire-params, `capture(output, data)` parses the workflow's OUTPUT
 * markers back into it. Threading is engine code, never a config DSL (mirrors the watcher's ruling
 * W3), and it reads the workflow's output — NOT a chain actor — so the workflows it chains stay
 * chain-agnostic (params in, `===MARKER===` out) and runnable standalone.
 *
 * Pure and dependency-free (no Effect, no I/O): the scan (chain-scan.ts) calls these around the
 * invoker/store ports. A missing required input throws `ChainThreadError`, which the scan turns into
 * a failed-chain finalize with the message as the note.
 */

export type Blackboard = Record<string, unknown>;

export class ChainThreadError extends Error {}

export interface WorkflowContract {
  /** Blackboard → the workflow's fire-time params. Throws ChainThreadError if a required input is absent. */
  readonly buildParams: (data: Blackboard) => Record<string, unknown>;
  /** Parse the workflow's workflow output and write what it produced back into the blackboard (in place). */
  readonly capture: (output: string | undefined, data: Blackboard) => void;
}

/**
 * Pull each step's `output` text from a workflow's result. The generic workflow returns
 * JSON.stringify(results); Dapr serializes that again into the status `output`, so the value can
 * arrive DOUBLE-encoded (a JSON string whose content is itself a JSON string) — unwrap successive
 * string layers until a dict surfaces. (Phase 1 caught this live; the single-encoded mocks hid it.)
 */
export function stepOutputs(workflowOutput: string | undefined): string[] {
  let results: unknown = workflowOutput;
  for (let i = 0; i < 3; i++) {
    if (typeof results !== "string") break;
    try {
      results = JSON.parse(results);
    } catch {
      return [];
    }
  }
  if (typeof results !== "object" || results === null) return [];
  return Object.values(results as Record<string, unknown>)
    .filter((v): v is { output: string } => {
      return (
        typeof v === "object" &&
        v !== null &&
        typeof (v as { output?: unknown }).output === "string"
      );
    })
    .map((v) => v.output);
}

/** The text following `marker` in whichever step output carries it (trimmed), else undefined. */
export function afterMarker(
  workflowOutput: string | undefined,
  marker: string,
): string | undefined {
  for (const text of stepOutputs(workflowOutput)) {
    const idx = text.indexOf(marker);
    if (idx !== -1) return text.slice(idx + marker.length).trim();
  }
  return undefined;
}

/** Capture a `===PR===` marker into prUrl + prNumber (the number parsed from a /pull/<n> URL). */
export function capturePr(output: string | undefined, data: Blackboard): void {
  const tail = afterMarker(output, "===PR===");
  if (!tail) return;
  const url = (tail.split("\n")[0] ?? "").trim();
  data.prUrl = url;
  const match = url.match(/\/pull\/(\d+)/);
  if (match) data.prNumber = match[1];
}

/** Capture a `===REVIEW===` marker into reviewFindings (empty string when absent — a valid CLEAN run). */
export function captureReview(output: string | undefined, data: Blackboard): void {
  data.reviewFindings = afterMarker(output, "===REVIEW===") ?? "";
}

/**
 * The loop-until-clean predicate: is a review workflow's output CLEAN? The pr-review template ends
 * `===REVIEW===` then either the findings or `CLEAN`, so no marker, an empty tail, or a first line of
 * `CLEAN` (case-insensitive) all mean nothing left to address — the loop stops.
 */
export function reviewIsClean(output: string | undefined): boolean {
  const tail = afterMarker(output, "===REVIEW===");
  if (!tail) return true;
  return (tail.split("\n")[0] ?? "").trim().toUpperCase() === "CLEAN";
}

function requireStr(data: Blackboard, key: string, hint: string): string {
  const v = data[key];
  if (typeof v !== "string" || v === "") throw new ChainThreadError(hint);
  return v;
}

export const WORKFLOW_KINDS: Record<ChainWorkflowKind, WorkflowContract> = {
  // Implements the issue and opens/updates its PR. Reads the feature spec; captures the PR it opened.
  "feature-pr": {
    buildParams: (data) => {
      const params: Record<string, unknown> = {
        slug: requireStr(data, "slug", "feature-pr needs a slug on the blackboard"),
        spec: requireStr(data, "spec", "feature-pr needs a spec on the blackboard"),
      };
      if (typeof data.issueNumber === "string" && data.issueNumber)
        params.issueNumber = data.issueNumber;
      return params;
    },
    capture: capturePr,
  },
  // Reviews the PR the previous workflow opened; captures the review findings for a revise workflow.
  "pr-review": {
    buildParams: (data) => {
      const pr = data.prNumber;
      if (typeof pr !== "string" || pr === "") {
        throw new ChainThreadError(
          "pr-review needs a PR number, but the previous workflow produced none " +
            "(no ===PR=== marker in its output). Did the feature workflow open a PR?",
        );
      }
      return { pr };
    },
    capture: captureReview,
  },
  // Fires the standalone `revise` workflow, which reads the PR's UNRESOLVED review threads itself
  // (github MCP) and addresses them on the same branch; captures the updated PR. The chain threads
  // only durable REFERENCES — the PR number + slug — not the review text: revise reads the review
  // from GitHub, so the workflow stays self-sufficient and runnable standalone.
  revise: {
    buildParams: (data) => ({
      pr: requireStr(
        data,
        "prNumber",
        "revise needs a PR number on the blackboard (create-pr's ===PR===)",
      ),
      slug: requireStr(data, "slug", "revise needs a slug on the blackboard"),
    }),
    capture: capturePr,
  },
};
