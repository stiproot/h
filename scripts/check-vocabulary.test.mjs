import assert from "node:assert/strict";
import test from "node:test";
import { findViolations } from "./check-vocabulary.mjs";

const retiredForms = [
  "hop",
  "hops",
  "family",
  "families",
  "blackboard",
  "blackboards",
  "chain workflow",
  "chain workflows",
];

test("reports every singular and plural retired term with its location", () => {
  const contents = retiredForms.join("\n");
  const violations = findViolations("/repo/fixture.md", contents, "/repo");

  assert.equal(violations.length, retiredForms.length);
  for (const [index, form] of retiredForms.entries()) {
    assert.match(violations[index], new RegExp(`^fixture\\.md:${index + 1}:1:`));
    assert.match(violations[index], new RegExp(`replace “${form}”`));
  }
});

test("reports repeated retired terms as separate violations", () => {
  const violations = findViolations(
    "/repo/fixture.md",
    "hop hop\nfamily family",
    "/repo",
  );

  assert.equal(violations.length, 4);
  assert.match(violations[0], /^fixture\.md:1:1:/);
  assert.match(violations[1], /^fixture\.md:1:5:/);
  assert.match(violations[2], /^fixture\.md:2:1:/);
  assert.match(violations[3], /^fixture\.md:2:8:/);
});
