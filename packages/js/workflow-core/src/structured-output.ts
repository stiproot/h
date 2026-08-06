/**
 * Structured workflow outputs: the
 * validation boundary that makes an agent's output contract deterministic. A step whose input
 * carries an `outputContract` (a JSON-Schema subset) requires the agent's final output to end with
 * a fenced ```json block matching it; the run activity validates the block here and FAILS THE STEP
 * loud on absence or mismatch (D3 — the watcher's retry policy re-runs it). The validated value
 * enters the activity envelope as `structured`, the same trust level as any code-produced field.
 *
 * The schema dialect is a deliberately tiny subset — type / properties / required / items / enum /
 * const (+ title/description annotations) — and it is FAIL-CLOSED: a contract using any other
 * keyword is rejected outright rather than partially enforced, so a contract author can never
 * believe a constraint is checked when it is not. Pure and dependency-free (no ajv): the subset is
 * small enough that a validator we fully own beats a dialect we'd only partially surface.
 */

/** A structured-output contract violation — thrown by the run activities to fail the step. */
export class StructuredOutputError extends Error {
  override name = "StructuredOutputError";
}

/** The schema keywords the subset enforces (+ inert annotations). Anything else is rejected. */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "title",
  "description",
]);

const SUPPORTED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reject a contract that steps outside the supported subset (fail-closed). Returns the list of
 * problems — empty means the whole contract is enforceable.
 */
export function unsupportedContractKeywords(schema: unknown, path = "$"): string[] {
  if (!isRecord(schema)) return [`${path}: a contract schema must be a JSON object`];
  const problems: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) problems.push(`${path}: unsupported keyword '${key}'`);
  }
  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !SUPPORTED_TYPES.has(type)))
    problems.push(`${path}: unsupported type '${String(type)}'`);
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) problems.push(`${path}.properties: must be an object`);
    else
      for (const [name, sub] of Object.entries(schema.properties))
        problems.push(...unsupportedContractKeywords(sub, `${path}.${name}`));
  }
  if (schema.items !== undefined)
    problems.push(...unsupportedContractKeywords(schema.items, `${path}.items[]`));
  return problems;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    default:
      return typeOf(value) === type;
  }
};

/**
 * Validate a value against a (subset-checked) contract. Returns human-readable problems — empty
 * means valid. Extra keys beyond `properties` are allowed; every DECLARED constraint is enforced.
 */
export function contractViolations(value: unknown, schema: unknown, path = "$"): string[] {
  if (!isRecord(schema)) return [`${path}: invalid contract schema`];
  const problems: string[] = [];
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.some((option) => sameJson(option, value)))
      problems.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }
  if (schema.const !== undefined && !sameJson(schema.const, value))
    problems.push(
      `${path}: value ${JSON.stringify(value)} !== const ${JSON.stringify(schema.const)}`,
    );
  if (typeof schema.type === "string" && !matchesType(value, schema.type))
    problems.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
  if (Array.isArray(schema.required) && isRecord(value)) {
    for (const key of schema.required)
      if (typeof key === "string" && !(key in value))
        problems.push(`${path}: missing required '${key}'`);
  }
  if (isRecord(schema.properties) && isRecord(value)) {
    for (const [name, sub] of Object.entries(schema.properties))
      if (name in value) problems.push(...contractViolations(value[name], sub, `${path}.${name}`));
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((element, index) =>
      problems.push(...contractViolations(element, schema.items, `${path}[${index}]`)),
    );
  }
  return problems;
}

// The LAST fenced ```json block wins — the protocol rule (h-runtime.md) puts it at the very end,
// and an agent quoting an earlier example block must not shadow its actual answer.
//
// The CLOSING fence must sit at the start of its own line. An unanchored `...*?```' ends the block
// at the first backtick-fence ANYWHERE, including one INSIDE a JSON string value — so any contract
// whose field carries markdown with embedded code fences (a plan, a spec, a review quoting code)
// was truncated mid-string and failed as "not valid JSON: Unterminated string". A real newline
// cannot appear inside a valid JSON string (it must be escaped as \n), so requiring one before the
// fence is safe: it can only match a genuine block terminator.
const FENCED_JSON = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```(?=[ \t]*(?:\r?\n|$))/g;

/** Pull the raw text of the last fenced ```json block, or undefined when none exists. */
export function lastFencedJson(output: string): string | undefined {
  let raw: string | undefined;
  for (const match of output.matchAll(FENCED_JSON)) raw = match[1];
  return raw;
}

/**
 * Enforce a contract against an agent's raw output: last fenced block, parsed, subset-checked,
 * validated. Throws StructuredOutputError on any failure; returns the validated value.
 */
export function parseStructuredOutput(output: string, contract: unknown): unknown {
  const unsupported = unsupportedContractKeywords(contract);
  if (unsupported.length > 0)
    throw new StructuredOutputError(
      `output contract outside the supported subset (fail-closed): ${unsupported.join("; ")}`,
    );
  const raw = lastFencedJson(output);
  if (raw === undefined)
    throw new StructuredOutputError(
      "output contract declared but the agent output has no fenced ```json block",
    );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new StructuredOutputError(
      `fenced json block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const problems = contractViolations(value, contract);
  if (problems.length > 0)
    throw new StructuredOutputError(`output violates its contract: ${problems.join("; ")}`);
  return value;
}

/**
 * The run activities' seam: no contract → the result passes through untouched; with a contract the
 * validated block is attached as `structured` (or the step fails loud via StructuredOutputError).
 */
export function applyOutputContract<R extends { output: string }>(
  result: R,
  contract: unknown,
): R & { structured?: unknown } {
  if (contract === undefined || contract === null) return result;
  return { ...result, structured: parseStructuredOutput(result.output, contract) };
}
