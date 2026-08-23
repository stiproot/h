import { Command, FileSystem } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Duration, Effect, Layer } from "effect";

import { GitExitError, causeText, redactedCause, runGit } from "./git-exec.ts";
import { gcWorktreesEffect } from "./worktree-gc.ts";
import type { GcOptions, GcReport } from "./worktree-gc.ts";

/**
 * How git authenticates to the remote. Strategies are *named* in workflow/step config; the
 * secrets stay in env/mounts on the agent service, never in a definition.
 *  - `pat`: inject a token into a github URL — in EITHER form (https or scp-style ssh) — per
 *    invocation (never persisted), so the transport resolves over https regardless of the origin
 *    the clone carries; `token` on Clone/Worktree options is shorthand for this strategy.
 *  - `ssh`: rewrite a github URL (either form) to its `git@github.com:` form and let SSH
 *    authenticate the transport — via `keyPath` (`GIT_SSH_COMMAND -i`) or the ambient agent/config
 *    when unset. SSH covers git transport only; API calls (PR creation) authenticate separately.
 * A `github-app` strategy (mint an installation token per op, then the pat path) can slot in
 * here without touching callers.
 */
export type GitAuth = { kind: "pat"; token?: string } | { kind: "ssh"; keyPath?: string };

export type CloneOptions = {
  url: string;
  dir: string;
  cwd: string;
  branch?: string;
  depth?: number;
  /** Shorthand for `auth: { kind: "pat", token }`; ignored when `auth` is set. */
  token?: string;
  auth?: GitAuth;
};

const GITHUB_HTTPS = "https://github.com/";
const GITHUB_SSH = "git@github.com:";

// The `owner/repo(.git)` path of a github remote in EITHER transport form — https
// (`https://github.com/owner/repo`) or scp-style ssh (`git@github.com:owner/repo`); undefined for a
// non-github URL. Extracting the path independently of the form is what lets a transport strategy be
// chosen per repo without depending on the form the clone's origin happens to carry.
function githubRepoPath(url: string): string | undefined {
  if (url.startsWith(GITHUB_HTTPS)) return url.slice(GITHUB_HTTPS.length);
  if (url.startsWith(GITHUB_SSH)) return url.slice(GITHUB_SSH.length);
  return undefined;
}

// Inject a GitHub token into a github URL — in either form — so a private repo resolves over https.
// Done in-process at invocation time; the token is passed to git as an argument (no shell), so it
// never lands in a shell command line, the workflow definition, or the task entry. Non-github URLs
// and the tokenless case pass through untouched.
function authenticatedUrl(url: string, token?: string): string {
  const path = token ? githubRepoPath(url) : undefined;
  return path === undefined ? url : `https://x-access-token:${token}@github.com/${path}`;
}

// Rewrite a github URL — in either form — to its scp-style SSH form so the transport authenticates
// via SSH keys. Non-github URLs pass through untouched; an already-SSH URL normalizes to itself.
function sshUrl(url: string): string {
  const path = githubRepoPath(url);
  return path === undefined ? url : `git@github.com:${path.replace(/\.git$/, "")}.git`;
}

const normalizeAuth = (auth: GitAuth | undefined, token: string | undefined): GitAuth =>
  auth ?? { kind: "pat", token };

// The strategy's two touch points on a git invocation: the remote URL form, and the process env.
// Exported pure for value tests (the mergeMcpConfig pattern).
export const resolveUrl = (url: string, auth: GitAuth): string =>
  auth.kind === "ssh" ? sshUrl(url) : authenticatedUrl(url, auth.token);

