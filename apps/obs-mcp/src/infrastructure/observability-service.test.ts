import {
  Error as PlatformError,
  FileSystem,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "@effect/platform";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ObservabilityService,
  type ObservabilityServiceShape,
} from "../domain/ports/IObservabilityService.ts";
import { ObservabilityServiceLive } from "./observability-service.ts";

const configLayer = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["ZIPKIN_URL", "http://zipkin.test"],
      ["LOKI_URL", "http://loki.test"],
      ["RUNS_DIR", "/runs"],
    ]),
  ),
);

// Stub HttpClient: every request is answered by `respond` (a Response, or "unreachable" to
// fail in the typed channel like a dead Zipkin/Loki).
function httpLayer(respond: (url: string) => Response | "unreachable") {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) => {
      const res = respond(req.url);
      if (res === "unreachable") {
        return Effect.fail(
          new HttpClientError.RequestError({
            request: req,
            reason: "Transport",
            cause: new Error("connect ECONNREFUSED"),
          }),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, res));
    }),
  );
}

const deadHttp = httpLayer(() => "unreachable");

const notFound = (method: string, path: string) =>
  new PlatformError.SystemError({
    module: "FileSystem",
    method,
    reason: "NotFound",
    pathOrDescriptor: path,
  });

// Stub FileSystem over an in-memory tree: paths absent from `dirs`/`files` fail like an
// unreadable directory/file; everything the adapter does not use fails via layerNoop.
function fsLayer(tree: { dirs?: Record<string, string[]>; files?: Record<string, string> }) {
  const dirs = tree.dirs ?? {};
  const files = tree.files ?? {};
  return FileSystem.layerNoop({
    readDirectory: (path) =>
      path in dirs ? Effect.succeed(dirs[path]!) : Effect.fail(notFound("readDirectory", path)),
    readFileString: (path) =>
      path in files ? Effect.succeed(files[path]!) : Effect.fail(notFound("readFileString", path)),
    stat: (path) =>
      path in dirs
        ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
        : path in files
          ? Effect.succeed({ type: "File" } as FileSystem.File.Info)
          : Effect.fail(notFound("stat", path)),
  });
}

const emptyFs = fsLayer({});

function run<A, E>(
  use: (obs: ObservabilityServiceShape) => Effect.Effect<A, E>,
  layers: { http?: Layer.Layer<HttpClient.HttpClient>; fs?: Layer.Layer<FileSystem.FileSystem> },
): Promise<A> {
  const live = ObservabilityServiceLive.pipe(
    Layer.provide(layers.http ?? deadHttp),
    Layer.provide(layers.fs ?? emptyFs),
    Layer.provide(configLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const obs = yield* ObservabilityService;
      return yield* use(obs);
    }).pipe(Effect.provide(live)),
  );
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("swallow semantics: Zipkin/Loki reads (legacy #getJson → null)", () => {
  it("traceSearch returns [] when Zipkin is unreachable", async () => {
    await expect(run((obs) => obs.traceSearch({}), { http: deadHttp })).resolves.toEqual([]);
  });

  it("traceSearch returns [] on a non-2xx or non-array body", async () => {
    await expect(
      run((obs) => obs.traceSearch({}), {
        http: httpLayer(() => new Response("boom", { status: 500 })),
      }),
    ).resolves.toEqual([]);
    await expect(
      run((obs) => obs.traceSearch({}), { http: httpLayer(() => json({ not: "an array" })) }),
    ).resolves.toEqual([]);
  });

  it("traceGet returns Option.none (wire: null) when the trace is missing", async () => {
    const result = await run((obs) => obs.traceGet("abc"), {
      http: httpLayer(() => new Response("not found", { status: 404 })),
    });
    expect(Option.isNone(result)).toBe(true);
  });

  it("logsQuery returns [] when Loki is unreachable", async () => {
    await expect(
      run((obs) => obs.logsQuery({ selector: '{a="b"}' }), { http: deadHttp }),
    ).resolves.toEqual([]);
  });

  it("systemOverview degrades services to [] on a non-array body and keeps recentRuns", async () => {
    const overview = await run((obs) => obs.systemOverview(), {
      http: httpLayer(() => json({ nope: true })),
      fs: fsLayer({
        dirs: { "/runs": ["g"], "/runs/g": ["agent-1"], "/runs/g/agent-1": [] },
        files: { "/runs/g/agent-1/summary.json": '{"agentId":"agent","startedAt":"2026"}' },
      }),
    });
    expect(overview.services).toEqual([]);
    expect(overview.recentRuns).toEqual([{ agentId: "agent", startedAt: "2026" }]);
  });

  it("traceSearch maps spans when Zipkin answers", async () => {
    const spans = [
      [
        { traceId: "t1", name: "run", duration: 2_000, localEndpoint: { serviceName: "svc-a" } },
        {
          traceId: "t1",
          name: "step",
          duration: 1_000,
          localEndpoint: { serviceName: "svc-b" },
          tags: { error: "yes" },
        },
      ],
    ];
    const result = await run((obs) => obs.traceSearch({ service: "svc-a" }), {
      http: httpLayer((url) => (url.includes("/api/v2/traces") ? json(spans) : "unreachable")),
    });
    expect(result).toEqual([
      {
        traceId: "t1",
        durationMs: 2,
        services: ["svc-a", "svc-b"],
        spanNames: ["run", "step"],
        hasError: true,
      },
    ]);
  });
});

