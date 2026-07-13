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

  it("adds a worktree on the requested new branch", async () => {
    const worktree = join(root, "worktrees", "run-1");
    await run(
      Effect.gen(function* () {
        const git = yield* GitClient;
        yield* git.addWorktree({ repoPath: repo, worktreePath: worktree, branch: "triage/EFF-1" });
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
          branch: "groom/EFF",
          remoteBase: "main",
        });
      }),
    );

    // The worktree must hold v2 (fetched from origin), not the clone's stale v1.
    expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("v2\n");
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
          gitClient.addWorktree({ repoPath: repo, worktreePath: worktree, branch: "held" }),
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
