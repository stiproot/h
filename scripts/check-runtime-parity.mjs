#!/usr/bin/env node
// Runtime-parity guard — fail LOUDLY when execution semantics shared by h's two execution
// substrates grow a SECOND implementation.
//
// h composes work one way (template ⊕ overlay → workflow definition) and executes it two ways: the
// durable Dapr engine in workflow-svc, and the direct in-process runner. A definition composed by
// `h` must mean the same thing to both — same `{{token}}` / `$ref` resolution, same output-contract
// validation, same step shapes, same run ledger.
//
// That symmetry is not a review habit. If either substrate copies one of these functions instead of
// importing it, the copies drift — and they drift SILENTLY, because both sides keep passing their
// own tests. What breaks is agreement between them: a `$ref` that resolves on one substrate and not
// the other, a contract enforced in one place and waved through in the other. So each shared
// concern names ONE owning package, and defining its symbols anywhere else is an error here.
//
// Re-exporting is fine and expected (`workflow.model.ts` re-exports the definition shapes;
// `agent-server` re-exports the ledger) — a re-export has no second implementation to drift. Only a
// DEFINITION outside the owner is a violation.
//
// The substrates and what does/does not transfer between them: CLAUDE.md, "Execution substrates".
// The rule this encodes: the *Harden by encoding* principle in ARCHITECTURE.md. Wired into
// `bun run lint`. No skip flag.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each shared concern: the one package that owns it, and the symbols nobody else may define. */
export const owned = [
  {
    owner: "packages/js/workflow-core/src",
    concern: "workflow execution semantics",
    symbols: [
      // Cross-step reference resolution — what a definition's tokens MEAN.
      "resolveRefs",
      "resolveTokenString",
      // The structured-output contract — whether a step's answer is accepted.
      "applyOutputContract",
      "parseStructuredOutput",
      "lastFencedJson",
      "contractViolations",
      "unsupportedContractKeywords",
      "StructuredOutputError",
      // The definition shapes both executors read.
      "StepDefinition",
      "ParallelGroup",
      "WorkflowStep",
      "WorkflowParams",
      // Chain threading and stage arithmetic — how members group into stages, and how state
      // moves between them. (The chain ENGINE stays substrate-side: it is a per-tick state
      // machine over a durable row, which only the service substrate has.)
      "contractFor",
      "loopIsClean",
      "stepStructured",
      "MEMBER_KINDS",
      "ChainThreadError",
      "stageOf",
      "stagesOf",
      "membersInStage",
      "lastStage",
      "validateStages",
    ],
  },
  {
    owner: "packages/js/run-ledger/src",
    concern: "the run ledger",
    symbols: ["startRunLedgerEffect", "recordActivityEffect", "RunLedgerLive", "RunLedgerError"],
  },
];

const SOURCE_ROOTS = ["apps", "packages/js"];

/** Every non-test .ts under a package's src/, skipping build output. */
function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(child, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(child);
  }
  return out;
}

function scannedFiles(repositoryRoot = root) {
  const files = [];
  for (const parent of SOURCE_ROOTS) {
    const parentPath = resolve(repositoryRoot, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(parentPath, entry.name, "src");
      if (existsSync(src) && statSync(src).isDirectory()) sourceFiles(src, files);
    }
  }
  return files;
}

/** A top-level definition of `symbol` — `export const X`, `export function X`, `class X`, … */
const definitionPattern = (symbol) =>
  new RegExp(
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|var|class|type|interface|enum)\\s+${symbol}\\b`,
  );

/**
 * Blank out import statements, keeping line numbers intact.
 *
 * Without this, a multi-line `import { type WorkflowStep, … }` reads as a `type WorkflowStep`
 * DEFINITION — flagging the very files that are correctly importing the shared symbol, which is
 * the exact opposite of what this guard is for.
 */
function withoutImports(lines) {
  let inImport = false;
  return lines.map((line) => {
    const starting = !inImport && /^\s*import\b/.test(line);
    if (!starting && !inImport) return line;
    // The statement ends on the line carrying its module specifier (or a bare side-effect import).
    inImport = !/from\s*["'][^"']+["']|^\s*import\s*["']/.test(line);
    return "";
  });
}

export function findViolations(path, contents, repositoryRoot = root) {
  const relativePath = relative(repositoryRoot, path);
  const violations = [];
  const lines = withoutImports(contents.split(/\r?\n/));
  for (const { owner, concern, symbols } of owned) {
    if (relativePath.startsWith(owner)) continue;
    for (const symbol of symbols) {
      const pattern = definitionPattern(symbol);
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        violations.push(
          `${relativePath}:${index + 1}: defines '${symbol}', which ${owner} owns ` +
            `(${concern}). Import it instead — a second implementation drifts from the other ` +
            "execution substrate silently, because both sides keep passing their own tests.",
        );
      });
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = scannedFiles();
  const violations = files.flatMap((path) => findViolations(path, readFileSync(path, "utf8")));

  // The owners must actually exist: a rename that silently emptied this guard would leave every
  // check passing while checking nothing.
  for (const { owner } of owned) {
    if (!existsSync(resolve(root, owner))) {
      violations.push(`missing owner package '${owner}' — this guard is checking nothing.`);
    }
  }

  if (violations.length > 0) {
    console.error("✗ check-runtime-parity: shared execution semantics defined outside their owner.\n");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(
    `✓ check-runtime-parity: shared execution semantics have one implementation ` +
      `(${owned.length} owned concerns, ${files.length} source files scanned)`,
  );
}
