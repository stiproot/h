import { describe, expect, it } from "vitest";

import { resolveRefs } from "./resolve-refs.ts";

const results = {
  worktree: { worktreePath: "/workspace/worktrees/run-1" },
  diagnose: { output: "the diagnosis" },
};

describe("resolveRefs", () => {
  it("resolves a {{ref}} in a top-level string", () => {
    expect(resolveRefs({ cwd: "{{worktree.worktreePath}}" }, results)).toEqual({
      cwd: "/workspace/worktrees/run-1",
    });
  });

  it("resolves a {{ref}} nested inside an array (the setup[].cmd case)", () => {
    const input = { setup: [{ cmd: "cd {{worktree.worktreePath}} && tessl install" }] };
    expect(resolveRefs(input, results)).toEqual({
      setup: [{ cmd: "cd /workspace/worktrees/run-1 && tessl install" }],
    });
  });

  it("resolves a {{ref}} nested inside an object", () => {
    const input = { input: { task: "fix it:\n{{diagnose.output}}" } };
    expect(resolveRefs(input, results)).toEqual({ input: { task: "fix it:\nthe diagnosis" } });
  });

  it("replaces a $ref object with the looked-up value (any type), top-level or nested", () => {
    const input = { a: { $ref: "worktree" }, nested: [{ b: { $ref: "worktree.worktreePath" } }] };
    expect(resolveRefs(input, results)).toEqual({
      a: { worktreePath: "/workspace/worktrees/run-1" },
      nested: [{ b: "/workspace/worktrees/run-1" }],
    });
  });

  it("substitutes a missing ref with an empty string and leaves plain strings untouched", () => {
    expect(resolveRefs({ a: "{{nope.gone}}", b: "literal" }, results)).toEqual({
      a: "",
      b: "literal",
    });
  });

  // The params contract: the generic workflow seeds named params into the results map under the
  // reserved id `params`, so they resolve exactly like step results.
  it("resolves {{params.x}} and $ref params when seeded into results", () => {
    const withParams = { ...results, params: { spec: "# Fix lint", slug: "ci-lint-fix" } };
    const input = {
      task: "Branch feature/{{params.slug}}:\n{{params.spec}}",
      whole: { $ref: "params" },
    };
    expect(resolveRefs(input, withParams)).toEqual({
      task: "Branch feature/ci-lint-fix:\n# Fix lint",
      whole: { spec: "# Fix lint", slug: "ci-lint-fix" },
    });
  });
});
