/**
 * The path patterns that identify an I/O dependency, shared by the root dependency-cruiser config
 * and the per-package ones that extend it.
 *
 * They live in their own module for one reason: a boundary rule is only as good as its path
 * pattern, and these have been wrong twice in the same way. Keeping one definition means a fix
 * lands everywhere at once instead of in whichever config someone remembered.
 *
 * **A dependency's resolved path depends on where depcruise was RUN**, and a workspace package
 * resolves THROUGH its symlink rather than staying under `node_modules/`. All three of these are
 * the same import of the same package:
 *
 *  | cruised from            | `core-dapr` resolves to                       |
 *  | ----------------------- | --------------------------------------------- |
 *  | `apps/workflow-svc`     | `../../packages/js/core-dapr/dist/index.d.ts`  |
 *  | `packages/js/engine-core` | `../core-dapr/dist/index.d.ts`              |
 *  | anywhere, undeclared    | `core-dapr` (bare — enhanced-resolve gave up)  |
 *
 * A pattern anchored on `node_modules/` matches none of them; one anchored on `packages/js/`
 * matches only the first. So match the package NAME AS A PATH SEGMENT, prefix-agnostic, plus the
 * bare form. (Found 2026-08-16, twice: `src/domain/` had been importing `core-dapr` for as long as
 * the import existed under a rule that forbids exactly that, and the first attempted fix passed
 * clean against a deliberately planted violation.)
 *
 * The `from` side has its own version of the trap: each package runs `depcruise … src` from its OWN
 * directory, so module sources are package-relative (`src/foo.ts`), never repo-relative. A `from`
 * written as `packages/js/<pkg>/src/` matches nothing, cruises every file, and reports no
 * violations — indistinguishable from passing. Anchor `from` on `(^|/)src/…`.
 *
 * The lesson worth keeping: **plant a violation and watch the rule fail before trusting it.** Every
 * bug above produced a green run.
 */

/** Workspace packages whose whole job is I/O — a pure core must reach these only through a port. */
const IO_PACKAGES = "core-dapr|core-vercel|git-core";

/** External runtime/I-O libs a pure core must never import directly. */
const IO_LIBS = "fastify|@dapr/dapr|ioredis|redis|undici|axios|node-fetch";

/**
 * Matches an I/O dependency however it resolved. Use as a dependency-cruiser `to.path`.
 * `(^|/)<name>(/|$)` catches every row of the table above; the trailing `$` covers the bare form.
 */
const IO_PATH = `((^|/)(${IO_LIBS})(/|$)|(^|/)(${IO_PACKAGES})(/|$))`;

module.exports = { IO_PACKAGES, IO_LIBS, IO_PATH };
