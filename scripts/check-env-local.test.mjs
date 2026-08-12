import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentTypeOf,
  collectProblems,
  hardRequiredKeysIn,
  mergeEnv,
  parseEnvText,
} from "./check-env-local.mjs";

// --- the unbound-variable scan ------------------------------------------------------------------

// The real trap, straight out of run-workflow-agent.sh: no `:-`, so `set -u` kills the script.
test("flags a bare ${VAR} in a set -u script", () => {
  const body = 'set -euo pipefail\nexport ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}"\n';
  assert.deepEqual(hardRequiredKeysIn(body), ["ANTHROPIC_BASE_URL"]);
});

test("a default, an error-default, or an alternate makes it safe", () => {
  const body = [
    "set -euo pipefail",
    'export A="${A:-fallback}"',
    'export B="${B:?must be set}"',
    'export C="${C:+something}"',
    'export D="${D#prefix}"',
  ].join("\n");
  assert.deepEqual(hardRequiredKeysIn(body), []);
});

test("a variable the script assigns itself first is not required from the env", () => {
  const body = 'set -euo pipefail\nPROJECT_DIR=/tmp/x\ncd "${PROJECT_DIR}"\n';
  assert.deepEqual(hardRequiredKeysIn(body), []);
});

// Ordering is load-bearing: an assignment BELOW the reference does not save it under set -u.
test("an assignment after the reference does not excuse it", () => {
  const body = 'set -euo pipefail\necho "${LATER}"\nLATER=x\n';
  assert.deepEqual(hardRequiredKeysIn(body), ["LATER"]);
});

test("ambient shell names are never demanded from .env", () => {
  const body = 'set -euo pipefail\ncd "${HOME}"\necho "${PATH}"\n';
  assert.deepEqual(hardRequiredKeysIn(body), []);
});

test("a script without set -u has no unbound hazard at all", () => {
  assert.deepEqual(hardRequiredKeysIn('echo "${WHATEVER}"\n'), []);
});

test("commented-out references are not requirements", () => {
  const body = 'set -euo pipefail\n# echo "${OLD_KEY}"\n';
  assert.deepEqual(hardRequiredKeysIn(body), []);
});

// --- env layering --------------------------------------------------------------------------------

test(".env wins over an exported shell value, mirroring `set -a; source .env`", () => {
  const { usable } = mergeEnv({ K: "from-shell" }, { K: "from-file" });
  assert.equal(usable.K, "from-file");
});

// The distinction that produced a false positive on the first run of this guard.
test("a bare KEY= line is DECLARED (satisfies set -u) but not USABLE (no credential)", () => {
  const { declared, usable } = mergeEnv({}, parseEnvText("KEY=\n"));
  assert.ok(declared.has("KEY"));
  assert.equal(usable.KEY, undefined);
});

test("an empty .env assignment blanks an exported value rather than deferring to it", () => {
  const { usable } = mergeEnv({ K: "from-shell" }, { K: "" });
  assert.equal(usable.K, undefined);
});

test("parseEnvText strips quotes, honours export, and skips comments", () => {
  const parsed = parseEnvText(['# a comment', 'export A="quoted"', "B='single'", "C=bare", "junk"].join("\n"));
  assert.deepEqual(parsed, { A: "quoted", B: "single", C: "bare" });
});

// --- severities ------------------------------------------------------------------------------------

const stubStrategies = {
  codex: { validateEnvironment: (_effective, env) => (env.OPENAI_API_KEY ? null : { stdout: "needs a key" }) },
};

test("a missing hard-required key is an ERROR — the stack cannot come up", () => {
  const { errors, warnings } = collectProblems({
    services: ["run-workflow-agent.sh"],
    readScript: () => 'set -euo pipefail\necho "${NEEDED}"\n',
    declared: new Set(),
    usable: {},
    strategies: null,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0].why, /NEEDED/);
  assert.equal(warnings.length, 0);
});

// Missing auth must NOT block a bring-up: the service starts fine, only its runs fail.
test("missing agent auth is a WARNING, not an error", () => {
  const { errors, warnings } = collectProblems({
    services: ["run-codex-agent.sh"],
    readScript: () => "set -euo pipefail\n",
    declared: new Set(),
    usable: {},
    strategies: stubStrategies,
  });
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].why, /will start; its runs will fail/);
});

test("satisfied auth reports nothing", () => {
  const { errors, warnings } = collectProblems({
    services: ["run-codex-agent.sh"],
    readScript: () => "set -euo pipefail\n",
    declared: new Set(),
    usable: { OPENAI_API_KEY: "sk-test" },
    strategies: stubStrategies,
  });
  assert.deepEqual([errors, warnings], [[], []]);
});

test("non-agent services are not asked for agent auth", () => {
  assert.equal(agentTypeOf("run-workflow-svc.sh"), null);
  assert.equal(agentTypeOf("run-codex-agent.sh"), "codex");
});