export const authEnv = (auth: GitAuth): Record<string, string> | undefined =>
  auth.kind === "ssh" && auth.keyPath
    ? {
        GIT_SSH_COMMAND: `ssh -i ${auth.keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      }
    : undefined;

const authToken = (auth: GitAuth): string | undefined =>
  auth.kind === "pat" ? auth.token : undefined;

/**
 * WHAT a worktree gets checked out to — a named strategy chosen in workflow/step config, the
 * sibling of {@link GitAuth} (which names HOW git authenticates). Adding a strategy is a change in
 * exactly two places: this union and the wire schema that names it; SELECTING one is data, so a
 * template author explores a different checkout without a code change.
 *
 *  - `branch` — put the worktree on a branch, creating it when absent. The WRITE strategy
 *    (implement, plan, revise): the run's whole point is commits on a named branch.
 *  - `detached` — check out an existing commit-ish with NO branch. The READ strategy (review,
 *    audit, scout): a read-only agent should not be holding a branch, and a detached checkout
 *    creates nothing in the shared clone that another run could collide with.
 *
 * Deliberately git-only: a GitHub PR head (`refs/pull/N/head`) is expressed by the CALLER as a
 * `detached` fetch, never as a `kind` here — keeping the forge's conventions out of git-core is
 * what lets a template swap a PR's `head` for its `merge` ref as a fire-time param.
 */
export type GitCheckout =
  | {
      kind: "branch";
      // Branch to put the worktree on. If it already exists, the worktree checks it out (preserving
      // its commits); if not, it is created. Omit to let git name a branch after the worktree path.
      branch?: string;
      // Start point for a newly created branch; ignored when checking out an existing branch.
      baseRef?: string;
      // When set (e.g. "main"), fetch this branch from origin before cutting a NEW branch and start
      // it from the freshly-fetched remote tip, so the worktree is up to date with the remote rather
      // than the source clone's possibly-stale local checkout. Ignored when checking out an existing
      // branch (its commits are preserved) or when an explicit baseRef pins a start point.
      remoteBase?: string;
    }
  | {
      kind: "detached";
      // The commit-ish to check out, and — when `fetch` is set — the local ref the fetch writes.
      ref: string;
      // Fetch `remoteRef` from origin into `ref` first, so the target need NOT already exist in a
      // shallow pre-clone (a PR head, a fork's branch, a tag). The fetch is forced, so re-running
      // against a ref that has since moved updates rather than failing non-fast-forward.
      fetch?: { remoteRef: string; depth?: number };
    };

export type WorktreeOptions = {
  // Path to an existing clone (holds the .git the worktree shares its object store with).
  repoPath: string;
  // Destination path for the new worktree checkout.
  worktreePath: string;
  // WHAT to check out there. See {@link GitCheckout}.
  checkout: GitCheckout;
  // GitHub token to authenticate the origin fetch for a private https repo (injected in-process, as
  // in clone(); never persisted to the remote or a shell command line). Shorthand for
  // `auth: { kind: "pat", token }`; ignored when `auth` is set.
  token?: string;
  auth?: GitAuth;
};

// ---------------------------------------------------------------------------
// Effect port + adapter (the GitClient hexagon unit — ARCHITECTURE.md#boundaries-enforced)
// ---------------------------------------------------------------------------

/**
 * A `git clone` failed. `url` is always the caller's UNauthenticated URL and `cause`
 * carries only token-scrubbed text, so an injected GH_TOKEN can never surface here.
 */
export class GitCloneError extends Data.TaggedError("GitCloneError")<{
  readonly cause: unknown;
  readonly url: string;
  readonly dir: string;
}> {
  override get message(): string {
    return `git clone of ${this.url} into ${this.dir} failed: ${causeText(this.cause)}`;
  }
}

/**
 * A `git worktree` provisioning step (prune, origin fetch, or worktree add) failed.
 * `cause` carries only token-scrubbed text, as in {@link GitCloneError}.
 */
export class GitWorktreeError extends Data.TaggedError("GitWorktreeError")<{
  readonly cause: unknown;
  readonly repoPath: string;
  readonly worktreePath: string;
}> {
  override get message(): string {
    return `git worktree of ${this.repoPath} at ${this.worktreePath} failed: ${causeText(this.cause)}`;
  }
}

/**
 * The git port: today's `clone()`/`addWorktree()` contract made explicit as a tag.
 * Methods are `R = never`; the adapter layer captures `CommandExecutor` at build time.
 */
export class GitClient extends Context.Tag("GitClient")<
  GitClient,
  {
    /** Shallow-clone `url` into `dir` (relative to `cwd`), depth 1 unless overridden. */
    readonly clone: (opts: CloneOptions) => Effect.Effect<void, GitCloneError>;
    /**
     * Add a git worktree of `repoPath` at `worktreePath`, per the caller's {@link GitCheckout}
     * strategy, returning the EFFECTIVE path.
     *
     * `branch`: an existing branch is checked out as-is (not reset); a missing one is created —
     * from the freshly-fetched `origin/<remoteBase>` tip when `remoteBase` is set and no explicit
     * `baseRef` pins a start point. Reuse-by-branch (issue #76): a branch can only be checked out
     * in ONE worktree, so if some worktree (any workspace) already holds it, that worktree's path
     * is returned instead of failing — members that need a fresh base already fetch + reset
     * against origin themselves.
     *
     * `detached`: the ref is fetched (when asked) and checked out with NO branch, so nothing is
     * created that a concurrent run could contend for — reuse-by-branch does not apply and the
     * requested path always comes back.
     */
    readonly addWorktree: (opts: WorktreeOptions) => Effect.Effect<string, GitWorktreeError>;
    /**
     * Collect the h-managed worktrees under `opts.roots` that hold nothing worth keeping, and
     * the directories git has no record of. Never fails: a worktree it could not classify is
     * REPORTED as kept, because a collector that aborts halfway leaves the leak it was sent to
     * fix. See {@link GcOptions} for what bounds what it may destroy.
     */
    readonly gcWorktrees: (opts: GcOptions) => Effect.Effect<GcReport>;
  }
>() {}

const cloneEffect = (
  opts: CloneOptions,
): Effect.Effect<void, GitCloneError, CommandExecutor.CommandExecutor> => {
  const { url, dir, cwd, branch, depth = 1 } = opts;
  const auth = normalizeAuth(opts.auth, opts.token);
  const token = authToken(auth);
  const resolved = resolveUrl(url, auth);
  const args = ["clone", "--depth", String(depth)];
  if (branch) args.push("--branch", branch);
  args.push(resolved, dir);
  // `git clone` persists the URL it cloned from as the new clone's origin. When a token was
  // injected, reset origin to the caller's clean URL afterwards so the credential never rests
  // in the clone's config — injection is strictly per-operation.
  // The ssh rewrite is left as-is: it carries no credential, and ssh-mode callers expect the
  // ssh-form origin.
  const scrubOrigin: Effect.Effect<
    unknown,
    GitExitError | PlatformError,
    CommandExecutor.CommandExecutor
  > =
    token !== undefined && resolved !== url
      ? runGit(["-C", dir, "remote", "set-url", "origin", url], cwd)
      : Effect.void;
  return runGit(args, cwd, authEnv(auth)).pipe(
    Effect.zipRight(scrubOrigin),
    Effect.mapError(
      (failure) => new GitCloneError({ cause: redactedCause(failure, token), url, dir }),
    ),
    Effect.asVoid,
  );
};

const branchExistsEffect = (
  repoPath: string,
  branch: string,
): Effect.Effect<boolean, PlatformError, CommandExecutor.CommandExecutor> =>
  Command.make(
    "git",
    "-C",
    repoPath,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ).pipe(
    Command.exitCode,
    Effect.map((code) => code === 0),
  );

/** Parse `git worktree list --porcelain`: the LINKED worktree path currently holding `branch`,
 *  if any. The first block is the MAIN working tree (the shared pre-clone) — deliberately
 *  skipped: an agent must never be redirected into it, so a branch held there falls through to
 *  git's own loud "already used" error. */
const worktreePathForBranch = (porcelain: string, branch: string): string | undefined => {
  let current: string | undefined;
  let block = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      block += 1;
      current = block > 1 ? line.slice("worktree ".length).trim() : undefined;
    } else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return undefined;
};

const addWorktreeEffect = (
  opts: WorktreeOptions,
): Effect.Effect<string, GitWorktreeError, CommandExecutor.CommandExecutor> => {
  const { repoPath, worktreePath, checkout } = opts;
  const auth = normalizeAuth(opts.auth, opts.token);
  const token = authToken(auth);
  /** `git fetch <origin> +<src>:<dst>`, authenticated per the caller's strategy. Forced, so a ref
   *  that has moved since a previous run updates instead of failing non-fast-forward. */
  const fetchInto = (
    remoteRef: string,
    localRef: string,
    depth?: number,
  ): Effect.Effect<void, GitExitError | PlatformError, CommandExecutor.CommandExecutor> =>
    Effect.gen(function* () {
      const originUrl = (yield* runGit(["-C", repoPath, "remote", "get-url", "origin"])).trim();
      const args = ["-C", repoPath, "fetch", "--quiet"];
      if (depth !== undefined) args.push("--depth", String(depth));
      args.push(resolveUrl(originUrl, auth), `+${remoteRef}:${localRef}`);
      yield* runGit(args, undefined, authEnv(auth));
    });

  return Effect.gen(function* () {
    // Drop admin entries for worktree dirs removed out of band, so re-adding at the same path does
    // not fail with "already registered".
    yield* runGit(["-C", repoPath, "worktree", "prune"]);

    if (checkout.kind === "detached") {
      // A detached checkout holds no branch, so there is nothing to reuse and nothing to contend
      // for: fetch the target when asked (it need not exist in a shallow pre-clone), then check it
      // out with --detach. No -b, no branch left behind in the shared clone.
      if (checkout.fetch) {
        yield* fetchInto(checkout.fetch.remoteRef, checkout.ref, checkout.fetch.depth);
      }
      yield* runGit(["-C", repoPath, "worktree", "add", "--detach", worktreePath, checkout.ref]);
      return worktreePath;
    }

    const { branch, remoteBase } = checkout;

    // A BRANCH worktree is the write strategy: it becomes a PR, and a PR that outlives one run
    // gets rebased onto a base that has moved. A --depth 1 clone cannot do that — the common
    // ancestor sits below the shallow boundary, so `git merge-base` returns nothing and a rebase
    // either refuses or misbehaves (observed 2026-08-23: a five-phase feature branch could not
    // rebase, and an attempted rebase replayed a commit twice).
    //
    // So the clone is deepened ONCE, here, when the first write worktree is cut. Detached (read)
    // worktrees are left shallow — a reviewer reading a diff never needs history. The cost is one
    // full fetch per repo, amortised across every worktree that clone will ever host, and h's
    // clones are long-lived shared workspaces rather than throwaway CI checkouts.
    const shallow = (yield* runGit([
      "-C",
      repoPath,
      "rev-parse",
      "--is-shallow-repository",
    ])).trim();
    if (shallow === "true") {
      const originUrl = (yield* runGit(["-C", repoPath, "remote", "get-url", "origin"])).trim();
      yield* runGit(
        ["-C", repoPath, "fetch", "--unshallow", "--quiet", resolveUrl(originUrl, auth)],
        undefined,
        authEnv(auth),
      );
    }

    // Reuse-by-branch (issue #76): a branch is checked out in at most one worktree; if one holds
    // it already (a finished chain's leftover, another workspace's checkout), return ITS path
    // instead of failing with "already used by worktree".
    if (branch) {
      const porcelain = yield* runGit(["-C", repoPath, "worktree", "list", "--porcelain"]);
      const held = worktreePathForBranch(porcelain, branch);
      if (held !== undefined) return held;
    }

    const reuseExisting = branch ? yield* branchExistsEffect(repoPath, branch) : false;

    // Refresh from the remote before cutting a NEW branch so it starts from the latest
    // origin/<remoteBase> rather than the source clone's stale local checkout. Skipped when reusing
    // an existing branch (keep its work) or when the caller pinned an explicit baseRef.
    let baseRef = checkout.baseRef;
    if (!reuseExisting && remoteBase && !baseRef) {
      const trackingRef = `refs/remotes/origin/${remoteBase}`;
      yield* fetchInto(remoteBase, trackingRef);
      baseRef = trackingRef;
    }

    const args = ["-C", repoPath, "worktree", "add"];
    if (reuseExisting) {
      // Check out the existing branch into the worktree (no -b/-B: don't recreate or reset it).
      args.push(worktreePath, branch as string);
    } else if (branch) {
      // Create a new branch for the worktree, optionally from baseRef (the refreshed remote tip above).
      args.push("-b", branch, worktreePath);
      if (baseRef) args.push(baseRef);
    } else {
      args.push(worktreePath);
      if (baseRef) args.push(baseRef);
    }
    yield* runGit(args);
    return worktreePath;
  }).pipe(
    Effect.mapError(
      (failure) =>
        new GitWorktreeError({ cause: redactedCause(failure, token), repoPath, worktreePath }),
    ),
  );
};

const isLockRefError = (err: GitWorktreeError): boolean =>
  causeText(err.cause).includes("cannot lock ref");

/**
 * Adapter: git over `@effect/platform` `Command` (non-blocking subprocesses). The layer captures
 * `CommandExecutor` at build time so the port methods stay `R = never`; the consuming composition
 * root provides `NodeContext.layer` (or `NodeCommandExecutor.layer`).
 */
export const ExecGitClient: Layer.Layer<
  GitClient,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> = Layer.effect(
  GitClient,
  Effect.gen(function* () {
    const executor = yield* Effect.context<
      CommandExecutor.CommandExecutor | FileSystem.FileSystem
    >();
    // In-process mutex per repo path: all worktree cuts for a given repo go through one
    // agent-service process, so a permit-1 semaphore per path serializes concurrent
    // addWorktree calls and eliminates `cannot lock ref` races on the shared pre-clone's
    // ref files. Assumption: every caller runs inside the same process; cross-process
    // callers are protected by the one-shot retry below instead.
    const mutexMap = new Map<string, Effect.Semaphore>();
    const getOrCreateMutex = (repoPath: string): Effect.Effect<Effect.Semaphore> =>
      Effect.suspend(() => {
        const existing = mutexMap.get(repoPath);
        if (existing !== undefined) return Effect.succeed(existing);
        // Effect.makeSemaphore is backed by Ref.make (Effect.sync) — no yield point —
        // so the check-and-set completes without interleaving with other fibers.
        return Effect.map(Effect.makeSemaphore(1), (sem) => {
          mutexMap.set(repoPath, sem);
          return sem;
        });
      });
    return {
      clone: (opts: CloneOptions) => cloneEffect(opts).pipe(Effect.provide(executor)),
      addWorktree: (opts: WorktreeOptions) => {
        const attempt = addWorktreeEffect(opts).pipe(Effect.provide(executor));
        return getOrCreateMutex(opts.repoPath).pipe(
          Effect.flatMap((sem) =>
            sem.withPermits(1)(
              // Belt-and-braces retry for cross-process callers: if a concurrent fetch from
              // another process still wins the lock, back off 200 ms and retry once before
              // propagating loudly.
              attempt.pipe(
                Effect.catchIf(isLockRefError, () =>
                  Effect.zipRight(Effect.sleep(Duration.millis(200)), attempt),
                ),
              ),
            ),
          ),
        );
      },
      gcWorktrees: (opts: GcOptions) => gcWorktreesEffect(opts).pipe(Effect.provide(executor)),
    };
  }),
);