describe("swallow semantics: run ledger (legacy #runDirs / #readJson / runGet try-catch)", () => {
  it("runsList returns [] when RUNS_DIR is unreadable", async () => {
    await expect(run((obs) => obs.runsList({}), { fs: emptyFs })).resolves.toEqual([]);
  });

  it("runsList skips an unreadable group dir but returns runs from readable ones", async () => {
    const fs = fsLayer({
      // "bad" is listed under /runs but has no stat/readDirectory entry → unreadable.
      dirs: { "/runs": ["bad", "good"], "/runs/good": ["agent-1"], "/runs/good/agent-1": [] },
      files: { "/runs/good/agent-1/summary.json": '{"agentId":"agent","status":"completed"}' },
    });
    await expect(run((obs) => obs.runsList({}), { fs })).resolves.toEqual([
      { agentId: "agent", status: "completed" },
    ]);
  });

  it("runsList skips a run whose summary.json is missing or unparsable", async () => {
    const fs = fsLayer({
      dirs: {
        "/runs": ["g"],
        "/runs/g": ["no-summary", "bad-summary", "ok"],
        "/runs/g/no-summary": [],
        "/runs/g/bad-summary": [],
        "/runs/g/ok": [],
      },
      files: {
        "/runs/g/bad-summary/summary.json": "not json at all",
        "/runs/g/ok/summary.json": '{"agentId":"agent"}',
      },
    });
    await expect(run((obs) => obs.runsList({}), { fs })).resolves.toEqual([{ agentId: "agent" }]);
  });

  it("runGet tolerates each missing artefact independently", async () => {
    const fs = fsLayer({
      files: { "/runs/wf-1/claude-9/summary.json": '{"agentId":"claude"}' },
    });
    const detail = await run((obs) => obs.runGet("wf-1:claude:9"), { fs });
    expect(Option.getOrNull(detail.summary)).toEqual({ agentId: "claude" });
    expect(Option.isNone(detail.output)).toBe(true);
    expect(detail.events).toEqual([]);
  });

  it("runGet returns summary none on unparsable JSON but still reads output/events", async () => {
    const fs = fsLayer({
      files: {
        "/runs/wf-1/claude-9/summary.json": "{broken",
        "/runs/wf-1/claude-9/output.txt": "final answer",
        "/runs/wf-1/claude-9/events.jsonl": '{"e":1}\n{"e":2}\n',
      },
    });
    const detail = await run((obs) => obs.runGet("wf-1:claude:9"), { fs });
    expect(Option.isNone(detail.summary)).toBe(true);
    expect(Option.getOrNull(detail.output)).toBe("final answer");
    expect(detail.events).toEqual([{ e: 1 }, { e: 2 }]);
  });

  it("runGet keeps events parsed before a malformed line (legacy partial scan)", async () => {
    const fs = fsLayer({
      files: { "/runs/wf-1/claude-9/events.jsonl": '{"e":1}\nnot-json\n{"e":2}\n' },
    });
    const detail = await run((obs) => obs.runGet("wf-1:claude:9"), { fs });
    expect(detail.events).toEqual([{ e: 1 }]);
  });
});
