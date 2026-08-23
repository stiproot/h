import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecGitClient, GitClient, authEnv, resolveUrl } from "./git-client.ts";

// The Effect port + adapter over the same temp-repo fixtures. `@effect/vitest`'s it.effect is
// avoided per the refactor map (peers on vitest 3.x, repo has 4.x): plain it() + Effect.runPromise.
describe("GitClient (ExecGitClient layer)", () => {
  const TestLayer = ExecGitClient.pipe(Layer.provide(NodeContext.layer));
  const run = <A, E>(effect: Effect.Effect<A, E, GitClient>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-core-effect-test-"));
    repo = join(root, "source");
    execFileSync("git", ["init", "-q", "source"], { cwd: root, stdio: "pipe" });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("clones a repo into the requested dir", async () => {
    await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        yield* git.clone({ url: repo, dir: "checkout", cwd: root });
      }),
    );
    expect(readFileSync(join(root, "checkout", "README.md"), "utf8")).toBe("hello\n");
  });

  it("fails a clone with GitCloneError carrying git's stderr", async () => {
    // Deterministic offline failure: git refuses a non-empty destination before touching any remote.
    const dest = join(root, "occupied");
    mkdirSync(dest);
    writeFileSync(join(dest, "blocker.txt"), "x\n");

    const err = await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* Effect.flip(git.clone({ url: repo, dir: "occupied", cwd: root }));
      }),
    );

    expect(err._tag).toBe("GitCloneError");
    expect(err.url).toBe(repo);
    expect(err.dir).toBe("occupied");
    // stderr made it into the error, execFileSync-style.
    expect(String(err.cause)).toContain("already exists");
    expect(err.message).toContain("already exists");
  });

  it("never leaks the token through the error, even when git echoes its arguments", async () => {
    const token = "ghp-SUPER-SECRET-TOKEN";
    const url = "https://github.com/acme/private-repo.git";
    // A stub git that echoes its full argv (including the authenticated URL) to stderr and fails —
    // the worst case for leakage. Command inherits process.env, so a PATH override reaches it.
    const stubDir = join(root, "stub-bin");
    mkdirSync(stubDir);
    writeFileSync(join(stubDir, "git"), `#!/bin/sh\necho "stub-git args: $@" 1>&2\nexit 128\n`);
    chmodSync(join(stubDir, "git"), 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${realPath}`;

    try {
      const err = await run(
        Effect.gen(function* () {
          const git = yield* GitClient;
          return yield* Effect.flip(git.clone({ url, dir: "repo", cwd: root, token }));
        }),
      );

      expect(err._tag).toBe("GitCloneError");
      // The error's url field is the caller's unauthenticated URL, never the tokened one.
      expect(err.url).toBe(url);
      const surface = `${err.message} ${String(err.cause)} ${JSON.stringify({ ...err })}`;
      expect(String(err.cause)).toContain("stub-git args"); // stderr was captured…
      expect(surface).not.toContain(token); // …but the token was scrubbed from it
      expect(String(err.cause)).toContain("<redacted>");
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("scrubs the injected token from the clone's persisted origin (never at rest)", async () => {
    const token = "ghp-SUPER-SECRET-TOKEN";
    const url = "https://github.com/acme/private-repo.git";
    // A stub git that logs its argv and succeeds: `git clone` would persist the tokened URL as
    // origin, so cloneEffect must follow up with a set-url back to the caller's clean URL
    //.
    const stubDir = join(root, "stub-bin");
    mkdirSync(stubDir);
    const log = join(root, "git-calls.log");
    writeFileSync(join(stubDir, "git"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
    chmodSync(join(stubDir, "git"), 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${realPath}`;

    try {
      await run(
        Effect.gen(function* () {
          const git = yield* GitClient;
          yield* git.clone({ url, dir: "repo", cwd: root, token });
        }),
      );
      const calls = readFileSync(log, "utf8");
      // The clone itself used the injected URL…
      expect(calls).toContain(`x-access-token:${token}`);
      // …and origin was then reset to the clean caller URL, so no credential rests in config.
      expect(calls).toContain(`-C repo remote set-url origin ${url}`);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("deepens a shallow clone when cutting a BRANCH worktree, so it can still rebase", async () => {
    // A --depth 1 clone cannot compute a merge base against a base branch that has moved, so a
    // feature branch cut in one cannot be rebased — the failure that motivated this (2026-08-23).
    const shallow = join(root, "shallow");
    execFileSync("git", ["clone", "--depth", "1", "-q", `file://${repo}`, shallow], {
      stdio: "pipe",
    });
    const isShallow = (dir: string) =>
      execFileSync("git", ["-C", dir, "rev-parse", "--is-shallow-repository"], { stdio: "pipe" })
        .toString()
        .trim();
    expect(isShallow(shallow)).toBe("true");

    await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        yield* git.addWorktree({
          repoPath: shallow,
          worktreePath: join(root, "worktrees", "deepened"),
          checkout: { kind: "branch", branch: "feature/needs-rebase", remoteBase: "" },
        });
      }),
    );

    expect(isShallow(shallow)).toBe("false");
  });

  it("leaves a shallow clone shallow for a DETACHED worktree — a reader never rebases", async () => {
    const shallow = join(root, "shallow-read");
    execFileSync("git", ["clone", "--depth", "1", "-q", `file://${repo}`, shallow], {
      stdio: "pipe",
    });
    const head = execFileSync("git", ["-C", shallow, "rev-parse", "HEAD"], { stdio: "pipe" })
      .toString()
      .trim();

    await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        yield* git.addWorktree({
          repoPath: shallow,
          worktreePath: join(root, "worktrees", "read-only"),
          checkout: { kind: "detached", ref: head },
        });
      }),
    );

    const isShallow = execFileSync("git", ["-C", shallow, "rev-parse", "--is-shallow-repository"], {
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(isShallow).toBe("true");
  });

  it("adds a worktree on the requested new branch", async () => {
    const worktree = join(root, "worktrees", "run-1");
    await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        yield* git.addWorktree({
          repoPath: repo,
          worktreePath: worktree,
          checkout: { kind: "branch", branch: "triage/EFF-1" },
        });
      }),
    );

    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("hello\n");
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktree,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(branch).toBe("triage/EFF-1");
  });

  it("refreshes from origin so a new branch starts at the latest remote tip (remoteBase preserved)", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    const remote = join(root, "remote");
    git(root, "init", "-q", "-b", "main", "remote");
    git(remote, "config", "user.email", "test@example.com");
    git(remote, "config", "user.name", "test");
    writeFileSync(join(remote, "file.txt"), "v1\n");
    git(remote, "add", "file.txt");
    git(remote, "commit", "-qm", "v1");

    const clone = join(root, "clone");
    git(root, "clone", "-q", remote, "clone");

    // Remote advances after the clone; the clone's local main still points at v1.
    writeFileSync(join(remote, "file.txt"), "v2\n");
    git(remote, "commit", "-aqm", "v2");

    const worktree = join(root, "worktrees", "fresh");
    await run(
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        yield* gitClient.addWorktree({
          repoPath: clone,
          worktreePath: worktree,
          checkout: { kind: "branch", branch: "groom/EFF", remoteBase: "main" },
        });
      }),
    );

    // The worktree must hold v2 (fetched from origin), not the clone's stale v1.
    expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("v2\n");
  });

  it("reuses the worktree already holding the branch instead of failing (issue #76)", async () => {
    const first = join(root, "worktrees", "chain-1");
    const second = join(root, "worktrees", "chain-2");
    const path1 = await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.addWorktree({
          repoPath: repo,
          worktreePath: first,
          checkout: { kind: "branch", branch: "feature/x" },
        });
      }),
    );
    expect(path1).toBe(first);
    // A second chain requests the SAME branch at a DIFFERENT path (the cross-chain collision):
    // instead of `fatal: 'feature/x' is already used by worktree`, the existing path returns.
    const path2 = await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.addWorktree({
          repoPath: repo,
          worktreePath: second,
          checkout: { kind: "branch", branch: "feature/x" },
        });
      }),
    );
    expect(path2).toBe(first);
    // Nothing was created at the second path.
    expect(() => readFileSync(join(second, "README.md"), "utf8")).toThrow();
  });

  it("serializes concurrent addWorktree calls so all succeed when the remote has moved (issue #84 — three chains)", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    const remote = join(root, "remote");
    git(root, "init", "-q", "-b", "main", "remote");
    git(remote, "config", "user.email", "test@example.com");
    git(remote, "config", "user.name", "test");
    writeFileSync(join(remote, "file.txt"), "v1\n");
    git(remote, "add", "file.txt");
    git(remote, "commit", "-qm", "v1");

    const clone = join(root, "clone");
    git(root, "clone", "-q", remote, "clone");

    // Remote advances after the clone; without the mutex three concurrent fetches into
    // the same shared clone would race on refs/remotes/origin/main and at least one would fail with
    // "cannot lock ref" (issue #84). The mutex serializes the fetches, so all three succeed.
    writeFileSync(join(remote, "file.txt"), "v2\n");
    git(remote, "commit", "-aqm", "v2");

    const wt1 = join(root, "worktrees", "branch-a");
    const wt2 = join(root, "worktrees", "branch-b");
    const wt3 = join(root, "worktrees", "branch-c");

    // All three effects share the SAME TestLayer (same ExecGitClient instance, same mutex map)
    // because Effect.provide is called once on the combined Effect.all.
    const [p1, p2, p3] = await Effect.runPromise(
      Effect.all(
        [
          Effect.gen(function* () {
            const gitClient = yield* GitClient;
            return yield* gitClient.addWorktree({
              repoPath: clone,
              worktreePath: wt1,
              checkout: { kind: "branch", branch: "feat/A", remoteBase: "main" },
            });
          }),
          Effect.gen(function* () {
            const gitClient = yield* GitClient;
            return yield* gitClient.addWorktree({
              repoPath: clone,
              worktreePath: wt2,
              checkout: { kind: "branch", branch: "feat/B", remoteBase: "main" },
            });
          }),
          Effect.gen(function* () {
            const gitClient = yield* GitClient;
            return yield* gitClient.addWorktree({
              repoPath: clone,
              worktreePath: wt3,
              checkout: { kind: "branch", branch: "feat/C", remoteBase: "main" },
            });
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(p1).toBe(wt1);
    expect(p2).toBe(wt2);
    expect(p3).toBe(wt3);
    // All three worktrees must hold v2 (fetched from origin), not the clone's stale v1.
    // None should fail with "cannot lock ref".
    expect(readFileSync(join(wt1, "file.txt"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(wt2, "file.txt"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(wt3, "file.txt"), "utf8")).toBe("v2\n");
  });

  // The `detached` strategy is the READ checkout: a reviewer needs the code AT a ref, holding no
  // branch. These cover the three things it exists for.
  it("checks out a ref detached, fetching it first so it need not exist locally", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    const remote = join(root, "remote");
    git(root, "init", "-q", "-b", "main", "remote");
    git(remote, "config", "user.email", "test@example.com");
    git(remote, "config", "user.name", "test");
    writeFileSync(join(remote, "file.txt"), "base\n");
    git(remote, "add", "file.txt");
    git(remote, "commit", "-qm", "base");

    // A ref OUTSIDE refs/heads — exactly the shape of GitHub's refs/pull/N/head, which no clone
    // fetches by default and which a shallow pre-clone therefore never has.
    git(remote, "checkout", "-q", "-b", "contrib");
    writeFileSync(join(remote, "file.txt"), "proposed\n");
    git(remote, "commit", "-aqm", "proposal");
    git(remote, "update-ref", "refs/pull/7/head", "refs/heads/contrib");
    git(remote, "checkout", "-q", "main");
    git(remote, "branch", "-qD", "contrib");

    const clone = join(root, "clone");
    git(root, "clone", "-q", "--depth", "1", remote, "clone");

    const worktree = join(root, "worktrees", "review-7");
    const path = await run(
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        return yield* gitClient.addWorktree({
          repoPath: clone,
          worktreePath: worktree,
          checkout: {
            kind: "detached",
            ref: "refs/remotes/origin/pr/7/head",
            fetch: { remoteRef: "refs/pull/7/head", depth: 1 },
          },
        });
      }),
    );

    expect(path).toBe(worktree);
    // The PR's content, NOT main's — the trap the branch strategy falls into, since a name that
    // does not resolve locally makes it cut a new branch from origin/main's tip instead.
    expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("proposed\n");
    // Detached: no branch was created in the shared clone for another run to collide with.
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree, stdio: "pipe" })
        .toString()
        .trim(),
    ).toBe("HEAD");
  });

  it("checks out detached at a ref another worktree already holds as a branch", async () => {
    // The h-builds-h case: review runs on the same clone the implementer is working in, where
    // feature/x IS checked out. A branch checkout would be handed the implementer's worktree by
    // reuse-by-branch; a detached one gets its own.
    const held = join(root, "worktrees", "implementer");
    await run(
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        return yield* gitClient.addWorktree({
          repoPath: repo,
          worktreePath: held,
          checkout: { kind: "branch", branch: "feature/x" },
        });
      }),
    );

    const reviewer = join(root, "worktrees", "reviewer");
    const path = await run(
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        return yield* gitClient.addWorktree({
          repoPath: repo,
          worktreePath: reviewer,
          checkout: { kind: "detached", ref: "refs/heads/feature/x" },
        });
      }),
    );

    expect(path).toBe(reviewer);
    expect(readFileSync(join(reviewer, "README.md"), "utf8")).toBe("hello\n");
  });

  it("re-fetches a detached ref that has since moved (forced, not non-fast-forward)", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    const remote = join(root, "remote");
    git(root, "init", "-q", "-b", "main", "remote");
    git(remote, "config", "user.email", "test@example.com");
    git(remote, "config", "user.name", "test");
    writeFileSync(join(remote, "file.txt"), "v1\n");
    git(remote, "add", "file.txt");
    git(remote, "commit", "-qm", "v1");
    git(remote, "update-ref", "refs/pull/3/head", "refs/heads/main");

    const clone = join(root, "clone");
    git(root, "clone", "-q", remote, "clone");

    await run(
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        return yield* gitClient.addWorktree({
          repoPath: clone,
          worktreePath: join(root, "worktrees", "first"),
          checkout: {
            kind: "detached",
            ref: "refs/remotes/origin/pr/3/head",
            fetch: { remoteRef: "refs/pull/3/head" },
          },
        });
      }),
    );

    // The PR is force-pushed: its head ref now points at an unrelated history, so an unforced
    // fetch into the same local ref would fail non-fast-forward.
    git(remote, "checkout", "-q", "--orphan", "rewritten");
    writeFileSync(join(remote, "file.txt"), "v2\n");
    git(remote, "add", "file.txt");
    git(remote, "commit", "-qm", "v2");
    git(remote, "update-ref", "refs/pull/3/head", "refs/heads/rewritten");

    const second = join(root, "worktrees", "second");
    await run(
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        return yield* gitClient.addWorktree({
          repoPath: clone,
          worktreePath: second,
          checkout: {
            kind: "detached",
            ref: "refs/remotes/origin/pr/3/head",
            fetch: { remoteRef: "refs/pull/3/head" },
          },
        });
      }),
    );

    expect(readFileSync(join(second, "file.txt"), "utf8")).toBe("v2\n");
  });

  it("fails a worktree add with GitWorktreeError carrying git's stderr", async () => {
    // The branch checked out in the source repo cannot also be checked out in a worktree.
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    git(repo, "checkout", "-q", "-b", "held");
    const worktree = join(root, "worktrees", "conflict");

    const err = await run(
      Effect.gen(function* () {
        const gitClient = yield* GitClient;
        return yield* Effect.flip(
          gitClient.addWorktree({
            repoPath: repo,
            worktreePath: worktree,
            checkout: { kind: "branch", branch: "held" },
          }),
        );
      }),
    );

    expect(err._tag).toBe("GitWorktreeError");
    expect(err.repoPath).toBe(repo);
    expect(err.worktreePath).toBe(worktree);
    expect(String(err.cause)).toContain("already");
  });
});

