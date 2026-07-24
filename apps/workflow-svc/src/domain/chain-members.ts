import type { ChainMemberKind } from "./models/chain.model.ts";

/**
 * The engine-coded workflow port contracts — how each workflow KIND threads state through the chain's
 * chain data (the row's `data`). This is the durable, machine-code home of what Phase 1 proved live
 * as the CLI's `CHAIN_TEMPLATES` closures (cli/h/src/h_cli/commands/chain.py): `buildParams(data)`
 * reads the chain data for a workflow's fire-params, `capture(output, data)` reads the workflow's
 * validated STRUCTURED output back into it (docs/plans/structured-workflow-outputs.md — the marker
 * parsing this file once did was retired 2026-07-15; every chained template declares an outputs
 * contract). Threading is engine code, never a config DSL (mirrors the watcher's ruling W3), and it
 * reads the workflow's output — NOT a chain actor — so the workflows it chains stay chain-agnostic
 * (params in, declared structured output out) and runnable standalone.
 *
 * Pure and dependency-free (no Effect, no I/O): the scan (chain-scan.ts) calls these around the
 * invoker/store ports. A missing required input throws `ChainThreadError`, which the scan turns into
 * a failed-chain finalize with the message as the note.
 */

export type ChainData = Record<string, unknown>;

export class ChainThreadError extends Error {}

export interface WorkflowContract {
  /** ChainData → the workflow's fire-time params. Throws ChainThreadError if a required input is absent. */
  readonly buildParams: (data: ChainData) => Record<string, unknown>;
  /** Parse the workflow's workflow output and write what it produced back into the chain data (in place). */
  readonly capture: (output: string | undefined, data: ChainData) => void;
}

/**
 * Merge each step envelope's validated `structured` value from a workflow's result, in step order
 * (later steps win — mirroring "the last fenced block wins" one level up). The generic workflow
 * returns JSON.stringify(results); Dapr serializes that again into the status `output`, so the
 * value can arrive DOUBLE-encoded — unwrap successive string layers until a dict surfaces (Phase 1
 * caught this live; single-encoded mocks hid it). Undefined when no step carried a structured
 * value — a run whose template declares no outputs contract.
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

/** Walk a dot-path ("pr" or "review.verdict") into a structured value; undefined when any step misses. */
function structuredField(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** No structured output at all means the chained workflow's template declares no contract — a
 * misconfigured chain, never a silent no-op. */
function requireStructured(output: string | undefined, what: string): Record<string, unknown> {
  const structured = stepStructured(output);
  if (!structured)
    throw new ChainThreadError(
      `${what}: the completed workflow emitted no structured output — its template must declare ` +
        "an outputs contract (docs/plans/structured-workflow-outputs.md)",
    );
  return structured;
}

/**
 * Capture the PR a run produced from its validated structured output: `pr` (number) + `url`, or
 * `skipped` when no PR exists. A skip sets nothing, so the next workflow's buildParams fails loud
 * with its own hint — a chain must never fire a review of a PR that was never opened.
 */
export function capturePr(output: string | undefined, data: ChainData): void {
  const s = requireStructured(output, "capturePr");
  if (s.pr !== undefined && s.pr !== null) data.prNumber = String(s.pr);
  if (typeof s.url === "string" && s.url) data.prUrl = s.url;
}

/**
 * Capture a review's findings from its validated structured output: `verdict` + `summary`
 * (CLEAN ⇒ empty findings). A missing verdict is a broken review contract — fail loud.
 */
export function captureReview(output: string | undefined, data: ChainData): void {
  const s = requireStructured(output, "captureReview");
  if (typeof s.verdict !== "string")
    throw new ChainThreadError("captureReview: structured output has no 'verdict'");
  data.reviewFindings = s.verdict === "CLEAN" ? "" : String(s.summary ?? "");
}

/**
 * Capture an `answer` member's conclusion from its validated structured output: `answer` (the
 * conclusive answer to the task — for a panelized run, the judge's merged synthesis). A downstream
 * member threads `answer` in as its spec. `disagreements` (panel runs) stays reachable via an
 * explicit `--capture`. This flat write is the lone-member default; a PARALLEL answer member (two
 * panels in one stage) declares explicit `captures` + an `id`, which namespaces them under `data[id]`
 * so concurrent members never clobber this flat `answer`. A missing answer is a broken contract —
 * fail loud, never fire the next member on a guess.
 */
export function captureAnswer(output: string | undefined, data: ChainData): void {
  const s = requireStructured(output, "captureAnswer");
  if (typeof s.answer !== "string" || s.answer === "")
    throw new ChainThreadError("captureAnswer: structured output has no 'answer'");
  data.answer = s.answer;
}

/**
 * The loop-until-clean predicate: is a review workflow's validated verdict CLEAN? Anything else —
 * FINDINGS, a missing verdict, no structured output — is NOT clean, and the iteration budget is
 * the backstop. (The marker era treated an ABSENT ===REVIEW=== as clean; with a declared contract
 * the verdict is required, so absence now means something is wrong and must never stop a loop
 * as if the review passed.)
 */
export function reviewIsClean(output: string | undefined): boolean {
  return stepStructured(output)?.verdict === "CLEAN";
}

function requireStr(data: ChainData, key: string, hint: string): string {
  const v = data[key];
  if (typeof v !== "string" || v === "") throw new ChainThreadError(hint);
  return v;
}

/**
 * Thread the chain-level target repo (owner/name) into a member's params when present — it is the
 * wf-identity segment for every member AND pr-review's review target. Opt-in: an absent repo leaves
 * the params unchanged (seeded chain-level via `-p repo=owner/name`, which lands in the chain data).
 */
function withRepo(params: Record<string, unknown>, data: ChainData): Record<string, unknown> {
  return typeof data.repo === "string" && data.repo ? { ...params, repo: data.repo } : params;
}

/** The declarative slice of a chain member the generic contract reads (chain.model's fields). */
export type MemberMappings = {
  readonly kind: ChainMemberKind;
  /** The member's chain data namespace (D5): declared captures write under `data[id]` when present. */
  readonly id?: string;
  readonly captures?: Readonly<Record<string, string>>;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly until?: { readonly path: string; readonly equals: string };
};

/**
 * The sub-object a member's declared captures write into (D5, namespace-implicit): `data[id]`,
 * created as a plain object on first write. Reuses `structuredField`'s walk on the read side, so a
 * downstream member's dotted input `id.field` resolves against exactly what was written here.
 */
function namespaceFor(data: ChainData, id: string): Record<string, unknown> {
  const existing = data[id];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing))
    return existing as Record<string, unknown>;
  const ns: Record<string, unknown> = {};
  data[id] = ns;
  return ns;
}

