/**
 * Hexagonal-architecture boundary rules, enforced across every TypeScript service.
 *
 * The layout is the contract: `src/domain` (the pure core + its ports), `src/infrastructure`
 * (outbound adapters), `src/presentation` (inbound adapters), and `src/index.ts` (the sole
 * composition root that wires them). These rules make that contract machine-checked.
 *
 * Run per-package (`depcruise src` from an app dir) so it stays turbo-native and cached; the
 * config is discovered by walking up to the repo root. The path regexes are anchored on
 * `(^|/)src/<layer>/` so they fire inside whichever app is being cruised and no-op in the thin
 * agents that have no `domain/` yet.
 */

/** Workspace packages whose whole job is I/O — the domain must reach these only through a port. */
const IO_PACKAGES = "core-dapr|core-vercel|git-core";
/** External runtime/I-O libs the pure core must never import directly. */
const IO_LIBS = "fastify|@dapr/dapr|ioredis|redis|undici|axios|node-fetch";

module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment:
        "domain/ is the pure core: it must not import infrastructure/ or presentation/. " +
        "Depend on a port (an interface in domain/ports) and let the composition root inject the adapter.",
      severity: "error",
      from: { path: "(^|/)src/domain/" },
      to: { path: "(^|/)src/(infrastructure|presentation)/" },
    },
    {
      name: "domain-no-io-libs",
      comment:
        "domain/ must not import runtime/I-O dependencies. Model the boundary as a port; " +
        "the concrete driver lives in infrastructure/ and is wired at the composition root.",
      severity: "error",
      from: { path: "(^|/)src/domain/" },
      to: { path: `node_modules/(${IO_LIBS}|${IO_PACKAGES})(/|$)` },
    },
    {
      name: "presentation-not-infrastructure",
      comment:
        "presentation/ (inbound adapters) talks to domain ports, never to concrete infrastructure/. " +
        "The composition root injects the adapter behind the port.",
      severity: "error",
      from: { path: "(^|/)src/presentation/" },
      to: { path: "(^|/)src/infrastructure/" },
    },
    {
      name: "infrastructure-not-presentation",
      comment: "infrastructure/ (outbound adapters) must not depend on presentation/ (inbound adapters).",
      severity: "error",
      from: { path: "(^|/)src/infrastructure/" },
      to: { path: "(^|/)src/presentation/" },
    },
    {
      name: "no-circular",
      comment: "A dependency cycle crosses a boundary that should be one-directional.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    // Ports are all `import type` — analyse type-only edges too, or a type-import of an
    // adapter/IO-lib would slip past the boundary.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
  },
};
