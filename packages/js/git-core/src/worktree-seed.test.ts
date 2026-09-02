import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SeedPathError, safeSeedPath, seedWorktree } from "./worktree-seed.ts";

describe("seedWorktree", () => {
  let root: string;
  let clone: string;
  let worktree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "h-seed-"));
    clone = join(root, "clone");
    worktree = join(root, "worktree");
    mkdirSync(join(clone, "apps", "svc"), { recursive: true });
    mkdirSync(join(worktree, "apps", "svc"), { recursive: true });
    writeFileSync(join(clone, "apps", "svc", ".env"), "SECRET=1\n");
    writeFileSync(join(clone, ".env"), "ROOT=1\n");
    mkdirSync(join(clone, "config", "local"), { recursive: true });
    writeFileSync(join(clone, "config", "local", "a.json"), "{}");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies absent files and directories, keeps present ones, reports missing ones", async () => {
    writeFileSync(join(worktree, ".env"), "ROOT=edited\n");
    const report = await Effect.runPromise(
      seedWorktree({
        repoPath: clone,
        worktreePath: worktree,
        paths: ["apps/svc/.env", ".env", "config/local", "apps/other/.env"],
      }),
    );
    expect(report).toEqual({
      copied: ["apps/svc/.env", "config/local"],
      kept: [".env"],
      missing: ["apps/other/.env"],
    });
    expect(readFileSync(join(worktree, "apps", "svc", ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("ROOT=edited\n"); // never clobbered
    expect(existsSync(join(worktree, "config", "local", "a.json"))).toBe(true);
  });

  it("is idempotent: a second pass keeps everything the first copied", async () => {
    const run = () =>
      Effect.runPromise(
        seedWorktree({ repoPath: clone, worktreePath: worktree, paths: ["apps/svc/.env"] }),
      );
    expect((await run()).copied).toEqual(["apps/svc/.env"]);
    expect(await run()).toEqual({ copied: [], kept: ["apps/svc/.env"], missing: [] });
  });

  it("refuses an escaping path before copying anything", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        seedWorktree({
          repoPath: clone,
          worktreePath: worktree,
          paths: ["apps/svc/.env", "../outside"],
        }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(SeedPathError);
    expect(existsSync(join(worktree, "apps", "svc", ".env"))).toBe(false);
  });

  it.each([
    ["", undefined],
    [".", undefined],
    ["..", undefined],
    ["../x", undefined],
    ["a/../../x", undefined],
    ["/etc/passwd", undefined],
    ["a/../b", "b"],
    ["apps/svc/.env", "apps/svc/.env"],
  ])("safeSeedPath(%j) → %j", (path, expected) => {
    expect(safeSeedPath(path)).toBe(expected);
  });
});
