/**
 * engine-core's own boundary rule, layered on the repo-wide hexagonal ones.
 *
 * The repo config guards `src/domain/` inside a SERVICE. This package has no `domain/` directory
 * because it is domain all the way down — rows, ports, the pure `decide` per primitive, and the
 * per-tick scans — so the same invariant needs its own rule here.
 *
 * Why it matters more here than anywhere else: every host imports this package. One I/O dependency
 * in it would pin the watcher, the chain, the cron, the discover and the sched engines to whichever
 * substrate that dependency belongs to, which is precisely the coupling extracting them removed.
 * The boundary is a port in `src/ports`; the host injects the adapter.
 *
 * The `from` pattern is anchored on `(^|/)src/` rather than the package's repo path because
 * depcruise runs from THIS directory, so module sources are package-relative — see
 * scripts/dep-io-patterns.cjs for that trap and the two bugs it caused.
 */

const { IO_PATH } = require("../../../scripts/dep-io-patterns.cjs");
const base = require("../../../.dependency-cruiser.cjs");

module.exports = {
  ...base,
  forbidden: [
    ...base.forbidden,
    {
      name: "engine-core-is-pure",
      comment:
        "engine-core is imported by every host, so an I/O dependency here pins all of them to one " +
        "substrate. Model the boundary as a port in src/ports and let each host inject its adapter.",
      severity: "error",
      from: { path: "(^|/)src/" },
      to: { path: IO_PATH },
    },
  ],
};
