import type { ChainHopKind } from "./models/chain.model.ts";

/**
 * The engine-coded hop port contracts — how each hop KIND threads state through the chain's
 * blackboard (the row's `data`). This is the durable, machine-code home of what Phase 1 proved live
 * as the CLI's `CHAIN_TEMPLATES` closures (cli/h/src/h_cli/commands/chain.py): `buildParams(data)`
 * reads the blackboard for a hop's fire-params, `capture(output, data)` parses the hop's OUTPUT
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

export interface HopContract {
  /** Blackboard → the hop's fire-time params. Throws ChainThreadError if a required input is absent. */
  readonly buildParams: (data: Blackboard) => Record<string, unknown>;
  /** Parse the hop's workflow output and write what it produced back into the blackboard (in place). */
  readonly capture: (output: string | undefined, data: Blackboard) => void;
}

// The revise hop re-fires feature-pr on the same branch; its spec tells the agent to address the
// review feedback. With the #20 epilogue, the agent fetches the unresolved threads itself, then
// replies inline and resolves them — so the spec just hands over the review summary as context.
const REVISE_SPEC_PREAMBLE =
  "Address the review feedback on the open pull request for this branch. Fetch the unresolved " +
  "review threads on the PR, implement each requested change, then (per the PR epilogue) reply " +
  "inline to each thread you addressed and resolve it. The review summary follows.\n\n" +
  "===REVIEW SUMMARY===\n";

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

function requireStr(data: Blackboard, key: string, hint: string): string {
  const v = data[key];
  if (typeof v !== "string" || v === "") throw new ChainThreadError(hint);
  return v;
}

export const HOP_KINDS: Record<ChainHopKind, HopContract> = {
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
  // Reviews the PR the previous hop opened; captures the review findings for a revise hop.
  "pr-review": {
    buildParams: (data) => {
      const pr = data.prNumber;
      if (typeof pr !== "string" || pr === "") {
        throw new ChainThreadError(
          "pr-review needs a PR number, but the previous hop produced none " +
            "(no ===PR=== marker in its output). Did the feature hop open a PR?",
        );
      }
      return { pr };
    },
    capture: captureReview,
  },
  // Re-fires feature-pr on the same branch to address the review; captures the updated PR.
  revise: {
    buildParams: (data) => {
      const findings = typeof data.reviewFindings === "string" ? data.reviewFindings : "";
      const params: Record<string, unknown> = {
        slug: requireStr(data, "slug", "revise needs a slug on the blackboard"),
        spec: REVISE_SPEC_PREAMBLE + (findings || "(no findings reported)"),
      };
      if (typeof data.issueNumber === "string" && data.issueNumber)
        params.issueNumber = data.issueNumber;
      return params;
    },
    capture: capturePr,
  },
};
