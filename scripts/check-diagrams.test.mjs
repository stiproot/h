import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSet, indexedNames, KINDS } from "./check-diagrams.mjs";

const wellFormed = ["```mermaid", "sequenceDiagram", "```", "", "## Reading notes", "- a note"].join(
  "\n",
);
const index = "| [a-sequence](./a-sequence.md) | sequence | models a thing |";

const read = (overrides = {}) => (name) => overrides[name] ?? wellFormed;

test("a registered, well-formed diagram passes", () => {
  assert.deepEqual(checkSet(["a-sequence.md"], index, read()), []);
});

// An unregistered diagram is invisible: nobody reads a file they cannot reach from the index.
test("flags a diagram missing from the index", () => {
  const problems = checkSet(["a-sequence.md", "b-sequence.md"], index, read());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b-sequence\.md: not registered/);
});

test("flags an index row pointing at nothing", () => {
  const problems = checkSet([], index, read());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /links '\.\/a-sequence\.md', which does not exist/);
});

test("flags a name whose kind is not in the vocabulary", () => {
  const problems = checkSet(["a-doodle.md"], "[x](./a-doodle.md)", read({ "a-doodle.md": wellFormed }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must end with a kind/);
});

// One diagram = one story; two fences in a file means the story was never narrowed.
test("flags a doc with more than one mermaid fence", () => {
  const two = `${wellFormed}\n\n\`\`\`mermaid\nflowchart LR\n\`\`\`\n`;
  const problems = checkSet(["a-sequence.md"], index, read({ "a-sequence.md": two }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has 2 mermaid fences/);
});

test("flags a doc with no reading notes", () => {
  const bare = "```mermaid\nsequenceDiagram\n```";
  const problems = checkSet(["a-sequence.md"], index, read({ "a-sequence.md": bare }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no '## Reading notes' section/);
});

// A hand-drawn class diagram is permanently out of step with the AST it claims to model.
test("flags a -class doc with no generator manifest", () => {
  const problems = checkSet(["a-class.md"], "[x](./a-class.md)", read({ "a-class.md": wellFormed }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GENERATED from the AST/);
});

test("accepts a -class doc carrying its manifest", () => {
  const generated = `<!-- gen:c4-code {} -->\n${wellFormed}`;
  assert.deepEqual(
    checkSet(["a-class.md"], "[x](./a-class.md)", read({ "a-class.md": generated })),
    [],
  );
});

test("indexedNames reads every ./<name>.md link in the table", () => {
  const names = indexedNames("[a](./a-sequence.md) and [b](./b-c4-container.md), also [x](../out.md)");
  assert.deepEqual([...names].sort(), ["a-sequence.md", "b-c4-container.md"]);
});

test("the kind vocabulary stays closed and non-empty", () => {
  assert.ok(KINDS.includes("sequence") && KINDS.includes("class"));
  assert.equal(new Set(KINDS).size, KINDS.length);
});
