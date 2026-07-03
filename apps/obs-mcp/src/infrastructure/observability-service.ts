import { join } from "path";

import { FileSystem, HttpClient } from "@effect/platform";
import { Config, Effect, Layer, Option } from "effect";
import type { ConfigError } from "effect";

import {
  ObservabilityService,
  type LogLine,
  type RunsListParams,
  type RunSummary,
} from "../domain/ports/IObservabilityService.ts";

type ZipkinSpan = {
  traceId: string;
  name?: string;
  duration?: number;
  localEndpoint?: { serviceName?: string };
  tags?: Record<string, string>;
};

/**
 * Reads the three observability surfaces directly over HTTP/fs (no Dapr sidecar): Zipkin for traces,
 * Loki for logs, and the on-disk run ledger ({RUNS_DIR}) for agent runs.
 *
 * The silent error handling is load-bearing: every read tolerates missing/unreachable data and
 * degrades to an empty result or `Option.none` — never a failure — at exactly the granularity the
 * pre-Effect class swallowed at. `HttpClient` and `FileSystem` are captured at layer build so the
 * port methods stay `R = never`; the composition root provides `NodeHttpClient.layer` and
 * `NodeContext.layer`.
 */
export const ObservabilityServiceLive: Layer.Layer<
  ObservabilityService,
  ConfigError.ConfigError,
  HttpClient.HttpClient | FileSystem.FileSystem
