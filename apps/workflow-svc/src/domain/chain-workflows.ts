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

/**
 * Sibling of stepOutputs for STRUCTURED outputs (docs/plans/structured-workflow-outputs.md): merge
 * each step envelope's validated `structured` value, in step order (later steps win — mirroring
 * "the last fenced block wins" one level up). Undefined when no step carried one, which is how the
 * engine tells a marker-era run from a declaring one.
 */
export function stepStructured(
  workflowOutput: string | undefined,
): Record<string, unknown> | undefined {
  let results: unknown = workflowOutput;
  for (let i = 0; i < 3; i++) {
    if (typeof results !== "string") break;
    try {
      results = JSON.parse(results);
    } catch {
      return undefined;
    }
  }
  if (typeof results !== "object" || results === null) return undefined;
  let merged: Record<string, unknown> | undefined;
  for (const step of Object.values(results as Record<string, unknown>)) {
    const structured = (step as { structured?: unknown } | null)?.structured;
    if (typeof structured === "object" && structured !== null && !Array.isArray(structured))
      merged = { ...merged, ...(structured as Record<string, unknown>) };
  }
  return merged;
}

/** Walk a dot-path ("pr" or "review.verdict") into a structured value; undefined when any hop misses. */
function structuredField(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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

/**
 * Capture the PR a run produced: STRUCTURED-FIRST (D1 — a declaring workflow's validated block is
 * authoritative), falling back to the `===PR===` marker for non-declaring runs. Structured shape:
 * `pr` (number) + `url`, or `skipped` when no PR exists — a skip sets nothing, so the next
 * workflow's buildParams fails loud exactly like the marker-era SKIPPED tail.
 */
export function capturePr(output: string | undefined, data: Blackboard): void {
  const s = stepStructured(output);
  if (s && ("pr" in s || "url" in s || "skipped" in s)) {
    if (s.pr !== undefined && s.pr !== null) data.prNumber = String(s.pr);
    if (typeof s.url === "string" && s.url) data.prUrl = s.url;
    return;
  }
  const tail = afterMarker(output, "===PR===");
  if (!tail) return;
  const url = (tail.split("\n")[0] ?? "").trim();
  data.prUrl = url;
  const match = url.match(/\/pull\/(\d+)/);
  if (match) data.prNumber = match[1];
}

/**
 * Capture a review's findings: STRUCTURED-FIRST (`verdict` + `summary`; CLEAN ⇒ empty findings),
 * falling back to the `===REVIEW===` marker (empty string when absent — a valid CLEAN run).
 */
export function captureReview(output: string | undefined, data: Blackboard): void {
  const s = stepStructured(output);
  if (s && typeof s.verdict === "string") {
    data.reviewFindings = s.verdict === "CLEAN" ? "" : String(s.summary ?? "");
    return;
  }
  data.reviewFindings = afterMarker(output, "===REVIEW===") ?? "";
}

/**
 * The loop-until-clean predicate: is a review workflow's output CLEAN? The pr-review template ends
 * `===REVIEW===` then either the findings or `CLEAN`, so no marker, an empty tail, or a first line of
 * `CLEAN` (case-insensitive) all mean nothing left to address — the loop stops.
 */
export function reviewIsClean(output: string | undefined): boolean {
  // Structured-first (D1): a declaring review's validated verdict is authoritative.
  const s = stepStructured(output);
  if (s && typeof s.verdict === "string") return s.verdict === "CLEAN";
  const tail = afterMarker(output, "===REVIEW===");
  if (!tail) return true;
  return (tail.split("\n")[0] ?? "").trim().toUpperCase() === "CLEAN";
}

function requireStr(data: Blackboard, key: string, hint: string): string {
  const v = data[key];
  if (typeof v !== "string" || v === "") throw new ChainThreadError(hint);
  return v;
}

/**
 * Thread the chain-level target repo (owner/name) into a member's params when present — it is the
 * wf-identity segment for every member AND pr-review's review target. Opt-in: an absent repo leaves
 * the params unchanged (seeded chain-level via `-p repo=owner/name`, which lands in the blackboard).
 */
function withRepo(params: Record<string, unknown>, data: Blackboard): Record<string, unknown> {
  return typeof data.repo === "string" && data.repo ? { ...params, repo: data.repo } : params;
}

/** The declarative slice of a chain member the generic contract reads (chain.model's fields). */
export type MemberMappings = {
  readonly kind: ChainWorkflowKind;
  readonly captures?: Readonly<Record<string, string>>;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly until?: { readonly path: string; readonly equals: string };
};

/**
 * The effective contract for a chain member: a declared mapping replaces its HALF of the kind's
 * coded contract (captures → capture, inputs → buildParams), so structured threading is the default
 * exactly where a member declares it and the marker kinds remain the fallback (D1). Fail-loud
 * mirrors requireStr: a missing structured envelope or mapped field is a ChainThreadError, which
 * the scan turns into a failed-chain finalize — never fire-on-a-guess.
 */
export function contractFor(member: MemberMappings): WorkflowContract {
  const kind = WORKFLOW_KINDS[member.kind];
  const captures = member.captures;
  const inputs = member.inputs;
  return {
    capture: !captures
      ? kind.capture
      : (output, data) => {
          const structured = stepStructured(output);
          if (!structured)
            throw new ChainThreadError(
              `'${member.kind}' declares captures but the completed workflow emitted no ` +
                "structured output — does its template carry the outputContract step input?",
            );
          for (const [bbKey, field] of Object.entries(captures)) {
            const value = structuredField(structured, field);
            if (value === undefined || value === null)
              throw new ChainThreadError(
                `structured output has no field '${field}' (capture → ${bbKey})`,
              );
            data[bbKey] = value;
          }
        },
    buildParams: !inputs
      ? kind.buildParams
      : (data) => {
          const params: Record<string, unknown> = {};
          for (const [param, bbKey] of Object.entries(inputs)) {
            const value = data[bbKey];
            if (value === undefined || value === null || value === "")
              throw new ChainThreadError(
                `'${member.kind}' needs '${bbKey}' on the blackboard (input → ${param})`,
              );
            params[param] = value;
          }
          return withRepo(params, data);
        },
  };
}

/**
 * The loop-until-clean stop check for the loop-start member: a declared `until` evaluates against
 * the structured output (absent structured/field ⇒ NOT satisfied — the iteration budget is the
 * backstop); undeclared falls back to the coded reviewIsClean marker sniff.
 */
export function loopIsClean(member: MemberMappings, workflowOutput: string | undefined): boolean {
  if (!member.until) return reviewIsClean(workflowOutput);
  const structured = stepStructured(workflowOutput);
  const value = structured ? structuredField(structured, member.until.path) : undefined;
  if (value === undefined || value === null) return false;
  return String(value) === member.until.equals;
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
      return withRepo(params, data);
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
      return withRepo({ pr }, data);
    },
    capture: captureReview,
  },
  // Fires the standalone `revise` workflow, which reads the PR's UNRESOLVED review threads itself
  // (github MCP) and addresses them on the same branch; captures the updated PR. The chain threads
  // only durable REFERENCES — the PR number + slug — not the review text: revise reads the review
  // from GitHub, so the workflow stays self-sufficient and runnable standalone.
  revise: {
    buildParams: (data) =>
      withRepo(
        {
          pr: requireStr(
            data,
            "prNumber",
            "revise needs a PR number on the blackboard (create-pr's ===PR===)",
          ),
          slug: requireStr(data, "slug", "revise needs a slug on the blackboard"),
        },
        data,
      ),
    capture: capturePr,
  },
};
