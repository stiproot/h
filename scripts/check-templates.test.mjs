import assert from "node:assert/strict";
import test from "node:test";

import { declaredTemplateRole, hasCompleteTemplateGate } from "./check-templates.mjs";

const gate = '{{- if eq (.Values.template | default "") "implement" }}';

test("accepts a template whose complete body is gated", () => {
  assert.equal(hasCompleteTemplateGate(`{{- /* docs */ -}}\n${gate}\nkind: Workflow\n{{- end }}\n`, "implement"), true);
});

test("rejects ungated YAML followed by an empty matching gate", () => {
  assert.equal(hasCompleteTemplateGate(`kind: Workflow\n${gate}\n{{- end }}\n`, "implement"), false);
});

test("rejects an empty matching gate", () => {
  assert.equal(hasCompleteTemplateGate(`${gate}\n{{- end }}\n`, "implement"), false);
});

test("accepts a matching gate whose output is produced entirely by a Helm action", () => {
  assert.equal(
    hasCompleteTemplateGate(`${gate}\n{{ include "workflow.resource" . }}\n{{- end }}\n`, "implement"),
    true,
  );
});

test("does not treat a variable assignment as rendered gate content", () => {
  assert.equal(hasCompleteTemplateGate(`${gate}\n{{- $name := "implement" }}\n{{- end }}\n`, "implement"), false);
});

test("rejects a matching gate with no whitespace after the pipe", () => {
  const invalidGate = '{{- if eq (.Values.template |default "") "implement" }}';
  assert.equal(hasCompleteTemplateGate(`${invalidGate}\nkind: Workflow\n{{- end }}\n`, "implement"), false);
});

test("rejects an ungated document after a gated first document", () => {
  assert.equal(
    hasCompleteTemplateGate(`${gate}\nkind: Workflow\n{{- end }}\n---\nkind: ConfigMap\n`, "implement"),
    false,
  );
});

test("accepts balanced nested control blocks inside the gate", () => {
  assert.equal(
    hasCompleteTemplateGate(`${gate}\n{{- with .Values.implement }}\nkind: Workflow\n{{- end }}\n{{- end }}\n`, "implement"),
    true,
  );
});

test("rejects an unbalanced nested control block", () => {
  assert.equal(hasCompleteTemplateGate(`${gate}\n{{- with .Values.implement }}\nkind: Workflow\n{{- end }}\n`, "implement"), false);
});

test("accepts exactly one valid plain top-level role", () => {
  assert.equal(declaredTemplateRole("role: base\nsteps: []\n"), "base");
});

test("rejects missing, invalid, or duplicate roles", () => {
  assert.equal(declaredTemplateRole("steps: []\n"), null);
  assert.equal(declaredTemplateRole("role: fragment\n"), null);
  assert.equal(declaredTemplateRole("role: base\nrole: overlay\n"), null);
});
