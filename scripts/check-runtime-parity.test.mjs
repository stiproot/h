import assert from "node:assert/strict";
import { test } from "node:test";

import { findViolations, owned } from "./check-runtime-parity.mjs";

const ROOT = "/repo";
const outsider = `${ROOT}/apps/some-svc/src/domain/thing.ts`;

test("flags a second definition of an owned symbol", () => {
  const violations = findViolations(
    outsider,
    "export function resolveRefs(input, results) {\n  return input;\n}\n",
    ROOT,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /apps\/some-svc\/src\/domain\/thing\.ts:1: defines 'resolveRefs'/);
  assert.match(violations[0], /packages\/js\/workflow-core\/src owns/);
});

test("allows the owner to define its own symbols", () => {
  const inside = `${ROOT}/packages/js/workflow-core/src/resolve-refs.ts`;
  assert.deepEqual(findViolations(inside, "export function resolveRefs() {}", ROOT), []);
});

// A re-export has no second implementation, so it cannot drift — workflow.model.ts and
// agent-server both legitimately re-export what they no longer define.
test("allows re-exports", () => {
  const contents =
    'export { StepDefinition, WorkflowStep } from "workflow-core";\n' +
    'export type { AgentResult } from "workflow-core";\n';
  assert.deepEqual(findViolations(outsider, contents, ROOT), []);
});

// The regression this guard's own first run produced: an inline `type` inside a multi-line import
// read as a definition, flagging the files that were correctly importing the shared symbol.
test("does not mistake a multi-line import for a definition", () => {
  const contents = [
    "import {",
    "  type WorkflowStep,",
    "  type WorkflowParams,",
    "  deriveInstanceId,",
    '} from "./models/workflow.model.ts";',
    "",
    "export const x = 1;",
  ].join("\n");
  assert.deepEqual(findViolations(outsider, contents, ROOT), []);
});

test("catches every declaration form", () => {
  for (const line of [
    "export const applyOutputContract = () => {};",
    "class RunLedgerLive {}",
    "export type WorkflowParams = Record<string, unknown>;",
    "export interface StepDefinition { activity: string }",
  ]) {
    assert.equal(findViolations(outsider, line, ROOT).length, 1, line);
  }
});

test("a symbol whose name merely starts the same is not a match", () => {
  assert.deepEqual(
    findViolations(outsider, "export const resolveRefsFromCache = () => {};", ROOT),
    [],
  );
});

test("every owned concern names a real owner directory", () => {
  for (const { owner, symbols } of owned) {
    assert.match(owner, /^packages\/js\/[a-z-]+\/src$/);
    assert.ok(symbols.length > 0, `${owner} owns no symbols`);
  }
});
