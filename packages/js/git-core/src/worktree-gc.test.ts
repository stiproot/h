import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecGitClient, GitClient } from "./git-client.ts";
import { gcDecision, parseDirt, parseWorktrees } from "./worktree-gc.ts";

// The shared safety contract — see the fixture's own `_why`. The operator command (`h worktrees`,
// Python) reads the SAME file, so the two implementations can differ in every way except what
// they would delete. Path is asserted by scripts/check-sweep-parity.mjs.
const PARITY_FIXTURE = "../../../../scripts/fixtures/worktree-classification.json";

describe("sweep-rule parity with the operator command", () => {
  const fixture = JSON.parse(readFileSync(new URL(PARITY_FIXTURE, import.meta.url), "utf8")) as {
    cases: Array<{
      name: string;
      porcelain: string;
      unpushed: boolean;
      tracked: boolean;
      untracked: string[];
      collectable: boolean;
      collectableWithPrune: boolean;
    }>;
  };

  // Age is the collector's own concern and has no counterpart in the attended command, so it is
  // neutralised here: every case is old enough, and none is a named live workspace.
  const collectable = (dirt: ReturnType<typeof parseDirt>, unpushed: boolean, prune: boolean) =>
    gcDecision({
      ageMs: 1,
      minAgeMs: 0,
      dirt,
      unpushed,
      pruneUntracked: prune,
      kept: false,
    }) === undefined;

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const dirt = parseDirt(testCase.porcelain);
      expect(dirt.tracked).toBe(testCase.tracked);
      expect(dirt.untracked).toEqual(testCase.untracked);
      expect(collectable(dirt, testCase.unpushed, false)).toBe(testCase.collectable);
      expect(collectable(dirt, testCase.unpushed, true)).toBe(testCase.collectableWithPrune);
    });
  }
});

// The pure halves first: parsing and the decision. Everything the collector is ALLOWED to destroy
// is decided here, so these are the tests that matter most.
describe("gc classification (pure)", () => {
  it("splits porcelain into scratch and tracked work", () => {
    const dirt = parseDirt(" M src/a.ts\n?? plan.md\nA  src/new.ts\n?? notes/scratch.txt\n");
    expect(dirt.tracked).toBe(true);
    expect(dirt.untracked).toEqual(["plan.md", "notes/scratch.txt"]);
  });

  it("reads an untracked-only tree as scratch, not as tracked work", () => {
    expect(parseDirt("?? plan.md\n")).toEqual({ tracked: false, untracked: ["plan.md"] });
  });

  it("skips the FIRST porcelain block — the main working tree is never collectable", () => {
    const porcelain = [
      "worktree /ws/repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /ws/worktrees/feature-x",
      "HEAD def",
      "branch refs/heads/feature/x",
      "",
    ].join("\n");
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/ws/worktrees/feature-x", branch: "feature/x" },
    ]);
  });

  const base = {
    ageMs: 48 * 3600_000,
    minAgeMs: 24 * 3600_000,
    dirt: { tracked: false, untracked: [] as string[] },
    unpushed: false,
    pruneUntracked: false,
    kept: false,
  };

  it("collects an old, clean, pushed worktree", () => {
    expect(gcDecision(base)).toBeUndefined();
  });

  it("keeps tracked edits and unpushed commits regardless of pruneUntracked", () => {
    expect(
      gcDecision({ ...base, dirt: { tracked: true, untracked: [] }, pruneUntracked: true }),
    ).toBe("uncommitted changes");
    expect(gcDecision({ ...base, unpushed: true, pruneUntracked: true })).toBe("unpushed commits");
  });

  it("keeps scratch by default and collects it only when asked", () => {
    const scratch = { ...base, dirt: { tracked: false, untracked: ["plan.md"] } };
    expect(gcDecision(scratch)).toBe("1 untracked file(s)");
    expect(gcDecision({ ...scratch, pruneUntracked: true })).toBeUndefined();
  });

  it("keeps anything younger than the threshold, and anything named live", () => {
    expect(gcDecision({ ...base, ageMs: 60_000 })).toContain("younger than");
    expect(gcDecision({ ...base, kept: true })).toBe("live workspace");
  });

  it("checks liveness BEFORE age, so a live workspace is never reported as merely young", () => {
    // Both apply; the reason an operator reads must be the one that would still hold tomorrow.
    expect(gcDecision({ ...base, ageMs: 60_000, kept: true })).toBe("live workspace");
  });
});

