import assert from "node:assert/strict";
import test from "node:test";

import { hasCompleteTemplateGate } from "./check-templates.mjs";

const gate = '{{- if eq (.Values.template | default "") "feature" }}';

test("accepts a template whose complete body is gated", () => {
  assert.equal(hasCompleteTemplateGate(`{{- /* docs */ -}}\n${gate}\nkind: Workflow\n{{- end }}\n`, "feature"), true);
});

test("rejects ungated YAML followed by an empty matching gate", () => {
  assert.equal(hasCompleteTemplateGate(`kind: Workflow\n${gate}\n{{- end }}\n`, "feature"), false);
});

test("rejects an ungated document after a gated first document", () => {
  assert.equal(
    hasCompleteTemplateGate(`${gate}\nkind: Workflow\n{{- end }}\n---\nkind: ConfigMap\n`, "feature"),
    false,
  );
});

test("accepts balanced nested control blocks inside the gate", () => {
  assert.equal(
    hasCompleteTemplateGate(`${gate}\n{{- with .Values.feature }}\nkind: Workflow\n{{- end }}\n{{- end }}\n`, "feature"),
    true,
  );
});

test("rejects an unbalanced nested control block", () => {
  assert.equal(hasCompleteTemplateGate(`${gate}\n{{- with .Values.feature }}\nkind: Workflow\n{{- end }}\n`, "feature"), false);
});