> = Layer.effect(
  ObservabilityService,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const zipkinUrl = yield* Config.string("ZIPKIN_URL").pipe(
      Config.withDefault("http://localhost:9411"),
    );
    const lokiUrl = yield* Config.string("LOKI_URL").pipe(
      Config.withDefault("http://localhost:3100"),
    );
    const runsDir = yield* Config.string("RUNS_DIR").pipe(Config.withDefault("/workspace/.runs"));

    // Swallow site (legacy #getJson → null): a transport failure, a non-2xx status, or an
    // unparsable body all degrade to Option.none — the shared path behind every Zipkin/Loki read.
    const getJson = (url: string): Effect.Effect<Option.Option<unknown>> =>
      Effect.gen(function* () {
        const res = yield* client.get(url);
        if (res.status < 200 || res.status >= 300) return Option.none();
        return Option.some(yield* res.json);
      }).pipe(Effect.catchAll(() => Effect.succeed(Option.none())));

    // Swallow site (legacy #readJson → null): missing file or unparsable JSON → Option.none.
    const readJson = (path: string): Effect.Effect<Option.Option<RunSummary>> =>
      fs.readFileString(path).pipe(
        Effect.flatMap((content) => Effect.try(() => JSON.parse(content) as RunSummary)),
        Effect.option,
      );

    /** All run-artifact directories under RUNS_DIR (one level: <group>/<agentId>-<ts>). */
    const runDirs: Effect.Effect<string[]> = Effect.gen(function* () {
      const dirs: string[] = [];
      // Swallow site (legacy): an unreadable RUNS_DIR yields no dirs at all.
      const groups = yield* fs.readDirectory(runsDir).pipe(Effect.orElseSucceed(() => []));
      for (const group of groups) {
        const groupPath = join(runsDir, group);
        // Swallow site (legacy per-group try/catch): an unreadable group — or a failure
        // mid-scan — skips the REST of this group only; dirs already collected stay.
        yield* Effect.gen(function* () {
          if ((yield* fs.stat(groupPath)).type !== "Directory") return;
          for (const run of yield* fs.readDirectory(groupPath)) {
            const runPath = join(groupPath, run);
            if ((yield* fs.stat(runPath)).type === "Directory") dirs.push(runPath);
          }
        }).pipe(Effect.ignore);
      }
      return dirs;
    });

    const runsList = (params: RunsListParams): Effect.Effect<RunSummary[]> =>
      Effect.gen(function* () {
        const limit = params.limit ?? 20;
        const summaries: RunSummary[] = [];
        for (const dir of yield* runDirs) {
          // Swallow site (legacy): a run with a missing/unparsable summary.json is skipped.
          const summary = Option.getOrNull(yield* readJson(join(dir, "summary.json")));
          if (!summary) continue;
          if (params.agentId && summary.agentId !== params.agentId) continue;
          if (params.status && summary.status !== params.status) continue;
          summaries.push(summary);
        }
        return summaries
          .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")))
          .slice(0, limit);
      });

    return {
      traceSearch: (params) =>
        Effect.gen(function* () {
          const lookback = params.lookbackMs ?? 3_600_000;
          const limit = params.limit ?? 10;
          const url = new URL(`${zipkinUrl}/api/v2/traces`);
          url.searchParams.set("endTs", String(Date.now()));
          url.searchParams.set("lookback", String(lookback));
          url.searchParams.set("limit", String(limit));
          if (params.service) url.searchParams.set("serviceName", params.service);
          if (params.name) url.searchParams.set("spanName", params.name);

          // Swallow site (legacy): an unreachable Zipkin or a non-array body → [].
          const traces = Option.getOrNull(yield* getJson(url.toString())) as ZipkinSpan[][] | null;
          if (!Array.isArray(traces)) return [];
          return traces.map((spans) => ({
            traceId: spans[0]?.traceId ?? "",
            durationMs: Math.round(Math.max(0, ...spans.map((s) => s.duration ?? 0)) / 1000),
            services: [...new Set(spans.map((s) => s.localEndpoint?.serviceName ?? "?"))],
            spanNames: [...new Set(spans.map((s) => s.name ?? "?"))],
            hasError: spans.some((s) => s.tags?.error !== undefined),
          }));
        }),

      traceGet: (traceId) => getJson(`${zipkinUrl}/api/v2/trace/${encodeURIComponent(traceId)}`),

      logsQuery: (params) =>
        Effect.gen(function* () {
          const lookback = params.lookbackMs ?? 3_600_000;
          const limit = params.limit ?? 100;
          const endNs = BigInt(Date.now()) * 1_000_000n;
          const startNs = endNs - BigInt(lookback) * 1_000_000n;
          const url = new URL(`${lokiUrl}/loki/api/v1/query_range`);
          url.searchParams.set("query", params.selector);
          url.searchParams.set("start", startNs.toString());
          url.searchParams.set("end", endNs.toString());
          url.searchParams.set("limit", String(limit));

          // Swallow site (legacy): an unreachable Loki or an unparsable body → no streams → [].
          const body = Option.getOrNull(yield* getJson(url.toString())) as {
            data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] };
          } | null;
          const result = body?.data?.result ?? [];
          const lines: LogLine[] = [];
          for (const stream of result) {
            for (const [ts, line] of stream.values ?? []) {
              lines.push({ ts, line, labels: stream.stream ?? {} });
            }
          }
          return lines.sort((a, b) => Number(BigInt(b.ts) - BigInt(a.ts))).slice(0, limit);
        }),

      runsList,

      runGet: (runId) =>
        Effect.gen(function* () {
          // runId = "<group>:<agentId>:<ts>"; group may itself contain ':' so split from the right.
          const parts = runId.split(":");
          const ts = parts.pop();
          const agentId = parts.pop();
          const group = parts.join(":");
          const dir = join(runsDir, group, `${agentId}-${ts}`);
          // Swallow sites (legacy): each artefact is independently tolerated-missing.
          const summary = yield* readJson(join(dir, "summary.json"));
          const output = yield* fs.readFileString(join(dir, "output.txt")).pipe(Effect.option);
          const events = yield* fs.readFileString(join(dir, "events.jsonl")).pipe(
            Effect.map((content) => {
              const parsed: Record<string, unknown>[] = [];
              // A malformed line stops the scan but keeps lines parsed so far (legacy behaviour).
              try {
                for (const line of content.split("\n")) {
                  if (line.trim()) parsed.push(JSON.parse(line) as Record<string, unknown>);
                }
              } catch {
                /* keep what parsed */
              }
              return parsed;
            }),
            Effect.orElseSucceed(() => []),
          );
          return { summary, output, events };
        }),

      systemOverview: () =>
        Effect.gen(function* () {
          // Swallow site (legacy): unreachable Zipkin or a non-array services body → [].
          const services = Option.getOrNull(yield* getJson(`${zipkinUrl}/api/v2/services`));
          const recentRuns = yield* runsList({ limit: 10 });
          return { services: Array.isArray(services) ? (services as string[]) : [], recentRuns };
        }),
    };
  }),
);