/**
 * The effective contract for a chain member: a declared mapping replaces its HALF of the kind's
 * coded contract (captures → capture, inputs → buildParams), so explicit mappings compose novel
 * chains; the kind presets thread the well-known shapes. Fail-loud
 * mirrors requireStr: a missing structured envelope or mapped field is a ChainThreadError, which
 * the scan turns into a failed-chain finalize — never fire-on-a-guess.
 */
export function contractFor(member: MemberMappings): WorkflowContract {
  const kind = MEMBER_KINDS[member.kind];
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
          // Namespace-implicit (D5): a member with an `id` writes under its own namespace `data[id]`,
          // so concurrent members of a stage never clobber; without an id it threads flat (the
          // degenerate one-member-per-stage case). A dotted `inputs` path (`id.field`) reads it back.
          const target = member.id ? namespaceFor(data, member.id) : data;
          for (const [bbKey, field] of Object.entries(captures)) {
            const value = structuredField(structured, field);
            if (value === undefined || value === null)
              throw new ChainThreadError(
                `structured output has no field '${field}' (capture → ${bbKey})`,
              );
            target[bbKey] = value;
          }
        },
    buildParams: !inputs
      ? kind.buildParams
      : (data) => {
          const params: Record<string, unknown> = {};
          for (const [param, path] of Object.entries(inputs)) {
            // Namespace-explicit (D5): the input value is a dot-PATH into the two-level chain data —
            // `id.field` reads a member's namespaced capture, a plain key reads a flat top-level value
            // (a chain seed like slug/spec/repo, or a coded contract's flat write). Consistent with
            // `until`'s `path`. A no-dot key is a one-step walk, i.e. the pre-D5 flat read.
            const value = structuredField(data, path);
            if (value === undefined || value === null || value === "")
              throw new ChainThreadError(
                `'${member.kind}' needs '${path}' on the chain data (input → ${param})`,
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
 * backstop); undeclared falls back to the coded reviewIsClean verdict check.
 */
export function loopIsClean(member: MemberMappings, workflowOutput: string | undefined): boolean {
  if (!member.until) return reviewIsClean(workflowOutput);
  const structured = stepStructured(workflowOutput);
  const value = structured ? structuredField(structured, member.until.path) : undefined;
  if (value === undefined || value === null) return false;
  return String(value) === member.until.equals;
}

export const MEMBER_KINDS: Record<ChainMemberKind, WorkflowContract> = {
  // Implements the issue and opens/updates its PR. Reads the feature spec; captures the PR it opened.
  "feature-pr": {
    buildParams: (data) => {
      const params: Record<string, unknown> = {
        slug: requireStr(data, "slug", "feature-pr needs a slug on the chain data"),
        spec: requireStr(data, "spec", "feature-pr needs a spec on the chain data"),
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
            "(no `pr` in its structured output — was the PR skipped?). Did the feature workflow open a PR?",
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
            "revise needs a PR number on the chain data (create-pr's structured `pr`)",
          ),
          slug: requireStr(data, "slug", "revise needs a slug on the chain data"),
        },
        data,
      ),
    capture: capturePr,
  },
  // A bare "answer this task" member (templates/answer.yaml) — the panelizable degenerate case
  // (docs/plans/panels-as-a-modifier.md): identity is ordinary fire-time params, and an --agent
  // ROSTER turns the one answer step into a multi-agent panel (parallel panelists + a judge
  // synthesis under this same contract) — the retired hand-built `agent-panel` template/kind,
  // subsumed 2026-07-24. Reads a `task` from the chain data; captures the structured `answer` so
  // a downstream member can consume it (e.g. as its spec). Two answer members in one stage
  // override this coded contract with explicit `--input task=…` + namespaced `--capture`.
  answer: {
    buildParams: (data) => ({
      task: requireStr(data, "task", "answer needs a task on the chain data"),
    }),
    capture: captureAnswer,
  },
};
