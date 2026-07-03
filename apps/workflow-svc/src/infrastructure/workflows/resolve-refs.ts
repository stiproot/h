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

function resolveValue(value: unknown, results: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path) =>
      String(lookup(path.trim(), results) ?? ""),
    );
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