// Then the real thing, against real git.
describe("gcWorktrees (ExecGitClient layer)", () => {
  const TestLayer = ExecGitClient.pipe(Layer.provide(NodeContext.layer));
  const run = <A, E>(effect: Effect.Effect<A, E, GitClient>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

  let root: string;
  let origin: string;
  let repo: string;
  let worktrees: string;

  const OLD = new Date(Date.now() - 72 * 3600_000);

  /**
   * Push a worktree's mtime past the age threshold. Called AFTER any mutation, because writing a
   * file at a worktree's top level moves that mtime — which is the liveness proxy doing its job
   * (an agent at work keeps resetting the clock), and means a test that mutates then asserts on a
   * dirt reason must re-age first or it only ever sees "younger than".
   */
  const backdate = (path: string): void => utimesSync(path, OLD, OLD);

  /** Cut a worktree and backdate it past the age threshold. */
  const cut = async (branch: string): Promise<string> => {
    const path = await run(
      Effect.gen(function* () {
        const client = yield* GitClient;
        return yield* client.addWorktree({
          repoPath: repo,
          worktreePath: join(worktrees, branch.replace(/\//g, "-")),
          checkout: { kind: "branch", branch },
        });
      }),
    );
    utimesSync(path, OLD, OLD);
    return path;
  };

  const gc = (opts: { pruneUntracked?: boolean; keep?: string[]; dryRun?: boolean }) =>
    run(
      Effect.gen(function* () {
        const client = yield* GitClient;
        return yield* client.gcWorktrees({
          repoPath: repo,
          roots: [worktrees],
          minAgeMs: 24 * 3600_000,
          ...opts,
        });
      }),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-core-gc-test-"));
    // A bare origin, so a pushed branch is genuinely reachable from a remote — the collector's
    // whole "clean" guarantee rests on `git log HEAD --not --remotes`.
    origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "origin.git"], { cwd: root, stdio: "pipe" });
    repo = join(root, "repo");
    execFileSync("git", ["clone", "-q", origin, "repo"], { cwd: root, stdio: "pipe" });
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "HEAD:main");
    worktrees = join(root, "worktrees");
    mkdirSync(worktrees);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("collects an old worktree whose commits are all on the remote", async () => {
    const path = await cut("feature/done");
    git(repo, "push", "-q", "origin", "feature/done");

    const report = await gc({});

    expect(report.removed.map((e) => e.branch)).toEqual(["feature/done"]);
    expect(existsSync(path)).toBe(false);
    // The branch goes with it — recoverable, because every commit is on the remote.
    expect(String(git(repo, "branch", "--list", "feature/done"))).toBe("");
  });

  it("keeps a worktree with commits that exist nowhere else", async () => {
    const path = await cut("feature/local-only");
    writeFileSync(join(path, "work.txt"), "real work\n");
    git(path, "add", "work.txt");
    git(path, "commit", "-q", "-m", "unpushed");
    backdate(path);

    const report = await gc({ pruneUntracked: true });

    expect(report.removed).toEqual([]);
    expect(report.kept[0]?.reason).toBe("unpushed commits");
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a worktree holding scratch, until asked to discard it", async () => {
    const path = await cut("feature/scratch");
    git(repo, "push", "-q", "origin", "feature/scratch");
    writeFileSync(join(path, "plan-something.md"), "# plan\n");
    backdate(path);

    const kept = await gc({});
    expect(kept.removed).toEqual([]);
    expect(kept.kept[0]?.reason).toBe("1 untracked file(s)");
    expect(existsSync(path)).toBe(true);

    const swept = await gc({ pruneUntracked: true });
    // The discarded files are named in the report — the collector's audit trail.
    expect(swept.removed[0]?.untracked).toEqual(["plan-something.md"]);
    expect(existsSync(path)).toBe(false);
  });

  it("never collects a worktree named live, however old and clean it is", async () => {
    const path = await cut("feature/live");
    git(repo, "push", "-q", "origin", "feature/live");

    const report = await gc({ keep: ["feature-live"] });

    expect(report.removed).toEqual([]);
    expect(report.kept[0]?.reason).toBe("live workspace");
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a worktree younger than the threshold", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* GitClient;
        return yield* client.addWorktree({
          repoPath: repo,
          worktreePath: join(worktrees, "fresh"),
          checkout: { kind: "branch", branch: "feature/fresh" },
        });
      }),
    );
    git(repo, "push", "-q", "origin", "feature/fresh");

    const report = await gc({ pruneUntracked: true });

    expect(report.removed).toEqual([]);
    expect(report.kept[0]?.reason).toContain("younger than");
  });

  it("dry run classifies identically and changes nothing", async () => {
    const path = await cut("feature/dry");
    git(repo, "push", "-q", "origin", "feature/dry");

    const report = await gc({ dryRun: true });

    expect(report.removed.map((e) => e.branch)).toEqual(["feature/dry"]);
    expect(existsSync(path)).toBe(true);
  });

  it("collects a HUSK — a directory git has no record of", async () => {
    // The case nothing else can see: files left behind after git's admin entry is gone. It keeps
    // its full size and every git-based tool reports the workspace as empty.
    const husk = join(worktrees, "orphaned-run");
    mkdirSync(husk);
    writeFileSync(join(husk, "leftover.bin"), "x".repeat(1024));
    utimesSync(husk, OLD, OLD);

    const kept = await gc({});
    expect(kept.kept.map((e) => e.reason)).toEqual(["husk (untracked by git)"]);
    expect(existsSync(husk)).toBe(true);

    const swept = await gc({ pruneUntracked: true });
    expect(swept.removed.map((e) => e.path)).toEqual([husk]);
    expect(existsSync(husk)).toBe(false);
  });

  it("leaves the main working tree and anything outside the roots alone", async () => {
    const outside = join(root, "somebody-elses");
    await run(
      Effect.gen(function* () {
        const client = yield* GitClient;
        return yield* client.addWorktree({
          repoPath: repo,
          worktreePath: outside,
          checkout: { kind: "branch", branch: "feature/theirs" },
        });
      }),
    );
    utimesSync(outside, OLD, OLD);

    const report = await gc({ pruneUntracked: true });

    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([]); // not even considered
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });

  it("reports bytes reclaimed, and totals only what it could measure", async () => {
    await cut("feature/sized");
    git(repo, "push", "-q", "origin", "feature/sized");

    const report = await gc({});

    expect(report.bytesReclaimed).toBeGreaterThan(0);
    expect(report.removed[0]?.bytes).toBeGreaterThan(0);
  });
});
