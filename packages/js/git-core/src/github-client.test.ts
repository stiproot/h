import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubApiError, GitHubClient, HttpGitHubClient } from "./github-client.ts";

const listEffect = (repo: string, label: string, token?: string) =>
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    return yield* client.listOpenIssues({ repo, label, token });
  }).pipe(Effect.provide(HttpGitHubClient));

const list = (repo: string, label: string, token?: string) =>
  Effect.runPromise(listEffect(repo, label, token));

const listError = (repo: string, label: string, token?: string) =>
  Effect.runPromise(Effect.flip(listEffect(repo, label, token)));

afterEach(() => vi.unstubAllGlobals());

describe("HttpGitHubClient", () => {
  it("filters pull requests and maps the issue fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { number: 1, title: "issue", created_at: "2026-01-01T00:00:00Z" },
            {
              number: 2,
              title: "pull request",
              created_at: "2026-01-02T00:00:00Z",
              pull_request: {},
            },
          ]),
          { status: 200 },
        ),
      ),
    );
    await expect(list("owner/repo", "h-builds-h")).resolves.toEqual([
      { number: 1, title: "issue", createdAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("builds the oldest-first request and only sends Authorization with a token", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await list("owner/repo", "needs work", "secret");
    await list("owner/repo", "needs work");

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("state=open&labels=needs%20work&sort=created&direction=asc&per_page=100");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret" });
    const noTokenHeaders = (fetch.mock.calls[1] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(noTokenHeaders).not.toHaveProperty("Authorization");
  });

  it("maps a non-2xx response to GitHubApiError with repo, status, and truncated body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("x".repeat(600), { status: 403, statusText: "Forbidden" })),
    );
    const error = await listError("owner/repo", "label");
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.repo).toBe("owner/repo");
    expect(error.message).toContain("HTTP 403 Forbidden");
    expect(error.message).toContain("x".repeat(500));
    expect(error.message).not.toContain("x".repeat(501));
  });

  it.each(["rejected fetch", "non-ok body"])("never leaks the token from a %s", async (kind) => {
    const token = "ghp_super_secret";
    vi.stubGlobal(
      "fetch",
      kind === "rejected fetch"
        ? vi.fn().mockRejectedValue(new Error(`transport exposed ${token}`))
        : vi.fn().mockResolvedValue(new Response(`body exposed ${token}`, { status: 403 })),
    );
    const error = await listError("owner/repo", "label", token);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.message).toContain("<redacted>");
    expect(error.message).not.toContain(token);
    expect(String(error.cause)).not.toContain(token);
  });
});
