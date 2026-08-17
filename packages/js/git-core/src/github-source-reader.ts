import { WorkflowError } from "core";
import { GitHubClient, HttpGitHubClient } from "./github-client.ts";
import { Effect, Layer } from "effect";

import { SourceReader, type SourceItem } from "engine-core";

/**
 * The `ISourceReader` adapter: GitHub open-issue enumeration, backed by git-core's `GitHubClient`
 *. The GitHub I/O machinery lives in the core package;
 * this adapter only reads the token from the environment and maps the port's error into the domain's
 * `WorkflowError`. `GH_TOKEN` is the same private-repo-clone token wired for the `/clone` activity;
 * omitted, public repos still read.
 *
 * Self-contained: it provides `HttpGitHubClient` internally, so the composition root wires a single
 * requirement-free layer (mirroring the store layers).
 *
 * It lives HERE rather than in a host because BOTH engine hosts need it — workflow-svc's discovery
 * cron and the local engine host's read the same GitHub issues through the same port. It cannot
 * live in `engine-core`, which is guarded pure and may not touch an I/O package; git-core already
 * owns the GitHub client, so the adapter belongs beside it. The dependency points inward
 * (git-core → engine-core's port), which is the direction ports are for.
 */
export const GitHubSourceReaderLive: Layer.Layer<SourceReader> = Layer.effect(
  SourceReader,
  Effect.gen(function* () {
    const gh = yield* GitHubClient;
    const token = process.env.GH_TOKEN || undefined;
    return {
      listOpenIssues: ({ repo, label }: { repo: string; label: string }) =>
        gh.listOpenIssues({ repo, label, token }).pipe(
          Effect.map((issues): readonly SourceItem[] => issues),
          Effect.mapError((cause) => new WorkflowError({ cause, instanceId: `discover:${repo}` })),
        ),
    };
  }),
).pipe(Layer.provide(HttpGitHubClient));