describe("GitAuth strategy (pure helpers)", () => {
  it("ssh rewrites a github https URL to its git@ form", () => {
    expect(resolveUrl("https://github.com/owner/repo", { kind: "ssh" })).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(resolveUrl("https://github.com/owner/repo.git", { kind: "ssh" })).toBe(
      "git@github.com:owner/repo.git",
    );
  });

  it("ssh leaves non-github and already-ssh URLs untouched", () => {
    expect(resolveUrl("git@github.com:owner/repo.git", { kind: "ssh" })).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(resolveUrl("/local/path/repo", { kind: "ssh" })).toBe("/local/path/repo");
  });

  it("pat injects the token into a github URL in either form (https or scp-ssh)", () => {
    expect(resolveUrl("https://github.com/o/r", { kind: "pat", token: "tok" })).toBe(
      "https://x-access-token:tok@github.com/o/r",
    );
    // A scp-style ssh origin normalizes to the tokened https form, so a clone whose origin is ssh
    // can still fetch/push over https with a PAT — no ssh key needed in the container.
    expect(resolveUrl("git@github.com:o/r.git", { kind: "pat", token: "tok" })).toBe(
      "https://x-access-token:tok@github.com/o/r.git",
    );
    expect(resolveUrl("https://github.com/o/r", { kind: "pat" })).toBe("https://github.com/o/r");
    expect(resolveUrl("/local/path/repo", { kind: "pat", token: "tok" })).toBe("/local/path/repo");
  });

  it("authEnv sets GIT_SSH_COMMAND only for ssh with an explicit key", () => {
    expect(authEnv({ kind: "ssh", keyPath: "/keys/id_ed25519" })).toEqual({
      GIT_SSH_COMMAND:
        "ssh -i /keys/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
    });
    expect(authEnv({ kind: "ssh" })).toBeUndefined();
    expect(authEnv({ kind: "pat", token: "tok" })).toBeUndefined();
  });
});
