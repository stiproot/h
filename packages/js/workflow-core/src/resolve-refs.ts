// Resolves cross-step references in a workflow step's input against the accumulated step results.
// Two forms are supported: a `{{stepId.field.path}}` placeholder inside a string, and a
// `{ "$ref": "stepId.field.path" }` object (which is replaced by the looked-up value, of any type).
// Resolution recurses into nested arrays and objects, so a reference is resolved wherever it appears
// — e.g. inside a setup command (`setup[].cmd`), not only at the top level of the input.

function lookup(path: string, results: Record<string, unknown>): unknown {
  let val: unknown = results;
  for (const part of path.split(".")) val = (val as Record<string, unknown>)?.[part];
  return val;
}

// A token inside a STRING has to become text. A scalar is itself; an object or array is its JSON —
// `String({})` is "[object Object]", which made every object-valued result (a step's validated
// `structured` block above all) unreachable from a task string. Found 2026-09-02: the create-pr
// step could not carry the implement step's baseline/final evidence into the PR body, so the body
// omitted what the ledger held and the driver repaired it by hand.
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

function resolveValue(value: unknown, results: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => stringify(lookup(path.trim(), results)));
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, results));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("$ref" in obj) return lookup((obj as { $ref: string }).$ref, results);
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveValue(v, results)]));
  }
  return value;
}

export function resolveRefs(
  input: Record<string, unknown>,
  results: Record<string, unknown>,
): Record<string, unknown> {
  return resolveValue(input, results) as Record<string, unknown>;
}

/**
 * Resolves {{token}} placeholders in ONE string — the activity-name case (fire-time identity:
 * a step's `activity` may be `"{{params.runActivity}}"` — fire-time identity,
 * §1.9). Unlike step-input resolution, an unresolvable token here must fail LOUD: an activity
 * name that silently collapses to "" would surface as a cryptic registry miss.
 */
export function resolveTokenString(value: string, results: Record<string, unknown>): string {
  if (!value.includes("{{")) return value;
  return value.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const resolved = lookup(path.trim(), results);
    if (resolved === undefined || resolved === null || resolved === "") {
      throw new Error(
        `unresolved token {{${path.trim()}}} in '${value}' — is the param set (or a default published)?`,
      );
    }
    return String(resolved);
  });
}
